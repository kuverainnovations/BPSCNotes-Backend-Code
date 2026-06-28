import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException,
  UseGuards, ParseUUIDPipe,
  Patch, Logger, OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ScheduleModule } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject, Optional } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule, AuthService } from './auth/auth.module';
import { NotificationsModule, NotificationService } from './combined-modules-1.module';
// Phase 2 achievements + challenges — imported here to wire into
// DailyTargets and Quizzes so completions trigger achievement checks
import { AchievementsService, WeeklyChallengesService } from './achievements/achievements.module';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../common/guards';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage }     from 'multer';
import { extname, join }   from 'path';
import * as fs             from 'fs';
import { generateCertificatePdf } from '../common/utils/certificate-generator.util';
import * as crypto         from 'crypto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../common/utils/response.util';

import {
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';

// ════════════════════════════════════════════════════════════
// STUDY ROOMS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class StudyRoomsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly authService: AuthService,
  ) {}

  async findAll(query: any, userId: string) {
    const { subject, exam } = query;
    const conditions = [`sr.status='active'`], params: any[] = [];
    if (subject) { conditions.push(`sr.subject=$${params.length+1}`); params.push(subject); }
    if (exam)    { conditions.push(`$${params.length+1}=ANY(sr.exam_tags)`); params.push(exam); }
    const rows = await this.db.query(
      `SELECT sr.*, COALESCE(u.name, 'BPSCNotes') AS host_name,
         COUNT(rm.user_id) FILTER (WHERE rm.left_at IS NULL) AS current_members,
         (SELECT TRUE FROM room_members WHERE room_id=sr.id AND user_id=$${params.length+1} AND left_at IS NULL) AS is_member
       FROM study_rooms sr LEFT JOIN users u ON sr.host_id=u.id
       LEFT JOIN room_members rm ON sr.id=rm.room_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY sr.id, u.name ORDER BY sr.created_at DESC`,
      [...params, userId]
    );
    return successResponse({ rooms: rows });
  }

  async create(data: any, userId: string) {
    if (!data.name || !data.subject) throw new BadRequestException('Name and subject required');
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const result   = await this.db.query(
      `INSERT INTO study_rooms (name, subject, host_id, max_members, is_private, join_code, exam_tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [data.name, data.subject, userId, data.maxMembers||20, data.isPrivate||false, joinCode, data.examTags||[]]
    );
    const room = result[0];
    await this.db.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)`, [room.id, userId]);
    await this.authService.awardCoins(userId, 'study_room', room.id);
    return successResponse({ room }, 'Study room created!');
  }

  /**
   * Admin creates a room — host_id is NULL because admins are not in the users table.
   * The room is marked as featured and official so it shows prominently in the app.
   */
  async createByAdmin(data: any) {
    if (!data.name || !data.subject) throw new BadRequestException('Name and subject required');
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const result   = await this.db.query(
      `INSERT INTO study_rooms
         (name, subject, host_id, max_members, is_private, join_code, exam_tags, status)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, 'active')
       RETURNING *`,
      [
        data.name,
        data.subject,
        data.maxMembers   || 100,
        data.isPrivate    || false,
        joinCode,
        data.examTags     || [],
      ]
    );
    return successResponse({ room: result[0] }, 'Study room created!');
  }

  async join(roomId: string, userId: string, joinCode?: string) {
    const room = await this.db.query(`SELECT * FROM study_rooms WHERE id=$1 AND status='active'`, [roomId]);
    if (!room.length) throw new NotFoundException('Room not found or ended');
    const r = room[0];
    if (r.is_private && r.join_code !== joinCode) throw new ForbiddenException('Invalid room code');
    const memberCount = await this.db.query(`SELECT COUNT(*) FROM room_members WHERE room_id=$1 AND left_at IS NULL`, [roomId]);
    if (parseInt(memberCount[0].count) >= r.max_members) throw new BadRequestException('Room is full');
    await this.db.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT (room_id, user_id) DO UPDATE SET left_at=NULL, joined_at=NOW()`,
      [roomId, userId]
    );
    await this.authService.awardCoins(userId, 'study_room', roomId);
    return successResponse({ room: r }, 'Joined study room!');
  }

  async leave(roomId: string, userId: string) {
    await this.db.query(`UPDATE room_members SET left_at=NOW() WHERE room_id=$1 AND user_id=$2`, [roomId, userId]);
    return successResponse(null, 'Left the room');
  }

  async findAllAdmin() {
    const rows = await this.db.query(
      `SELECT sr.*, COALESCE(u.name, 'BPSCNotes') AS host_name,
         COUNT(rm.user_id) FILTER (WHERE rm.left_at IS NULL) AS current_members
       FROM study_rooms sr LEFT JOIN users u ON sr.host_id=u.id
       LEFT JOIN room_members rm ON sr.id=rm.room_id
       GROUP BY sr.id, u.name ORDER BY sr.created_at DESC`
    );
    return successResponse({ rooms: rows });
  }

  async endRoom(roomId: string) {
    await this.db.query(`UPDATE study_rooms SET status='ended', ended_at=NOW(), updated_at=NOW() WHERE id=$1`, [roomId]);
    return successResponse(null, 'Room ended');
  }
}

@ApiTags('Study Rooms') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('study-rooms')
class StudyRoomsController {
  constructor(private s: StudyRoomsService) {}
  @Get()      findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }
  @Post()     @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.user.id); }
  @Post(':id/join')  @HttpCode(200) join(@Param('id', ParseUUIDPipe) id: string, @Req() r: any, @Body() b: any) { return this.s.join(id, r.user.id, b.joinCode); }
  @Post(':id/leave') @HttpCode(200) leave(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.leave(id, r.user.id); }
}

// @ApiTags('Admin — Study Rooms') @ApiBearerAuth()
// @UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/study-rooms')
// class AdminStudyRoomsController {
//   constructor(private s: StudyRoomsService) {}
//   @Get()         @RequirePermission('study-rooms') findAll()  { return this.s.findAllAdmin(); }
//   @Put(':id/end') @RequirePermission('study-rooms') end(@Param('id', ParseUUIDPipe) id: string) { return this.s.endRoom(id); }
//   @Post()
//   @RequirePermission('study-rooms')
//   @HttpCode(201)
//   create(@Body() dto: any, @Req() r: any) {
//     return this.s.createByAdmin(dto);
//   }
// }

@ApiTags('Admin — Study Rooms')
@ApiBearerAuth()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/study-rooms')
class AdminStudyRoomsController {
  constructor(private s: StudyRoomsService) {}

  @Get()
  @RequirePermission('study-rooms')
  findAll() {
    return this.s.findAllAdmin();
  }

  @Post()
  @RequirePermission('study-rooms')
  @HttpCode(201)
  create(@Body() dto: any) {
    return this.s.createByAdmin(dto);
  }

  @Put(':id/end')
  @RequirePermission('study-rooms')
  end(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.endRoom(id);
  }
}

@Module({ imports:[AuthModule], controllers:[StudyRoomsController, AdminStudyRoomsController], providers:[StudyRoomsService] })
export class StudyRoomsModule {}

// ════════════════════════════════════════════════════════════
// DAILY TARGETS SERVICE
// Handles:
//   GET  /users/daily-targets          — fetch today's targets
//   POST /users/daily-targets          — create a custom target
//   PATCH /users/daily-targets/:id/complete — mark complete/incomplete
//   DELETE /users/daily-targets/:id    — delete a target
//
// Design decisions:
//   1. Targets are per-user per-day (target_date = today by default)
//   2. Uncompleted targets from previous days are automatically
//      "carried forward" and shown alongside today's targets
//   3. Creating a target awards coins via the existing coin system
// ════════════════════════════════════════════════════════════
@Injectable()
class DailyTargetsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly achievementsService: AchievementsService,
    private readonly challengesService: WeeklyChallengesService,
    private readonly authService: AuthService,
    @Inject('NOTIFICATION_SERVICE') @Optional() private readonly notifService?: {
      pushToUser: (userId: string, title: string, body: string, data?: Record<string, string>) => Promise<boolean>;
    },
  ) {}

  // ── GET /users/daily-targets ──────────────────────────────
  // Returns:
  //   • today's targets  (target_date = CURRENT_DATE)
  //   • carried-forward targets (incomplete targets from prev days)
  async getTargets(userId: string) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Only run carry-forward if there are actually incomplete past targets.
    // This pre-check avoids a write query on every Dashboard open when there
    // is nothing to carry forward (the common case after the first load of day).
    const [pendingCount] = await this.db.query(
      `SELECT COUNT(*) FROM daily_targets
       WHERE user_id = $1
         AND is_completed = FALSE
         AND is_carried_forward = FALSE
         AND target_date >= ($2::date - INTERVAL '3 days')
         AND target_date < $2::date`,
      [userId, today]
    );

    if (parseInt(pendingCount.count) > 0) {
      await this.db.query(
        `INSERT INTO daily_targets
           (user_id, title, subject, difficulty, time_slot, estimated_minutes,
            total_questions, is_carried_forward, target_date, source_quiz_id, source_note_id)
         SELECT
           dt.user_id, dt.title, dt.subject, dt.difficulty, dt.time_slot,
           dt.estimated_minutes, dt.total_questions,
           TRUE, -- is_carried_forward
           $2::date, -- today
           dt.source_quiz_id, dt.source_note_id
         FROM daily_targets dt
         WHERE dt.user_id = $1
           AND dt.is_completed = FALSE
           AND dt.is_carried_forward = FALSE
           AND dt.target_date >= ($2::date - INTERVAL '3 days')
           AND dt.target_date < $2::date
           AND NOT EXISTS (
             SELECT 1 FROM daily_targets existing
             WHERE existing.user_id = dt.user_id
               AND existing.title = dt.title
               AND existing.target_date = $2::date
               AND existing.is_carried_forward = TRUE
           )`,
        [userId, today]
      );
    }

    // Fetch today's targets + carried-forward ones
    const rows = await this.db.query(
      `SELECT
         dt.id,
         dt.title,
         dt.subject,
         dt.difficulty,
         dt.time_slot,
         dt.estimated_minutes,
         dt.total_questions,
         dt.attempted_questions,
         dt.is_completed,
         dt.is_carried_forward,
         dt.target_date,
         dt.completed_at,
         q.title AS linked_quiz_title,
         q.id    AS linked_quiz_id,
         ln.title AS linked_note_title,
         ln.id    AS linked_note_id
       FROM daily_targets dt
       LEFT JOIN quizzes q        ON dt.source_quiz_id = q.id
       LEFT JOIN library_notes ln ON dt.source_note_id = ln.id
       WHERE dt.user_id = $1
         AND dt.target_date = $2::date
       ORDER BY
         dt.is_completed ASC,          -- incomplete first
         dt.is_carried_forward DESC,   -- carried forward before today's
         CASE dt.time_slot
           WHEN 'morning'   THEN 1
           WHEN 'afternoon' THEN 2
           WHEN 'night'     THEN 3
         END,
         dt.created_at ASC`,
      [userId, today]
    );

    const completed = rows.filter((r: any) => r.is_completed).length;
    const total     = rows.length;

    return successResponse({
      targets:   rows,
      summary: {
        total,
        completed,
        pending:          total - completed,
        completionPct:    total > 0 ? Math.round((completed / total) * 100) : 0,
        coinsAvailable:   total - completed,  // 1 coin per completed target
      },
    });
  }

  // ── GET /users/daily-targets/history ──────────────────────
  // Returns per-day summary for the last N days (default 30, max 90).
  // Each row: { date, total, completed, completion_pct }
  async getHistory(userId: string, days: number) {
    const rows = await this.db.query(
      `SELECT
         target_date::text                                          AS date,
         COUNT(*)                                                   AS total,
         COUNT(*) FILTER (WHERE is_completed = TRUE)               AS completed,
         ROUND(
           100.0 * COUNT(*) FILTER (WHERE is_completed = TRUE)
           / NULLIF(COUNT(*), 0)
         )::int                                                     AS completion_pct
       FROM daily_targets
       WHERE user_id = $1
         AND target_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
         AND target_date <= CURRENT_DATE
       GROUP BY target_date
       ORDER BY target_date DESC`,
      [userId, days]
    );
    return successResponse(rows, 'History loaded');
  }

  // ── GET /users/daily-targets/history/:date ────────────────
  async getHistoryByDate(userId: string, date: string) {
    const rows = await this.db.query(
      `SELECT
         id, title, subject, difficulty, time_slot, estimated_minutes,
         total_questions, is_completed, completed_at, coins_earned,
         target_date::text AS date
       FROM daily_targets
       WHERE user_id=$1
         AND target_date=$2::date
       ORDER BY is_completed ASC, created_at ASC`,
      [userId, date]
    );
    const total     = rows.length;
    const completed = rows.filter((r: any) => r.is_completed).length;
    return successResponse({
      date,
      targets: rows,
      summary: {
        total,
        completed,
        completion_pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    }, 'Targets for date loaded');
  }

  // ── POST /users/daily-targets ─────────────────────────────
  // Create one or more custom targets for today.
  // Body: { titles: string[] }  OR  { title: string, subject?, ... }
  async createTargets(userId: string, data: any) {
    const today = new Date().toISOString().split('T')[0];

    // Support both single object and batch array
    const inputs: any[] = Array.isArray(data.titles)
      ? data.titles.map((t: string) => ({ title: t }))
      : [data];

    if (!inputs.length || !inputs[0].title) {
      throw new BadRequestException('At least one target title is required');
    }

    // Max 10 targets per day
    const existing = await this.db.query(
      `SELECT COUNT(*) FROM daily_targets WHERE user_id=$1 AND target_date=$2::date`,
      [userId, today]
    );
    const currentCount = parseInt(existing[0].count);
    if (currentCount + inputs.length > 10) {
      throw new BadRequestException(
        `Cannot add ${inputs.length} target(s). Maximum 10 per day (${currentCount} already exist).`
      );
    }

    const created: any[] = [];
    for (const input of inputs) {
      if (!input.title?.trim()) continue;

      const result = await this.db.query(
        `INSERT INTO daily_targets
           (user_id, title, subject, difficulty, time_slot, estimated_minutes,
            total_questions, target_date, source_quiz_id, source_note_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
         RETURNING *`,
        [
          userId,
          input.title.trim(),
          input.subject     || 'General',
          input.difficulty  || 'medium',
          input.timeSlot    || 'morning',
          input.estimatedMinutes || 25,
          input.totalQuestions   || 10,
          today,
          input.sourceQuizId     || null,
          input.sourceNoteId     || null,
        ]
      );
      created.push(result[0]);
    }

    if (!created.length) throw new BadRequestException('No valid targets to create');

    // Award coin for creating a plan (once per day)
    const todayCreations = await this.db.query(
      `SELECT COUNT(*) FROM coin_transactions
       WHERE user_id=$1 AND action='daily_target_create' AND created_at::date=CURRENT_DATE`,
      [userId]
    );
    if (parseInt(todayCreations[0].count) === 0) {
      // Give 2 coins for creating a plan today (uses existing coin_rules system)
      const rule = await this.db.query(
        `SELECT coins_awarded FROM coin_rules WHERE action='daily_target_create' AND is_active=TRUE`
      );
      if (rule.length) {
        const coins = rule[0].coins_awarded;
        const balRows = await this.db.query(`UPDATE users SET coins=COALESCE(coins,0)+$1 WHERE id=$2 RETURNING coins`, [coins, userId]);
        const bal = balRows.length ? (Number(balRows[0].coins) || 0) : 0;
        await this.db.query(
          `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
           VALUES ($1,'earned',$2,'Daily target plan created','daily_target_create',$3)`,
          [userId, coins, bal]
        );
      }
    }

    return successResponse(
      { targets: created },
      `${created.length} target${created.length > 1 ? 's' : ''} created successfully!`
    );
  }

  // ── PATCH /users/daily-targets/:id/complete ───────────────
  // Toggle complete/incomplete and award coins on first completion
  async toggleComplete(targetId: string, userId: string) {
    const rows = await this.db.query(
      `SELECT * FROM daily_targets WHERE id=$1 AND user_id=$2`,
      [targetId, userId]
    );
    if (!rows.length) throw new NotFoundException('Target not found');

    const target     = rows[0];
    const nowComplete = !target.is_completed;

    // Anti-farming guard: a target can't be marked complete the instant
    // it's created - it must have existed for at least its own
    // estimated_minutes (default 25). Doesn't apply to uncompleting,
    // since that grants no reward.
    if (nowComplete) {
      const elapsedMs  = Date.now() - new Date(target.created_at).getTime();
      const requiredMs = (target.estimated_minutes ?? 25) * 60 * 1000;
      if (elapsedMs < requiredMs) {
        const remainingMin = Math.max(1, Math.ceil((requiredMs - elapsedMs) / 60000));
        throw new BadRequestException(
          `Spend a bit more time on this topic first — about ${remainingMin} more minute${remainingMin === 1 ? '' : 's'}.`
        );
      }
    }

    await this.db.query(
      `UPDATE daily_targets
       SET is_completed=$1, completed_at=$2, attempted_questions=$3, updated_at=NOW()
       WHERE id=$4 AND user_id=$5`,
      [
        nowComplete,
        nowComplete ? new Date() : null,
        nowComplete ? target.total_questions : 0,
        targetId,
        userId,
      ]
    );

    // ── Trigger achievements + challenge progress on completion ──
    if (nowComplete) {
      // Fire-and-forget so UI isn't blocked by achievement checks
      Promise.all([
        this.achievementsService
          .checkAndAward(userId, 'goal_complete')
          .catch(e => console.error('achievement check failed:', e.message)),
        this.challengesService
          .updateProgress(userId, 'goal_complete', 1)
          .catch(e => console.error('challenge update failed:', e.message)),
      ]);
    }
    

    // Award coin only on first-ever completion of this specific target
    // If user uncompletes and re-completes, no extra coin awarded
    let coinsEarned = 0;
    if (nowComplete) {
      const alreadyAwarded = await this.db.query(
        `SELECT id FROM coin_transactions
         WHERE user_id=$1 AND action='target_complete' AND ref_id=$2
         LIMIT 1`,
        [userId, targetId]
      );
      if (!alreadyAwarded.length) {
        coinsEarned = await this.authService.awardCoins(userId, 'target_complete', targetId);
        // Only add study minutes on first completion
        await this.db.query(
          `UPDATE users SET total_study_minutes=total_study_minutes+$1 WHERE id=$2`,
          [target.estimated_minutes, userId]
        );
      }
    }

    // Invalidate user cache so stats refresh
    await this.cache.del(`user:${userId}`);
    await this.cache.del(`profile:${userId}`);

    // 🔔 Target complete push
    if (nowComplete && coinsEarned > 0) {
      this.notifService?.pushToUser(
        userId,
        '✅ Daily Target Done!',
        `Keep it up! You earned 🪙 +${coinsEarned} coins.`,
        { type: 'target_complete', screen: 'daily_targets' }
      )?.catch(() => {});
    }

    return successResponse(
      {
        id:          targetId,
        isCompleted: nowComplete,
        coinsEarned,
      },
      nowComplete ? `Target completed! +${coinsEarned} coins 🎉` : 'Target marked as incomplete'
    );
  }

  // ── DELETE /users/daily-targets/:id ──────────────────────
  async deleteTarget(targetId: string, userId: string) {
    const rows = await this.db.query(
      `SELECT id, title, is_completed, is_carried_forward, target_date
       FROM daily_targets WHERE id=$1 AND user_id=$2`,
      [targetId, userId]
    );
    if (!rows.length) throw new NotFoundException('Target not found');

    const target      = rows[0];
    const wasCompleted = target.is_completed;

    // ── KEY FIX: if this is a carried-forward copy, also delete ALL
    // source originals (same title, same user, not carried forward, incomplete)
    // so getTargets() cannot re-create this target on next load.
    if (target.is_carried_forward) {
      await this.db.query(
        `DELETE FROM daily_targets
         WHERE user_id=$1
           AND title=$2
           AND is_carried_forward = FALSE
           AND is_completed = FALSE`,
        [userId, target.title]
      );
      // Also delete any other carried-forward copies of the same title today
      await this.db.query(
        `DELETE FROM daily_targets
         WHERE user_id=$1
           AND title=$2
           AND is_carried_forward = TRUE
           AND id != $3`,
        [userId, target.title, targetId]
      );
    }

    // If completed, debit the exact coins awarded for THIS specific target
    if (wasCompleted) {
      try {
        // Look up by ref_id which is set to targetId when coins are awarded
        const coinTx = await this.db.query(
          `SELECT id, amount FROM coin_transactions
           WHERE user_id=$1 AND action='target_complete' AND ref_id=$2
           LIMIT 1`,
          [userId, targetId]
        );
        if (coinTx.length) {
          const amount = Math.abs(Number(coinTx[0].amount));
          if (amount > 0) {
            await this.db.query(
              `UPDATE users SET coins = GREATEST(0, coins - $1) WHERE id=$2`,
              [amount, userId]
            );
            const bal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0]?.coins ?? 0;
            await this.db.query(
              `INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
               VALUES ($1, 'spent', $2, 'Target deleted — coins reversed', 'target_deleted', $3)`,
              [userId, -amount, bal]
            ).catch(() => {});
          }
        }
      } catch (_) {
        // Coin debit failure must NOT block the delete
      }
    }

    // Delete the target itself
    await this.db.query(
      `DELETE FROM daily_targets WHERE id=$1 AND user_id=$2`,
      [targetId, userId]
    );

    return successResponse(
      { coinsDebited: wasCompleted },
      wasCompleted ? 'Target deleted — coins reversed' : 'Target deleted'
    );
  }

  async updateTarget(targetId: string, userId: string, title: string, subject: string) {
    const rows = await this.db.query(
      `SELECT id FROM daily_targets WHERE id=$1 AND user_id=$2`,
      [targetId, userId]
    );
    if (!rows.length) throw new NotFoundException('Target not found');

    await this.db.query(
      `UPDATE daily_targets SET title=$1, subject=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4`,
      [title.trim(), subject || 'General Studies', targetId, userId]
    );

    return this.getTargets(userId);
  }
}

// ── Controller ─────────────────────────────────────────────
@ApiTags('Daily Targets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users/daily-targets')
class DailyTargetsController {
  constructor(private s: DailyTargetsService) {}

  /** GET /api/v1/users/daily-targets — fetch today's plan */
  @Get()
  getTargets(@Req() r: any) {
    return this.s.getTargets(r.user.id);
  }

  /** GET /api/v1/users/daily-targets/history?days=30 — past completion history */
  @Get('history')
  getHistory(@Req() r: any, @Query('days') days?: string) {
    return this.s.getHistory(r.user.id, Math.min(parseInt(days || '30', 10) || 30, 90));
  }

  /** GET /api/v1/users/daily-targets/history/:date — all targets for a specific date */
  @Get('history/:date')
  getHistoryByDate(@Req() r: any, @Param('date') date: string) {
    return this.s.getHistoryByDate(r.user.id, date);
  }

  /**
   * POST /api/v1/users/daily-targets
   * Body: { title, subject?, difficulty?, timeSlot?, estimatedMinutes? }
   *    OR { titles: ['Title 1', 'Title 2', ...] }   ← batch
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createTargets(@Body() dto: any, @Req() r: any) {
    return this.s.createTargets(r.user.id, dto);
  }

  /**
   * PATCH /api/v1/users/daily-targets/:id/complete
   * Toggles completion status and awards coins
   */
  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  toggleComplete(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: any,
  ) {
    return this.s.toggleComplete(id, r.user.id);
  }

  /**
   * DELETE /api/v1/users/daily-targets/:id
   * Remove a pending (incomplete) target
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: any,
  ) {
    return this.s.deleteTarget(id, r.user.id);
  }

  /**
   * PATCH /api/v1/users/daily-targets/:id
   * Update title and subject of a target
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  updateTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: any,
    @Req() r: any,
  ) {
    return this.s.updateTarget(id, r.user.id, dto.title, dto.subject);
  }
}

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [DailyTargetsController],
  providers: [
    DailyTargetsService,
    AchievementsService,
    WeeklyChallengesService,
    NotificationService,
  ],
})

export class DailyTargetsModule {}


// ════════════════════════════════════════════════════════════
// USERS MODULE  (profile, stats, leaderboard, live classes, certs, downloads)
// ════════════════════════════════════════════════════════════
@Injectable()
class UsersService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly config: ConfigService,
  ) {}

  async getProfile(userId: string) {
    const cacheKey = `profile:${userId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.db.query(
      `SELECT u.id,u.name,u.email,u.mobile,u.avatar_url,u.bio,u.district,u.state,
              u.primary_exam,u.secondary_exam,u.prep_level,u.target_year,
              u.streak,u.longest_streak,u.coins,u.total_coins_earned,
              u.total_study_minutes,u.accuracy,u.quizzes_attempted,
              u.rank,u.is_verified,u.referral_code,u.created_at AS joined_date,
              u.notification_enabled,
              (SELECT COUNT(*) FROM user_enrollments WHERE user_id=u.id) AS enrolled_courses,
              (SELECT COUNT(*) FROM certificates WHERE user_id=u.id) AS certificates_count,
              (SELECT COUNT(*) FROM subscriptions WHERE user_id=u.id AND status='active' AND ends_at>NOW())>0 AS is_subscribed,
              (SELECT plan FROM subscriptions WHERE user_id=u.id AND status='active' AND ends_at>NOW() LIMIT 1) AS current_plan
       FROM users u WHERE u.id=$1 AND u.deleted_at IS NULL`,
      [userId]
    );
    if (!result.length) throw new NotFoundException('User not found');
    const data = successResponse({ user: result[0] });
    await this.cache.set(cacheKey, data, 60);
    return data;
  }

  async updateProfile(userId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const allowed = ['name','bio','email','district','state','avatar_url'];
    for (const key of allowed) {
      if (data[key] !== undefined) { fields.push(`${key}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${i}`, [...vals, userId]); }
    await this.cache.del(`profile:${userId}`);
    await this.cache.del(`user:${userId}`);
    return successResponse(null, 'Profile updated');
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    if (!file) throw new Error('No file uploaded');
    const path     = require('path');
    const fs       = require('fs');
    const uploadDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
    const avatarDir = path.join(uploadDir, 'avatars');
    fs.mkdirSync(avatarDir, { recursive: true });
    const ext      = path.extname(file.originalname) || '.jpg';
    const filename = `avatar_${userId}_${Date.now()}${ext}`;
    const destPath = path.join(avatarDir, filename);
    fs.copyFileSync(file.path, destPath);
    try { fs.unlinkSync(file.path); } catch (_) {}   // clean up temp, non-blocking
    const baseUrl  = process.env.APP_URL ?? 'https://api.bpscnotes.in';
    const url      = `${baseUrl}/uploads/avatars/${filename}`;
    await this.db.query(`UPDATE users SET avatar_url=$1, updated_at=NOW() WHERE id=$2`, [url, userId]);
    await this.cache.del(`profile:${userId}`);
    await this.cache.del(`user:${userId}`);
    return successResponse({ url }, 'Avatar updated');
  }

  async updateExamTarget(userId: string, data: any) {
    await this.db.query(
      `UPDATE users SET primary_exam=$1, secondary_exam=$2, prep_level=$3, target_year=$4, updated_at=NOW() WHERE id=$5`,
      [data.primaryExam, data.secondaryExam||null, data.prepLevel||'beginner', data.targetYear||null, userId]
    );
    await this.cache.del(`profile:${userId}`);
    await this.cache.del(`user:${userId}`);
    return successResponse(null, 'Exam target updated');
  }

  async getStats(userId: string) {
    // Recreate ca_activity with correct schema if columns are wrong
    // DROP + CREATE is safe — we lose no meaningful data (it's just time tracking)
    await this.db.query(`
      DO $$
      BEGIN
        -- Check if created_at column exists; if not, recreate the table
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ca_activity' AND column_name = 'created_at'
        ) THEN
          DROP TABLE IF EXISTS ca_activity;
        END IF;
      END$$;

      CREATE TABLE IF NOT EXISTS ca_activity (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        activity_type VARCHAR(50) NOT NULL DEFAULT 'ca_reading',
        duration_secs INT NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch(() => {});

    const [userRow, subjectStats, recentQuizzes, weeklyActivity] = await Promise.all([
      // Fetch user-level stats so Android header (rank/accuracy/study) always has data
      this.db.query(
        `SELECT streak, accuracy, rank, total_study_minutes, quizzes_attempted,
                COALESCE((
                  SELECT SUM(active_minutes)
                  FROM study_sessions
                  WHERE user_id=$1
                    AND started_at >= CURRENT_DATE
                    AND started_at <  CURRENT_DATE + INTERVAL '1 day'
                ), 0)::int AS today_study_minutes
         FROM users WHERE id=$1`,
        [userId]
      ),
      this.db.query(
        `-- FIX: qa.score is already a percentage (0-100), not raw count
         -- Do NOT divide by total_questions again
         SELECT q.subject,
                COUNT(*) AS attempts,
                ROUND(
                  AVG(
                    CASE
                      WHEN qa.score IS NOT NULL
                           AND qa.score <= 100
                      THEN qa.score::decimal
                      ELSE NULL
                    END
                  ),
                  1
                ) AS avg_accuracy
         FROM quiz_attempts qa
         JOIN quizzes q ON qa.quiz_id = q.id
         WHERE qa.user_id = $1
           AND qa.total_questions > 0
         GROUP BY q.subject
         ORDER BY attempts DESC`,
        [userId]
      ),
      this.db.query(
        `SELECT qa.score, qa.total_questions, qa.attempted_at, q.title, q.type, q.subject
         FROM quiz_attempts qa JOIN quizzes q ON qa.quiz_id=q.id
         WHERE qa.user_id=$1 ORDER BY qa.attempted_at DESC LIMIT 10`,
        [userId]
      ),
      this.db.query(
        `-- FIX: 28-day activity for heatmap
         -- Combines quiz attempts + study session minutes + CA reading time per day
      
         WITH days AS (
           SELECT generate_series(
             CURRENT_DATE - INTERVAL '27 days',
             CURRENT_DATE,
             INTERVAL '1 day'
           )::DATE AS day
         ),
      
         quiz_activity AS (
           -- Use actual time_taken_secs recorded when the user submitted the quiz.
           -- Convert seconds → minutes, cap each attempt at 30 min so retakes
           -- don't inflate the count (a 4-second speed-run counts as <1 min, not 5).
           SELECT
             DATE(qa.attempted_at) AS date,
             SUM(LEAST(CEIL(qa.time_taken_secs::numeric / 60), 30))::int AS study_mins
           FROM quiz_attempts qa
           WHERE qa.user_id = $1
             AND qa.attempted_at >= NOW() - INTERVAL '28 days'
           GROUP BY DATE(qa.attempted_at)
         ),
      
         session_activity AS (
           SELECT
             DATE(ss.started_at) AS date,
             COALESCE(SUM(ss.duration_minutes), 0) AS study_mins
           FROM study_sessions ss
           WHERE ss.user_id = $1
             AND ss.started_at >= NOW() - INTERVAL '28 days'
           GROUP BY DATE(ss.started_at)
         ),

         ca_reading_activity AS (
           -- Current affairs reading time (logged by Android TrackStudyTime)
           SELECT
             DATE(ca.created_at) AS date,
             CEIL(SUM(ca.duration_secs)::numeric / 60)::int AS study_mins
           FROM ca_activity ca
           WHERE ca.user_id = $1
             AND ca.created_at >= NOW() - INTERVAL '28 days'
           GROUP BY DATE(ca.created_at)
         ),

         ca_mcq_activity AS (
           -- CA MCQ quiz time: estimate 2 min per attempt (no time_taken_secs stored)
           SELECT
             DATE(cma.attempted_at) AS date,
             (COUNT(*) * 2)::int    AS study_mins
           FROM ca_mcq_attempts cma
           WHERE cma.user_id = $1
             AND cma.attempted_at >= NOW() - INTERVAL '28 days'
           GROUP BY DATE(cma.attempted_at)
         ),

         lesson_activity AS (
           -- FIX: course lesson watch time (video/PDF lessons) was never
           -- counted toward the study-time heatmap at all, even though
           -- it's the main way most users spend their study time.
           -- watch_time_secs is recorded per-lesson in lesson_progress
           -- and completed_at is updated each time a lesson is marked
           -- complete, so attribute that lesson's watch time to that day.
           SELECT
             DATE(lp.completed_at) AS date,
             CEIL(SUM(lp.watch_time_secs)::numeric / 60)::int AS study_mins
           FROM lesson_progress lp
           WHERE lp.user_id = $1
             AND lp.completed_at >= NOW() - INTERVAL '28 days'
           GROUP BY DATE(lp.completed_at)
         ),

         combined AS (
           SELECT
             date,
             SUM(study_mins) AS study_mins
           FROM (
             SELECT date, study_mins FROM quiz_activity
             UNION ALL
             SELECT date, study_mins FROM session_activity
             UNION ALL
             SELECT date, study_mins FROM ca_reading_activity
             UNION ALL
             SELECT date, study_mins FROM ca_mcq_activity
             UNION ALL
             SELECT date, study_mins FROM lesson_activity
           ) src
           GROUP BY date
         )
      
         -- Return total + per-source breakdown for the activity detail sheet
         SELECT
           d.day                                                            AS date,
           COALESCE(c.study_mins, 0)                                       AS activity,
           COALESCE(q.study_mins, 0)                                       AS quiz_mins,
           COALESCE(s.study_mins, 0)                                       AS room_mins,
           COALESCE(ca.study_mins, 0)                                      AS ca_mins,
           COALESCE(lp.study_mins, 0)                                      AS lesson_mins
         FROM days d
         LEFT JOIN combined      c  ON c.date  = d.day
         LEFT JOIN quiz_activity q  ON q.date  = d.day
         LEFT JOIN session_activity s ON s.date = d.day
         LEFT JOIN ca_reading_activity ca ON ca.date = d.day
         LEFT JOIN lesson_activity lp ON lp.date = d.day
         ORDER BY d.day ASC`,
        [userId]
      ),
    ]);

    const u = userRow[0] || {};
    return successResponse({
      // ── Top-level user stats (for Dashboard header) ──────────
      // These are the fields UserStatsData DTO expects
      accuracy:           parseFloat(u.accuracy) || 0,
      current_streak:     u.streak || 0,
      total_study_minutes: u.total_study_minutes || 0,
      today_study_minutes: u.today_study_minutes || 0,
      quizzes_attempted:  u.quizzes_attempted || 0,
      // FIX: compute live rank — u.rank in DB is null until batch job runs
      rank: u.rank || await this.db.query(
        `SELECT row_num FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY coins DESC, CAST(accuracy AS FLOAT) DESC, streak DESC) AS row_num
           FROM users WHERE status='active' AND deleted_at IS NULL
         ) r WHERE r.id = $1`,
        [userId]
      ).then((r: any[]) => r[0]?.row_num || null).catch(() => null),
      // ── Activity data ─────────────────────────────────────────
      weekly_activity:    weeklyActivity,       // snake_case matches @SerializedName("weekly_activity")
      subjectAccuracy:    subjectStats,
      recentQuizzes,
    });
  }

  async getLeaderboard(query: any, userId: string) {
    const { exam, type = 'coins' } = query;
    const examClause = exam ? `AND primary_exam=$1` : '';
    const examParams = exam ? [exam] : [];

    let orderBy: string;
    let selectExtra = '';
    switch (type) {
      case 'weekly_coins':
        // Sum coin_transactions for the current ISO week (Monday 00:00 UTC onward)
        selectExtra = `, COALESCE((
          SELECT SUM(ct.amount) FROM coin_transactions ct
          WHERE ct.user_id = u.id
            AND ct.type = 'earn'
            AND ct.created_at >= date_trunc('week', NOW())
        ), 0)::int AS weekly_coins`;
        orderBy = 'weekly_coins DESC NULLS LAST, u.coins DESC';
        break;
      case 'quiz_accuracy':
        orderBy = 'CAST(u.accuracy AS FLOAT) DESC NULLS LAST, u.quizzes_attempted DESC';
        break;
      case 'streak':
        orderBy = 'u.streak DESC NULLS LAST, u.longest_streak DESC';
        break;
      default: // 'coins'
        orderBy = 'u.rank ASC NULLS LAST, u.coins DESC';
    }

    const baseSelect = `SELECT u.id, u.name, u.avatar_url, u.primary_exam,
      u.streak, u.accuracy, u.rank, u.coins, u.total_study_minutes, u.quizzes_attempted${selectExtra}
      FROM users u WHERE u.status='active' AND u.deleted_at IS NULL ${examClause}
      ORDER BY ${orderBy} LIMIT 100`;

    const [rows, myRank] = await Promise.all([
      this.db.query(baseSelect, examParams),
      this.db.query(
        `SELECT u.rank, u.coins, u.streak, u.accuracy,
          COALESCE((SELECT SUM(ct.amount) FROM coin_transactions ct
            WHERE ct.user_id=u.id AND ct.type='earn'
              AND ct.created_at >= date_trunc('week', NOW())), 0)::int AS weekly_coins
         FROM users u WHERE u.id=$1`, [userId]),
    ]);
    return successResponse({ leaderboard: rows, myRank: myRank[0], type });
  }

  async getStudySessions(userId: string, from?: string, to?: string) {
    const params: any[] = [userId];
    let dateClause = '';
    if (from) { params.push(from); dateClause += ` AND ss.started_at >= $${params.length}::date`; }
    if (to)   { params.push(to);   dateClause += ` AND ss.started_at <  ($${params.length}::date + INTERVAL '1 day')`; }
    const rows = await this.db.query(
      `SELECT ss.id, ss.started_at, ss.ended_at,
              COALESCE(ss.duration_secs, 0)                                   AS duration_secs,
              COALESCE(ss.xp_earned, 0)                                       AS xp_earned,
              r.name                                                           AS room_name,
              rt.name                                                          AS tier_name
         FROM study_sessions ss
         LEFT JOIN tier_rooms r  ON r.id  = ss.room_id
         LEFT JOIN room_tiers rt ON rt.id = ss.room_tier_id
        WHERE ss.user_id = $1 ${dateClause}
        ORDER BY ss.started_at DESC
        LIMIT 100`,
      params
    );
    return successResponse({ sessions: rows });
  }

  async getMyEnrollments(userId: string) {
    const rows = await this.db.query(
      `SELECT ue.*, c.title, c.instructor, c.thumbnail_url, c.total_lessons, c.subject, c.exam_tags
       FROM user_enrollments ue JOIN courses c ON ue.course_id=c.id
       WHERE ue.user_id=$1 ORDER BY ue.enrolled_at DESC`,
      [userId]
    );
    return successResponse({ enrollments: rows });
  }

  async getDownloads(userId: string) {
    const rows = await this.db.query(
      `SELECT ln.id, ln.title, ln.subject, ln.type, ln.file_url, ln.file_size_mb, ln.pages, nd.downloaded_at
       FROM note_downloads nd JOIN library_notes ln ON nd.note_id=ln.id
       WHERE nd.user_id=$1 ORDER BY nd.downloaded_at DESC`,
      [userId]
    );
    return successResponse({ downloads: rows });
  }

  async getCertificates(userId: string) {
    const rows = await this.db.query(
      `SELECT c.*, co.title AS course_title, co.subject, co.instructor, u.name AS user_name
       FROM certificates c
       JOIN courses co ON c.course_id=co.id
       JOIN users u    ON c.user_id=u.id
       WHERE c.user_id=$1 ORDER BY c.issued_at DESC`,
      [userId]
    );

    // Lazy-generation backfill: any certificate row created before PDF
    // generation existed will have certificate_url = NULL. Generate it
    // on first fetch so older completions still get a real download.
    const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
    const baseUrl = this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in';

    for (const cert of rows) {
      if (!cert.certificate_url) {
        try {
          const relativePath = await generateCertificatePdf(uploadDir, {
            userName: cert.user_name || 'Student',
            courseTitle: cert.course_title || 'BPSCNotes Course',
            instructor: cert.instructor,
            completedAt: cert.issued_at,
            certificateId: cert.id,
          });
          cert.certificate_url = `${baseUrl}/uploads/${relativePath}`;
          await this.db.query(
            `UPDATE certificates SET certificate_url=$1 WHERE id=$2`,
            [cert.certificate_url, cert.id]
          );
        } catch (err) {
          console.error('Lazy certificate generation failed:', err);
          // leave certificate_url as null — app will show "not yet available"
        }
      }
    }

    return successResponse({ certificates: rows });
  }

  async getLiveClasses(userId: string, limit = 10, status?: string) {
    const params: any[] = [userId];
    let statusFilter: string;
    if (status) {
      params.push(status);
      statusFilter = `lc.status = $${params.length}`;
    } else {
      // "My Schedule": only currently-live or upcoming classes. Without this,
      // classes that already ended (any time in the past) stayed in the
      // result forever, ordered oldest-first, burying upcoming classes.
      statusFilter = `lc.status IN ('live','scheduled')`;
    }
    params.push(limit);
    const rows = await this.db.query(
      `SELECT lc.*, (SELECT TRUE FROM live_class_registrations WHERE live_class_id=lc.id AND user_id=$1) AS is_registered
       FROM live_classes lc
       WHERE ${statusFilter}
       ORDER BY (lc.status='live') DESC, lc.scheduled_at ASC
       LIMIT $${params.length}`,
      params
    );
    return successResponse({ liveClasses: rows });
  }

  async registerLiveClass(classId: string, userId: string) {
    await this.db.query(`INSERT INTO live_class_registrations VALUES ($1,$2) ON CONFLICT DO NOTHING`, [classId, userId]);
    await this.db.query(`UPDATE live_classes SET registered_count=registered_count+1 WHERE id=$1`, [classId]);
    return successResponse(null, 'Registered for live class!');
  }

  async updateNotificationSettings(userId: string, enabled: boolean) {
    await this.db.query(`UPDATE users SET notification_enabled=$1, updated_at=NOW() WHERE id=$2`, [enabled, userId]);
    await this.cache.del(`user:${userId}`);
    return successResponse(null, 'Notification settings updated');
  }

  // Admin
  async getAdminLeaderboard() {
    const rows = await this.db.query(
      `SELECT id, name, primary_exam, streak, coins, accuracy, rank, total_study_minutes FROM users WHERE status='active' AND deleted_at IS NULL ORDER BY rank ASC NULLS LAST, coins DESC LIMIT 100`
    );
    return successResponse({ leaderboard: rows });
  }

  async recalculateRanks() {
    await this.db.query(
      `UPDATE users u SET rank=ranks.new_rank FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY coins DESC, accuracy DESC, streak DESC) AS new_rank FROM users WHERE status='active' AND deleted_at IS NULL) ranks WHERE u.id=ranks.id`
    );
    return successResponse(null, 'Leaderboard recalculated ✅');
  }

  async getCertificatesAdmin(query: any) {
    const { page=1, limit=20 } = query;
    const offset = (page-1)*limit;
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT c.*, u.name AS user_name, u.email, co.title AS course_title FROM certificates c JOIN users u ON c.user_id=u.id JOIN courses co ON c.course_id=co.id ORDER BY c.issued_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM certificates`),
    ]);
    return successResponse({ certificates: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async getLiveClassesAdmin(query: any) {
    const rows = await this.db.query(
      `SELECT lc.*,
              lc.status = 'live' AS is_live,
              lc.meeting_link AS meet_url,
              (SELECT COUNT(*) FROM live_class_registrations WHERE live_class_id=lc.id) AS registered_count
       FROM live_classes lc ORDER BY lc.scheduled_at DESC`
    );
    return successResponse({ liveClasses: rows });
  }

  async createLiveClass(data: any, adminId: string) {
    if (!data.title || !data.instructor) throw new BadRequestException('Title and instructor required');
    const result = await this.db.query(
      `INSERT INTO live_classes (title, instructor, subject, description, meeting_link, scheduled_at, duration_mins, exam_tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.title, data.instructor, data.subject, data.description, data.meetUrl || data.meetingLink || null, data.scheduledAt, data.durationMins||60, data.examTags||[], adminId]
    );
    return successResponse({ liveClass: result[0] }, 'Live class scheduled — visible in app ✅');
  }

  async toggleLiveClass(classId: string, isLive: boolean) {
    const newStatus = isLive ? 'live' : 'ended';
    const result = await this.db.query(
      `UPDATE live_classes SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [newStatus, classId]
    );
    if (!result.length) throw new NotFoundException('Live class not found');
    return successResponse({ status: newStatus, isLive }, isLive ? 'Class is now LIVE 🔴' : 'Class ended ⏹');
  }

  async updateLiveClass(classId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', instructor:'instructor', subject:'subject', description:'description', scheduledAt:'scheduled_at', durationMins:'duration_mins', status:'status', meetingLink:'meeting_link', meetUrl:'meeting_link' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE live_classes SET ${fields.join(',')} WHERE id=$${i}`, [...vals, classId]); }
    return successResponse(null, 'Live class updated ✅');
  }

  async getLearningProgress(userId: string) {
    const [inProgressRows, recentRows] = await Promise.all([
      this.db.query(
        `SELECT
           qs.id                                          AS session_id,
           qs.quiz_id,
           q.title                                        AS quiz_title,
           q.type                                         AS quiz_type,
           q.subject                                      AS quiz_subject,
           q.total_questions,
           qs.started_at,
           (SELECT count(*) FROM jsonb_each(qs.answers_so_far))::int AS answers_so_far_count
         FROM quiz_sessions qs
         JOIN quizzes q ON q.id = qs.quiz_id
         WHERE qs.user_id = $1
           AND qs.status  = 'in_progress'
         ORDER BY qs.started_at DESC
         LIMIT 1`,
        [userId]
      ),
      this.db.query(
        `SELECT
           qa.quiz_id,
           q.title            AS quiz_title,
           q.type             AS quiz_type,
           q.subject,
           qa.score,
           qa.correct_answers,
           qa.total_questions,
           qa.submitted_at
         FROM quiz_attempts qa
         JOIN quizzes q ON q.id = qa.quiz_id
         WHERE qa.user_id = $1
         ORDER BY qa.submitted_at DESC
         LIMIT 5`,
        [userId]
      ),
    ]);
    return successResponse({
      inProgressSession: inProgressRows[0] ?? null,
      recentAttempts:    recentRows,
    });
  }
}

@ApiTags('Users') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('users')
class UsersController {
  constructor(private s: UsersService) {}
  @Get('profile')     getProfile(@Req() r: any) { return this.s.getProfile(r.user.id); }
  @Put('profile')     updateProfile(@Req() r: any, @Body() dto: any) { return this.s.updateProfile(r.user.id, dto); }
  @Post('upload-avatar')
  @UseInterceptors(FileInterceptor('avatar', { dest: '/tmp/bpsc-uploads' }))
  uploadAvatar(@Req() r: any, @UploadedFile() file: Express.Multer.File) {
    return this.s.uploadAvatar(r.user.id, file);
  }
  @Put('exam-target') updateExamTarget(@Req() r: any, @Body() dto: any) { return this.s.updateExamTarget(r.user.id, dto); }
  @Get('stats')       getStats(@Req() r: any) { return this.s.getStats(r.user.id); }
  @Get('leaderboard') getLeaderboard(@Query() q: any, @Req() r: any) { return this.s.getLeaderboard(q, r.user.id); }
  @Get('enrollments') getEnrollments(@Req() r: any) { return this.s.getMyEnrollments(r.user.id); }
  @Get('downloads')   getDownloads(@Req() r: any) { return this.s.getDownloads(r.user.id); }
  @Get('certificates') getCertificates(@Req() r: any) { return this.s.getCertificates(r.user.id); }
  @Get('live-classes') getLiveClasses(@Req() r: any, @Query() q: any) { return this.s.getLiveClasses(r.user.id, q.limit ? parseInt(q.limit, 10) : 10, q.status); }
  @Post('live-classes/:id/register') @HttpCode(200) registerLiveClass(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.registerLiveClass(id, r.user.id); }
  @Put('notification-settings') updateNotifSettings(@Req() r: any, @Body() b: any) { return this.s.updateNotificationSettings(r.user.id, b.enabled); }
  @Get('me/learning-progress')  getLearningProgress(@Req() r: any) { return this.s.getLearningProgress(r.user.id); }
  @Get('me/study-sessions')     getStudySessions(@Req() r: any, @Query() q: any) { return this.s.getStudySessions(r.user.id, q.from, q.to); }
}

@ApiTags('Admin — Leaderboard & Live') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin')
class AdminUsersExtraController {
  constructor(private s: UsersService) {}
  @Get('leaderboard')           @RequirePermission('leaderboard') getLeaderboard()    { return this.s.getAdminLeaderboard(); }
  @Post('leaderboard/recalculate') @RequirePermission('leaderboard') recalculate()  { return this.s.recalculateRanks(); }
  @Get('certificates')          @RequirePermission('certificates') getCerts(@Query() q: any) { return this.s.getCertificatesAdmin(q); }
  @Get('live-classes')          @RequirePermission('live-classes') getLiveClasses(@Query() q: any) { return this.s.getLiveClassesAdmin(q); }
  @Post('live-classes')         @RequirePermission('live-classes') @HttpCode(201) createLiveClass(@Body() dto: any, @Req() r: any) { return this.s.createLiveClass(dto, r.admin.id); }
  @Put('live-classes/:id')      @RequirePermission('live-classes') updateLiveClass(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.updateLiveClass(id, dto); }
  @Put('live-classes/:id/toggle') @RequirePermission('live-classes') toggleLiveClass(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.toggleLiveClass(id, dto.isLive ?? false); }
}

// ─────────────────────────────────────────────────────────────
// Leaderboard Cron — runs every hour to keep ranks fresh.
// Avoids the manual admin click requirement.
// ─────────────────────────────────────────────────────────────
@Injectable()
class LeaderboardCronService implements OnModuleInit {
  private readonly logger = new Logger(LeaderboardCronService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  // Run once on startup so ranks are fresh after a restart
  async onModuleInit() {
    await this.recalculate().catch(e =>
      this.logger.warn('Startup rank recalculation failed: ' + e.message)
    );
  }

  // Recalculate every hour
  @Cron('0 * * * *')
  async recalculate() {
    await this.db.query(
      `UPDATE users u
       SET rank = ranks.new_rank
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  ORDER BY coins DESC, accuracy DESC, streak DESC
                ) AS new_rank
         FROM users
         WHERE status='active' AND deleted_at IS NULL
       ) ranks
       WHERE u.id = ranks.id`
    );
    this.logger.log('Leaderboard ranks recalculated');
  }
}

// ─────────────────────────────────────────────────────────────
// STREAK REMINDER CRON — fires at 8 AM IST (02:30 UTC)
// Sends "Don't break your streak!" push to users who have a
// streak > 0 but have NOT studied today yet.
// ─────────────────────────────────────────────────────────────
@Injectable()
class StreakReminderService {
  private readonly logger = new Logger('StreakReminderService');
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Cron('30 2 * * *')   // 02:30 UTC = 08:00 IST
  async sendStreakReminders() {
    try {
      const users = await this.db.query(
        `SELECT u.id, u.fcm_token, u.streak, u.name
         FROM users u
         WHERE u.streak > 0
           AND u.fcm_token IS NOT NULL
           AND u.notification_enabled = TRUE
           AND u.status = 'active'
           AND u.last_active_at < CURRENT_DATE     -- not active today yet
         LIMIT 2000`
      );
      if (!users.length) return;

      const tokens: string[] = users.map((u: any) => u.fcm_token).filter(Boolean);
      this.logger.log(`sendStreakReminders: ${tokens.length} users with active streaks`);

      const adminFb = require('firebase-admin');
      if (!adminFb.apps.length) return;

      // Batch in chunks of 500
      for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        const maxStreak = Math.max(...users.slice(i, i + 500).map((u: any) => u.streak));
        await adminFb.messaging().sendEachForMulticast({
          tokens: chunk,
          notification: {
            title: `🔥 ${maxStreak}-Day Streak at Risk!`,
            body: `Study for at least 5 minutes today to keep your streak alive!`,
          },
          data: { type: 'streak_reminder', screen: 'home' },
          android: { priority: 'high' },
        });
      }
      this.logger.log(`sendStreakReminders: sent to ${tokens.length} users`);
    } catch (err: any) {
      this.logger.warn(`sendStreakReminders failed: ${err.message}`);
    }
  }
}

@Module({ imports:[ConfigModule], controllers:[UsersController, AdminUsersExtraController], providers:[UsersService, LeaderboardCronService, StreakReminderService], exports:[UsersService] })
export class UsersModule {}

// ════════════════════════════════════════════════════════════
// IMAGE UPLOAD — Admin endpoint for flashcard / MCQ images
// POST /admin/upload/image  → saves to local disk → returns { data: { url } }
// ════════════════════════════════════════════════════════════
@Public()
@UseGuards(AdminJwtGuard)
@Controller('admin/upload')
class AdminUploadController {

  @Post('image')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: (_req: any, _file: any, cb: any) => {
          const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
          const dest = join(uploadDir, 'images');
          fs.mkdirSync(dest, { recursive: true });
          cb(null, dest);
        },
        filename: (_req: any, file: any, cb: any) => {
          const ext  = extname(file.originalname).toLowerCase() || '.jpg';
          const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
          cb(null, name);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 },   // 10 MB max
      fileFilter: (_req: any, file: any, cb: any) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'), false);
      },
    }),
  )
  uploadImage(@UploadedFile() file: Express.Multer.File, @Req() _req: any) {
    if (!file) throw new Error('No file uploaded');
    const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
    const baseUrl   = process.env.BASE_URL    ?? 'https://api.bpscnotes.in';
    const fileKey   = file.path.replace(uploadDir + '/', '').replace(/\\/g, '/');
    const url       = `${baseUrl}/uploads/${fileKey}`;
    return { success: true, message: 'Image uploaded', data: { url, fileKey } };
  }
}

@Module({ controllers: [AdminUploadController] })
export class AdminUploadModule {}

// ════════════════════════════════════════════════════════════
// BANNERS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class BannersService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getActiveBanners(userExam?: string) {
    const cacheKey = `banners:${userExam||'all'}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.db.query(
      `SELECT id, title, subtitle, image_url, action_link, type, bg_gradient, target, cta_label
       FROM banners WHERE is_active=TRUE AND (target='all' OR target=$1)
       ORDER BY sort_order ASC, created_at DESC LIMIT 10`,
      [userExam || 'all']
    );
    const result = successResponse({ banners: rows });
    await this.cache.set(cacheKey, result, 120);
    return result;
  }

  async findAllAdmin() {
    const rows = await this.db.query(`SELECT * FROM banners ORDER BY sort_order, created_at DESC`);
    return successResponse({ banners: rows });
  }

  async create(data: any, adminId: string) {
    // FIX: admin form sends the chosen color as bg_color / bgColor (hex
    // from a color-picker input), not bgGradient. Previously this read
    // data.bgGradient (always undefined), so bg_gradient was always
    // stored as NULL and the app fell back to the default blue gradient.
    const bgValue = data.bg_color ?? data.bgColor ?? data.bgGradient ?? null;
    const ctaLabel = data.ctaLabel ?? data.cta_label ?? null;
    const result = await this.db.query(
      `INSERT INTO banners (title, subtitle, image_url, action_link, type, target, bg_gradient, sort_order, created_by, cta_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [data.title, data.subtitle, data.imageUrl, data.actionLink ?? data.ctaRoute ?? null, data.type||'promotion', data.target||'all', bgValue, data.sortOrder||0, adminId, ctaLabel]
    );
    await this.invalidateCache();
    return successResponse({ banner: result[0] }, 'Banner created — live in app ✅');
  }

  async update(bannerId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', subtitle:'subtitle', isActive:'is_active', sortOrder:'sort_order', actionLink:'action_link', imageUrl:'image_url', ctaLabel:'cta_label' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    // FIX: color edits were silently dropped — the update field map never
    // included a color/bg_gradient mapping at all, even though the admin
    // form sends bg_color/bgColor on every save.
    const bgValue = data.bg_color ?? data.bgColor ?? data.bgGradient;
    if (bgValue !== undefined) { fields.push(`bg_gradient=$${i++}`); vals.push(bgValue); }
    // FIX: admin form sends ctaRoute for the action link on edit too.
    if (data.actionLink === undefined && data.ctaRoute !== undefined) {
      fields.push(`action_link=$${i++}`); vals.push(data.ctaRoute);
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE banners SET ${fields.join(',')} WHERE id=$${i}`, [...vals, bannerId]); }
    await this.invalidateCache();
    return successResponse(null, 'Banner updated ✅');
  }

  async remove(bannerId: string) {
    await this.db.query(`DELETE FROM banners WHERE id=$1`, [bannerId]);
    await this.invalidateCache();
    return successResponse(null, 'Banner deleted');
  }

  async trackImpression(bannerId: string) {
    await this.db.query(`UPDATE banners SET impression_count=impression_count+1 WHERE id=$1`, [bannerId]);
  }

  async trackClick(bannerId: string) {
    await this.db.query(`UPDATE banners SET click_count=click_count+1 WHERE id=$1`, [bannerId]);
  }

  private async invalidateCache() {
    // FIX: previously used a hardcoded list of cache keys
    // ('banners:all', 'banners:BPSC 70th CCE', 'banners:Bihar Police SI')
    // that don't match this system's actual exam names — so after an
    // admin edit, users whose exam wasn't one of those three hardcoded
    // strings kept seeing the STALE cached banner list (old sort order /
    // old color / missing image) for up to the 120s cache TTL.
    // Now we invalidate 'banners:all' plus every distinct `target` value
    // actually present in the banners table.
    const targets = await this.db.query(`SELECT DISTINCT target FROM banners`);
    const keys = ['banners:all', ...targets.map((t: any) => `banners:${t.target}`)];
    for (const key of new Set(keys)) await this.cache.del(key);
  }
}

@ApiTags('Banners') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('banners')
class BannersController {
  constructor(private s: BannersService) {}
  @Get()                    getBanners(@Req() r: any) { return this.s.getActiveBanners(r.user?.primary_exam); }
  @Post(':id/impression')   @HttpCode(200) impression(@Param('id', ParseUUIDPipe) id: string) { this.s.trackImpression(id); return { success: true }; }
  @Post(':id/click')        @HttpCode(200) click(@Param('id', ParseUUIDPipe) id: string) { this.s.trackClick(id); return { success: true }; }
}

@ApiTags('Admin — Banners') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/banners')
class AdminBannersController {
  constructor(private s: BannersService) {}
  @Get()         @RequirePermission('banners') findAll()   { return this.s.findAllAdmin(); }
  @Post()        @RequirePermission('banners') @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.admin.id); }
  @Put(':id')    @RequirePermission('banners') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.update(id, dto); }
  @Delete(':id') @RequirePermission('banners') remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.remove(id); }
}

@Module({ imports:[ConfigModule], controllers:[BannersController, AdminBannersController], providers:[BannersService] })
export class BannersModule {}

// ════════════════════════════════════════════════════════════
// EXAMS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class ExamsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll() {
    const cacheKey = 'exams:active';
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.db.query(`SELECT * FROM exams WHERE is_active=TRUE ORDER BY sort_order, name`);
    const result = successResponse({ exams: rows });
    await this.cache.set(cacheKey, result, 600); // 10 min — exams change rarely
    return result;
  }

  async findAllAdmin() {
    const rows = await this.db.query(
      `SELECT e.*,
         COUNT(u.id) FILTER (WHERE u.primary_exam=e.name) AS total_users,
         COUNT(u.id) FILTER (WHERE u.primary_exam=e.name AND u.last_active_at>NOW()-INTERVAL '7 days') AS active_users
       FROM exams e LEFT JOIN users u ON u.primary_exam=e.name AND u.status='active' AND u.deleted_at IS NULL
       GROUP BY e.id ORDER BY e.sort_order, e.name`
    );
    return successResponse({ exams: rows });
  }

  async create(data: any) {
    if (!data.name || !data.fullName || !data.category) throw new BadRequestException('Name, fullName, category required');
    const result = await this.db.query(
      `INSERT INTO exams (name, full_name, category, emoji, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [data.name, data.fullName, data.category, data.emoji||'🎯', data.sortOrder||0]
    );
    await this.cache.del('exams:active');
    return successResponse({ exam: result[0] }, 'Exam added — visible in app ✅');
  }

  async update(examId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { name:'name', fullName:'full_name', category:'category', emoji:'emoji', isActive:'is_active', sortOrder:'sort_order' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE exams SET ${fields.join(',')} WHERE id=$${i}`, [...vals, examId]); }
    // Clear ALL exam cache keys so Android app sees the new sort order immediately
    await this.cache.del('exams:active');
    await this.cache.reset().catch(() => {}); // broad clear for safety
    return successResponse(null, 'Exam updated ✅');
  }
}

@ApiTags('Exams') @Public() @Controller('exams')
class ExamsController {
  constructor(private s: ExamsService) {}
  @Get() findAll() { return this.s.findAll(); }
}

@ApiTags('Admin — Exams') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/exams')
class AdminExamsController {
  constructor(private s: ExamsService) {}
  @Get()      @RequirePermission('dashboard') findAll()  { return this.s.findAllAdmin(); }
  @Post()     @RequirePermission('settings')  @HttpCode(201) create(@Body() dto: any) { return this.s.create(dto); }
  @Put(':id') @RequirePermission('settings')  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.update(id, dto); }
}

@Module({ imports:[ConfigModule], controllers:[ExamsController, AdminExamsController], providers:[ExamsService] })
export class ExamsModule {}

// ════════════════════════════════════════════════════════════
// DISTRICTS MODULE
// GET   /api/v1/districts        — active districts for dropdowns (public)
// GET   /admin/districts         — admin list (all, incl. inactive)
// POST  /admin/districts         — create
// PUT   /admin/districts/:id     — update (rename, reorder, activate/deactivate)
// DELETE /admin/districts/:id    — remove
// ════════════════════════════════════════════════════════════
@Injectable()
class DistrictsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll(state?: string) {
    const cacheKey = `districts:active:${state || 'all'}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const params: any[] = [];
    let where = 'is_active = TRUE';
    if (state) { where += ` AND state = $1`; params.push(state); }

    const rows = await this.db.query(
      `SELECT id, name, state FROM districts WHERE ${where} ORDER BY sort_order, name`,
      params
    );
    const result = successResponse({ districts: rows });
    await this.cache.set(cacheKey, result, 600); // 10 min — districts change rarely
    return result;
  }

  async findAllAdmin() {
    const rows = await this.db.query(
      `SELECT * FROM districts ORDER BY sort_order, name`
    );
    return successResponse({ districts: rows });
  }

  async create(data: any) {
    if (!data.name) throw new BadRequestException('name is required');
    const result = await this.db.query(
      `INSERT INTO districts (name, state, sort_order) VALUES ($1,$2,$3) RETURNING *`,
      [data.name, data.state || 'Bihar', data.sortOrder ?? 0]
    );
    await this.invalidateCache();
    return successResponse({ district: result[0] }, 'District added ✅');
  }

  async update(id: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { name: 'name', state: 'state', isActive: 'is_active', sortOrder: 'sort_order' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push('updated_at=NOW()');
    await this.db.query(`UPDATE districts SET ${fields.join(',')} WHERE id=$${i}`, [...vals, id]);
    await this.invalidateCache();
    return successResponse(null, 'District updated ✅');
  }

  async remove(id: string) {
    await this.db.query(`DELETE FROM districts WHERE id=$1`, [id]);
    await this.invalidateCache();
    return successResponse(null, 'District removed ✅');
  }

  private async invalidateCache() {
    await this.cache.del('districts:active:all');
    await this.cache.del('districts:active:Bihar');
  }
}

@ApiTags('Districts') @Public() @Controller('districts')
class DistrictsController {
  constructor(private s: DistrictsService) {}
  @Get() findAll(@Query('state') state?: string) { return this.s.findAll(state); }
}

@ApiTags('Admin — Districts') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/districts')
class AdminDistrictsController {
  constructor(private s: DistrictsService) {}
  @Get()      @RequirePermission('settings') findAll() { return this.s.findAllAdmin(); }
  @Post()     @RequirePermission('settings') @HttpCode(201) create(@Body() dto: any) { return this.s.create(dto); }
  @Put(':id') @RequirePermission('settings') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.update(id, dto); }
  @Delete(':id') @RequirePermission('settings') remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.remove(id); }
}

@Module({ controllers: [DistrictsController, AdminDistrictsController], providers: [DistrictsService] })
export class DistrictsModule {}

// ════════════════════════════════════════════════════════════
// FLASHCARDS MODULE
// GET  /api/v1/flashcards          — list for Active Recall screen
// GET  /admin/flashcards           — admin list with full fields
// POST /admin/flashcards           — create
// PUT  /admin/flashcards/:id       — update
// DELETE /admin/flashcards/:id     — delete
//
// Table schema (from migration):
//   id, front, back, subject, exam_tags, difficulty, is_active, created_by, created_at
//
// Android FlashcardDto expects:
//   id, subject, topic, question, answer, hint, difficulty, related_mcq
//   (the "example" field was removed — unused by any client)
//
// Mapping: front→question, back→answer, topic="General" (not in schema, derive from subject)
// ════════════════════════════════════════════════════════════

@Injectable()
class FlashcardsService {
  private readonly logger = new Logger('FlashcardsService');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject('NOTIFICATION_SERVICE') @Optional() private readonly notifSvc?: {
      pushToAll: (title: string, body: string, data?: Record<string, string>) => Promise<void>;
    },
  ) {}

  async findAll(query: any) {
    const { subject, limit = 200, exam } = query;
    const cacheKey = `flashcards:${subject || 'all'}:${exam || 'all'}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;
    const conditions = [`f.is_active = TRUE`];
    const params: any[] = [];
    if (subject) { conditions.push(`f.subject = $${params.length + 1}`); params.push(subject); }
    if (exam) { conditions.push(`$${params.length + 1} = ANY(f.exam_tags)`); params.push(exam); }
    const rows = await this.db.query(
      `SELECT f.id, f.subject,
         COALESCE(NULLIF(f.topic,''), f.subject) AS topic,
         f.front AS question, f.back AS answer,
         COALESCE(f.hint,'') AS hint,
         COALESCE(f.card_type,'text') AS card_type,
         f.image_url, f.back_image_url,
         NULL AS related_mcq, f.exam_tags
       FROM flashcards f WHERE ${conditions.join(' AND ')}
       ORDER BY f.subject, f.created_at ASC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    const result = successResponse({ flashcards: rows });
    await this.cache.set(cacheKey, result, 300);
    return result;
  }

  async findAllAdmin(query: any) {
    const { page = 1, limit = 50, subject } = query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (subject) { conditions.push(`subject=$${params.length + 1}`); params.push(subject); }
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT * FROM flashcards WHERE ${conditions.join(' AND ')} ORDER BY subject, created_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM flashcards WHERE ${conditions.join(' AND ')}`, params),
    ]);
    return successResponse({ flashcards: rows, total: parseInt(countResult[0].count) });
  }

  async create(data: any, adminId: string) {
    const front = data.front || data.question;
    const back  = data.back  || data.answer || '';
    const backImageUrl = data.backImageUrl || data.back_image_url || null;
    if (!front) throw new BadRequestException('front (question) is required');
    if (!back && !backImageUrl) throw new BadRequestException('back (answer) or a back image is required');
    const cardType = data.cardType || data.card_type || 'text';
    const imageUrl = cardType === 'image' ? (data.imageUrl || data.image_url || null) : null;
    const result = await this.db.query(
      `INSERT INTO flashcards (front, back, subject, exam_tags, card_type, image_url, back_image_url, topic, hint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [front, back, data.subject || 'General', data.examTags || data.exam_tags || [],
       cardType, imageUrl, backImageUrl, data.topic || data.subject || 'General', data.hint || '', adminId]
    );
    await this.invalidateCache();
    // Auto-push notification when sendNotification !== false
    if (data.sendNotification !== false) {
      this.pushFlashcardNotification(data.subject || 'General').catch(() => {});
    }
    return successResponse({ flashcard: result[0] }, 'Flashcard created ✅');
  }

  async update(id: string, data: any) {
    const existing = await this.db.query(`SELECT id FROM flashcards WHERE id=$1`, [id]);
    if (!existing.length) throw new NotFoundException('Flashcard not found');
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { front:'front', back:'back', question:'front', answer:'back', subject:'subject', isActive:'is_active', topic:'topic', hint:'hint' };
    if (data.backImageUrl !== undefined || data.back_image_url !== undefined) { fields.push(`back_image_url=$${i++}`); vals.push(data.backImageUrl ?? data.back_image_url ?? null); }
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (data.examTags) { fields.push(`exam_tags=$${i++}`); vals.push(data.examTags); }
    if (data.cardType || data.card_type) {
      const ct = data.cardType || data.card_type;
      fields.push(`card_type=$${i++}`); vals.push(ct);
      if (ct === 'image' && (data.imageUrl || data.image_url)) { fields.push(`image_url=$${i++}`); vals.push(data.imageUrl || data.image_url); }
      if (ct === 'text') { fields.push(`image_url=$${i++}`); vals.push(null); }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    await this.db.query(`UPDATE flashcards SET ${fields.join(',')} WHERE id=$${i}`, [...vals, id]);
    await this.invalidateCache();
    return successResponse(null, 'Flashcard updated ✅');
  }

  async remove(id: string) {
    await this.db.query(`UPDATE flashcards SET is_active=FALSE WHERE id=$1`, [id]);
    await this.invalidateCache();
    return successResponse(null, 'Flashcard deleted ✅');
  }

  private async invalidateCache() {
    await this.cache.del('flashcards:all:all');
    const subjects = ['Polity','History','Geography','Economy','Bihar GK','Science','Environment','General'];
    for (const s of subjects) await this.cache.del(`flashcards:${s}:all`);
  }

  async getUserProgress(userId: string) {
    const rows = await this.db.query(
      `SELECT ufp.flashcard_id AS "flashcardId", ufp.status, ufp.streak,
              ufp.ease_factor AS "easeFactor", ufp.repetitions, ufp.next_review AS "nextReview"
       FROM user_flashcard_progress ufp
       INNER JOIN flashcards f ON f.id = ufp.flashcard_id AND f.is_active = TRUE
       WHERE ufp.user_id = $1`, [userId]
    ).catch(() => []);
    const mastered = rows.filter((r: any) => r.status === 'mastered').map((r: any) => r.flashcardId);
    const weak     = rows.filter((r: any) => r.status === 'weak').map((r: any) => r.flashcardId);
    return successResponse({ mastered, weak, total: rows.length });
  }

  async saveProgress(userId: string, dto: { flashcardId: string; rating: 'mastered' | 'weak' | 'skipped'; streak?: number }) {
    const { flashcardId, rating } = dto;
    if (rating === 'skipped') return successResponse({ saved: false });
    await this.db.query(
      `INSERT INTO user_flashcard_progress
         (user_id, flashcard_id, status, streak, repetitions, last_reviewed, next_review)
       VALUES ($1, $2, $3, CASE WHEN $3='mastered' THEN 1 ELSE 0 END, 1, NOW(), CURRENT_DATE + INTERVAL '1 day')
       ON CONFLICT (user_id, flashcard_id) DO UPDATE SET
         status = EXCLUDED.status,
         streak = CASE WHEN EXCLUDED.status='mastered' THEN user_flashcard_progress.streak + 1 ELSE 0 END,
         repetitions = user_flashcard_progress.repetitions + 1,
         last_reviewed = NOW(),
         next_review = CURRENT_DATE + INTERVAL '1 day' * CASE WHEN EXCLUDED.status='mastered'
                         THEN GREATEST(1, user_flashcard_progress.streak + 1) ELSE 1 END`,
      [userId, flashcardId, rating]
    ).catch(async () => {
      await this.db.query(`
        DO $$ BEGIN
          ALTER TABLE user_flashcard_progress ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unseen';
          ALTER TABLE user_flashcard_progress ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0;
        EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      `).catch(() => {});
    });
    return successResponse({ saved: true, flashcardId, rating });
  }

  // ── Notification prefs ────────────────────────────────────
  async syncFlashcardNotifPrefs(userId: string, topics: string[]) {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS flashcard_notif_prefs (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic_key VARCHAR(100) NOT NULL DEFAULT 'all',
        PRIMARY KEY (user_id, topic_key)
      )
    `).catch(() => {});
    await this.db.query(`DELETE FROM flashcard_notif_prefs WHERE user_id=$1`, [userId]);
    for (const topic of topics) {
      if (topic.length > 100) continue;
      await this.db.query(
        `INSERT INTO flashcard_notif_prefs (user_id, topic_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, topic]
      );
    }
    return successResponse({ subscribed: topics }, 'Flashcard notification preferences saved');
  }

  async getFlashcardNotifPrefs(userId: string) {
    const rows = await this.db.query(
      `SELECT topic_key FROM flashcard_notif_prefs WHERE user_id=$1`, [userId]
    ).catch(() => []);
    return successResponse({ subscribed: rows.map((r: any) => r.topic_key) });
  }

  // ── Publish batch + notify ─────────────────────────────────
  async publishAndNotify(subject: string, count: number) {
    await this.pushFlashcardNotification(subject, count);
    return successResponse({ notified: true }, `Notification sent for ${subject} flashcards`);
  }

  private async pushFlashcardNotification(subject: string, count?: number) {
    const title = count && count > 1 ? `📚 ${count} New Flashcards: ${subject}` : `📚 New Flashcards Available`;
    const body  = `New ${subject} flashcards are ready for your Active Recall session!`;
    const data  = { type: 'new_flashcards', screen: 'flashcards', subject };
    try {
      const rows = await this.db.query(
        `SELECT DISTINCT u.fcm_token
         FROM flashcard_notif_prefs fnp
         JOIN users u ON u.id = fnp.user_id
         WHERE fnp.topic_key IN ($1, 'all')
           AND u.fcm_token IS NOT NULL AND u.notification_enabled = TRUE AND u.status = 'active'`,
        [subject]
      ).catch(() => []);
      const tokens: string[] = rows.map((r: any) => r.fcm_token).filter(Boolean);
      if (tokens.length === 0) {
        this.notifSvc?.pushToAll(title, body, data).catch(() => {});
        return;
      }
      const adminFb = require('firebase-admin');
      if (!adminFb.apps.length) return;
      for (let i = 0; i < tokens.length; i += 500) {
        await adminFb.messaging().sendEachForMulticast({
          tokens: tokens.slice(i, i + 500),
          notification: { title, body }, data, android: { priority: 'high' },
        });
      }
      this.logger.log(`pushFlashcard: sent to ${tokens.length} subscribers for "${subject}"`);
    } catch (err: any) {
      this.logger.warn(`pushFlashcardNotification: ${err.message}`);
    }
  }
}

@ApiTags('Flashcards') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('flashcards')
class FlashcardsController {
  constructor(private s: FlashcardsService) {}
  @Get('progress')  getProgress(@Req() r: any) { return this.s.getUserProgress(r.user.id); }
  @Post('progress') @HttpCode(HttpStatus.OK) saveProgress(@Body() dto: any, @Req() r: any) { return this.s.saveProgress(r.user.id, dto); }
  @Get() findAll(@Query() q: any) { return this.s.findAll(q); }
  @Post('notif-prefs') @HttpCode(HttpStatus.OK) syncNotifPrefs(@Body() body: { topics: string[] }, @Req() r: any) { return this.s.syncFlashcardNotifPrefs(r.user.id, body.topics || []); }
  @Get('notif-prefs') getNotifPrefs(@Req() r: any) { return this.s.getFlashcardNotifPrefs(r.user.id); }
}

@ApiTags('Admin — Flashcards') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/flashcards')
class AdminFlashcardsController {
  constructor(private s: FlashcardsService) {}
  @Get()     @RequirePermission('library') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Post()    @RequirePermission('library') @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.admin.id); }
  @Put(':id')  @RequirePermission('library') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.update(id, dto); }
  @Delete(':id') @RequirePermission('library') remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.remove(id); }
  @Post('publish-notify') @RequirePermission('library') @HttpCode(HttpStatus.OK)
  publishNotify(@Body() body: { subject: string; count?: number }) {
    return this.s.publishAndNotify(body.subject || 'General', body.count ?? 1);
  }
}

@Module({ controllers: [FlashcardsController, AdminFlashcardsController], providers: [FlashcardsService] })
export class FlashcardsModule {}