import {
  Module, Injectable, Controller,
  Get, Post, Delete,
  Body, Query, Req, Param,
  HttpCode, HttpStatus,
  UseGuards, ParseUUIDPipe,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AdminJwtGuard, PermissionGuard } from '../../common/guards';
import { successResponse } from '../../common/utils/response.util';
import { AuthModule } from '../auth/auth.module';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/moderation/moderation.module.ts
//
// UGC moderation — reporting, blocking, and the admin queue.
//
// Google Play's User Generated Content policy requires an app whose users
// can see each other's content to provide, in-app: a way to report content
// or a user, a way to block a user, and evidence that reports are actually
// moderated. This module is all three halves — the user-facing endpoints
// here, the admin queue below, and `blockedIds()` which the UGC feeds call
// to enforce a block on read.
//
// Blocking is one-directional and silent by design: the blocked user is
// never told, and the block only ever filters what the BLOCKER sees. A
// symmetric block would leak the fact that it happened, which is exactly
// what someone blocking a harasser does not want.
// ════════════════════════════════════════════════════════════

// Kept in lockstep with the app's report sheet. Anything else is rejected so
// the column can't accumulate arbitrary client strings and the admin queue's
// filter list stays finite.
const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'copyright',
  'misinformation',
  'personal_info',
  'other',
];

// Every surface where one user can see another's content.
const CONTENT_TYPES = ['room_message', 'peer_review', 'answer', 'study_material', 'user'];

// Where to find the author of each reportable thing. Used both to stamp
// reported_user_id at report time and to hide the row when a moderator acts.
const AUTHOR_LOOKUP: Record<string, { table: string; column: string } | null> = {
  room_message:   { table: 'room_messages',       column: 'sender_id' },
  peer_review:    { table: 'answer_peer_reviews',  column: 'reviewer_id' },
  answer:         { table: 'answer_submissions',   column: 'user_id' },
  study_material: { table: 'study_materials',      column: 'uploader_id' },
  user:           null, // content_id IS the user id
};

// Only these two carry a reversible hidden_at (added by the UgcModeration
// migration). A study_material is taken down through its existing
// pending/approved/rejected status instead, and an 'answer' has no
// moderation flag of its own — banning the author is the lever there.
const HIDEABLE: Record<string, string> = {
  room_message: 'room_messages',
  peer_review:  'answer_peer_reviews',
};

@Injectable()
export class ModerationService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // ── Blocks ─────────────────────────────────────────────────

  /**
   * Ids this user has blocked.
   *
   * Every UGC read path calls this and filters the result out. Returning a
   * plain array (not a subquery) keeps the callers' SQL readable and lets
   * them skip the filter entirely in the common case of an empty list.
   */
  async blockedIds(userId: string): Promise<string[]> {
    const rows = await this.db.query(
      `SELECT blocked_id FROM user_blocks WHERE blocker_id = $1`,
      [userId]
    );
    return rows.map((r: any) => r.blocked_id);
  }

  async block(userId: string, targetId: string) {
    if (userId === targetId) {
      throw new BadRequestException('You cannot block yourself');
    }
    const [target] = await this.db.query(
      `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [targetId]
    );
    if (!target) throw new NotFoundException('User not found');

    // Idempotent: blocking twice is a no-op, not a 409. The app fires this
    // from a menu that may be tapped twice.
    await this.db.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [userId, targetId]
    );
    return successResponse({ blocked: true });
  }

  async unblock(userId: string, targetId: string) {
    await this.db.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [userId, targetId]
    );
    return successResponse({ blocked: false });
  }

  async listBlocks(userId: string) {
    const blocks = await this.db.query(
      `SELECT b.blocked_id AS id,
              COALESCE(u.name, 'Deleted user') AS name,
              u.avatar_url,
              b.created_at
         FROM user_blocks b
         LEFT JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC`,
      [userId]
    );
    return successResponse({ blocks });
  }

  // ── Reports ────────────────────────────────────────────────

  async report(
    userId: string,
    dto: { contentType: string; contentId: string; reason: string; details?: string },
  ) {
    const contentType = String(dto?.contentType || '').trim();
    const contentId   = String(dto?.contentId   || '').trim();
    const reason      = String(dto?.reason      || '').trim();

    if (!CONTENT_TYPES.includes(contentType)) {
      throw new BadRequestException('Unknown content type');
    }
    if (!REPORT_REASONS.includes(reason)) {
      throw new BadRequestException('Unknown report reason');
    }
    if (!contentId) throw new BadRequestException('contentId is required');

    // Resolve the author so the admin queue can act on a person directly.
    // A missing row is not fatal — the content may have been deleted between
    // the user seeing it and reporting it, and the report is still evidence.
    let reportedUserId: string | null = null;
    const lookup = AUTHOR_LOOKUP[contentType];
    if (lookup === null) {
      reportedUserId = contentId;
    } else if (lookup) {
      const [row] = await this.db.query(
        `SELECT ${lookup.column} AS author FROM ${lookup.table} WHERE id = $1`,
        [contentId]
      );
      reportedUserId = row?.author ?? null;
    }

    if (reportedUserId && reportedUserId === userId) {
      throw new BadRequestException('You cannot report your own content');
    }

    // Re-reporting the same item replaces the reason rather than 409ing, and
    // reopens it if a moderator had already closed it — a second complaint
    // about content that was dismissed deserves another look.
    await this.db.query(
      `INSERT INTO content_reports
         (reporter_id, content_type, content_id, reported_user_id, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reporter_id, content_type, content_id)
       DO UPDATE SET reason     = EXCLUDED.reason,
                     details    = EXCLUDED.details,
                     status     = 'pending',
                     created_at = NOW()`,
      [userId, contentType, contentId, reportedUserId, reason, dto?.details?.slice(0, 2000) || null]
    );

    return successResponse({
      reported: true,
      message: 'Thanks — our team will review this within 24 hours.',
    });
  }

  // ── Admin queue ────────────────────────────────────────────

  async adminList(status = 'pending', limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const params: any[] = [];
    let where = '';
    if (status && status !== 'all') {
      params.push(status);
      where = `WHERE r.status = $1`;
    }
    const reports = await this.db.query(
      `SELECT r.id, r.content_type, r.content_id, r.reason, r.details,
              r.status, r.action_taken, r.created_at, r.reviewed_at,
              reporter.name AS reporter_name,
              target.id     AS reported_user_id,
              target.name   AS reported_user_name,
              target.status AS reported_user_status,
              (SELECT COUNT(*) FROM content_reports o
                WHERE o.reported_user_id = r.reported_user_id) AS reports_against_user
         FROM content_reports r
         LEFT JOIN users reporter ON reporter.id = r.reporter_id
         LEFT JOIN users target   ON target.id   = r.reported_user_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT ${safeLimit}`,
      params
    );

    // Pull the reported text itself so a moderator can judge without
    // querying by hand. One extra round trip per report is fine at queue
    // sizes; this list is capped and admin-only.
    for (const r of reports) {
      r.content_preview = await this.preview(r.content_type, r.content_id);
    }

    const [counts] = await this.db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
              COUNT(*) FILTER (WHERE status = 'actioned')  AS actioned,
              COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed
         FROM content_reports`
    );

    return successResponse({ reports, counts });
  }

  private async preview(contentType: string, contentId: string): Promise<string | null> {
    try {
      if (contentType === 'room_message') {
        const [m] = await this.db.query(`SELECT message FROM room_messages WHERE id = $1`, [contentId]);
        return m?.message ?? null;
      }
      if (contentType === 'peer_review') {
        const [m] = await this.db.query(`SELECT suggestion FROM answer_peer_reviews WHERE id = $1`, [contentId]);
        return m?.suggestion ?? null;
      }
      if (contentType === 'answer') {
        const [m] = await this.db.query(`SELECT answer_text FROM answer_submissions WHERE id = $1`, [contentId]);
        return m?.answer_text?.slice(0, 1000) ?? null;
      }
      if (contentType === 'study_material') {
        const [m] = await this.db.query(`SELECT title FROM study_materials WHERE id = $1`, [contentId]);
        return m?.title ?? null;
      }
      return null;
    } catch {
      // A preview is a convenience — never let a schema drift on one content
      // type take down the whole queue.
      return null;
    }
  }

  /**
   * Resolve a report.
   *
   * `hide` takes the content down, `ban` suspends the author (the JwtAuthGuard
   * already refuses a banned user), `dismiss` closes it untouched. Hiding and
   * banning are separable because most actionable reports warrant one but not
   * the other.
   */
  async adminAction(
    adminId: string,
    reportId: string,
    action: 'hide' | 'unhide' | 'ban' | 'dismiss',
  ) {
    const [report] = await this.db.query(
      `SELECT * FROM content_reports WHERE id = $1`,
      [reportId]
    );
    if (!report) throw new NotFoundException('Report not found');

    if (action === 'hide' || action === 'unhide') {
      const table = HIDEABLE[report.content_type];
      if (table) {
        await this.db.query(
          `UPDATE ${table} SET hidden_at = ${action === 'hide' ? 'NOW()' : 'NULL'} WHERE id = $1`,
          [report.content_id]
        );
      } else if (report.content_type === 'study_material') {
        // Reuses the existing upload-review status rather than adding a
        // second take-down flag, so a removed material disappears from every
        // listing that already filters on status = 'approved'.
        await this.db.query(
          `UPDATE study_materials
              SET status           = $2,
                  rejection_reason = $3
            WHERE id = $1`,
          [
            report.content_id,
            action === 'hide' ? 'rejected' : 'approved',
            action === 'hide' ? 'Removed following a user report' : null,
          ]
        );
      } else {
        throw new BadRequestException(`Cannot hide content of type ${report.content_type}`);
      }
    }

    if (action === 'ban') {
      if (!report.reported_user_id) {
        throw new BadRequestException('This report has no resolvable author to ban');
      }
      await this.db.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [report.reported_user_id]);
    }

    await this.db.query(
      `UPDATE content_reports
          SET status       = $2,
              action_taken = $3,
              reviewed_by  = $4,
              reviewed_at  = NOW()
        WHERE id = $1`,
      [reportId, action === 'dismiss' ? 'dismissed' : 'actioned', action, adminId]
    );

    return successResponse({ id: reportId, action });
  }
}

// ── User-facing ───────────────────────────────────────────────
@ApiTags('Moderation')
@ApiBearerAuth()
@Controller('moderation')
export class ModerationController {
  constructor(private readonly svc: ModerationService) {}

  @Post('report')
  @HttpCode(HttpStatus.OK)
  report(@Req() r: any, @Body() dto: any) {
    return this.svc.report(r.user.id, dto);
  }

  @Get('blocks')
  listBlocks(@Req() r: any) {
    return this.svc.listBlocks(r.user.id);
  }

  @Post('block/:userId')
  @HttpCode(HttpStatus.OK)
  block(@Req() r: any, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.block(r.user.id, userId);
  }

  @Delete('block/:userId')
  @HttpCode(HttpStatus.OK)
  unblock(@Req() r: any, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.unblock(r.user.id, userId);
  }
}

// ── Admin queue ───────────────────────────────────────────────
@ApiTags('Admin — Moderation')
@ApiBearerAuth()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/moderation')
export class AdminModerationController {
  constructor(private readonly svc: ModerationService) {}

  @Get('reports')
  list(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.svc.adminList(status || 'pending', Number(limit) || 100);
  }

  @Post('reports/:id/action')
  @HttpCode(HttpStatus.OK)
  action(@Req() r: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    const action = String(dto?.action || '');
    if (!['hide', 'unhide', 'ban', 'dismiss'].includes(action)) {
      throw new BadRequestException('action must be hide, unhide, ban or dismiss');
    }
    return this.svc.adminAction(r.admin.id, id, action as any);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ModerationController, AdminModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
