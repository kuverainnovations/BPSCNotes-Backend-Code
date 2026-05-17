
import {
  Module, Injectable, Controller,
  Get, Post, Param, Query, Req, Body,
  UseGuards, HttpCode, HttpStatus, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource }       from '@nestjs/typeorm';
import { DataSource }             from 'typeorm';
import { JwtAuthGuard }           from '../../common/guards';
import { AuthModule }             from '../auth/auth.module';
import { successResponse }        from '../../common/utils/response.util';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/notifications/notifications.module.ts
//
// ROOT CAUSE OF EMPTY INBOX:
//
// Admin send() flow:
//   1. INSERT INTO notifications (global record, no user_id)
//   2. INSERT INTO user_notifications (per-user inbox rows)
//
// Old GET /notifications query:
//   SELECT FROM notifications WHERE user_id=$1 OR user_id IS NULL
//   ← WRONG: `notifications` table has NO `user_id` column.
//     It has `target_user_id`. The user-specific rows are in
//     `user_notifications`, not `notifications`.
//
// FIX: Query `user_notifications` table (the per-user inbox).
//      This is what admin send() actually writes to.
// ════════════════════════════════════════════════════════════

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async getForUser(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;

    // FIX: Query user_notifications (per-user inbox rows that admin send() creates).
    // The `notifications` table is the global admin record — user_notifications is the inbox.
    const [rows, countRow] = await Promise.all([
      this.db.query(`
        SELECT
          un.id,
          un.title,
          un.body,
          COALESCE(un.type, n.type, 'system') AS type,
          un.is_read,
          COALESCE(n.data, '{}') AS data,
          un.created_at,
          n.id AS notification_id
        FROM user_notifications un
        LEFT JOIN notifications n ON n.id = un.notification_id
        WHERE un.user_id = $1
        ORDER BY un.created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]),

      this.db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_read = FALSE)::int AS unread_count
        FROM user_notifications
        WHERE user_id = $1
      `, [userId]),
    ]);

    const { total, unread_count } = countRow[0];
    const totalPages = Math.ceil(total / limit);

    const notifications = rows.map((n: any) => ({
      id:        n.id,
      title:     n.title,
      body:      n.body,
      type:      n.type,
      isRead:    n.is_read,
      data:      n.data,
      createdAt: n.created_at,
    }));

    return {
      success: true,
      message: 'Success',
      data: {
        notifications,
        unreadCount: unread_count,
      },
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async markRead(notifId: string, userId: string) {
    // FIX: mark in user_notifications, not notifications
    const rows = await this.db.query(
      `SELECT id FROM user_notifications WHERE id=$1 AND user_id=$2`,
      [notifId, userId]
    );
    if (!rows.length) throw new NotFoundException('Notification not found');
    await this.db.query(
      `UPDATE user_notifications SET is_read=TRUE, read_at=NOW() WHERE id=$1`,
      [notifId]
    );
    return successResponse(null, 'Marked as read');
  }

  async markAllRead(userId: string) {
    await this.db.query(
      `UPDATE user_notifications SET is_read=TRUE, read_at=NOW()
       WHERE user_id=$1 AND is_read=FALSE`,
      [userId]
    );
    return successResponse(null, 'All notifications marked as read');
  }
}

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  getNotifications(
    @Req()          r:     any,
    @Query('page')  page  = 1,
    @Query('limit') limit = 30,
  ) {
    return this.svc.getForUser(r.user.id, +page, +limit);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Param('id') id: string, @Req() r: any) {
    return this.svc.markRead(id, r.user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@Req() r: any) {
    return this.svc.markAllRead(r.user.id);
  }
}

@Module({
  imports:     [AuthModule],
  controllers: [NotificationsController],
  providers:   [NotificationsService],
  exports:     [NotificationsService],
})
export class NotificationsModule {}
