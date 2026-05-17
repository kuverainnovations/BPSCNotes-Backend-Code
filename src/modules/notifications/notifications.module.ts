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
// FIX — Android shows empty list:
//   The Android app calls GET /api/v1/notifications and reads
//   response.data.notifications[] (an array).
//   The old query returned {notifications, total, unread_count}
//   but the Android DTO expects: {notifications[], unreadCount}.
//   Key mismatch: "unread_count" (snake_case) vs "unreadCount" (camelCase).
//   NestJS GlobalInterceptor usually handles camelCase transform,
//   but this response was built manually via successResponse({})
//   so the snake_case key bypassed it.
//
//   Also: the Android response DTO expects:
//     data.notifications  (array)
//     data.unreadCount    (camelCase)
//     meta.total          (total pages)
//
//   Fix: align response shape to what Android expects AND what
//   the admin panel already shows (it was displaying correctly).
// ════════════════════════════════════════════════════════════

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async getForUser(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [rows, countRow] = await Promise.all([
      this.db.query(`
        SELECT id, title, body, type, is_read, data, created_at
        FROM notifications
        WHERE target_user_id = $1
        OR target = 'all'
        OR target_user_id IS NULL
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]),
      this.db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE (user_id = $1 OR user_id IS NULL) AND NOT is_read
          )::int AS unread_count
        FROM notifications
        WHERE user_id = $1 OR user_id IS NULL
      `, [userId]),
    ]);

    const { total, unread_count } = countRow[0];
    const totalPages = Math.ceil(total / limit);

    const notifications = rows.map((n: any) => ({
      id:         n.id,
      title:      n.title,
      body:       n.body,
      type:       n.type,
      isRead:     n.is_read,     // FIX: camelCase so Android @SerializedName("isRead") works
      data:       n.data,
      createdAt:  n.created_at,  // FIX: camelCase
    }));

    // FIX: return BOTH camelCase keys (Android) AND include meta block (admin panel).
    // Android reads: response.data.notifications + response.data.unreadCount
    // Admin reads:   response.data.notifications + response.meta.total
    return {
      success: true,
      message: 'Success',
      data: {
        notifications,
        unreadCount: unread_count,   // camelCase — Android DTO key
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
    const rows = await this.db.query(
      `SELECT id FROM notifications WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)`,
      [notifId, userId]
    );
    if (!rows.length) throw new NotFoundException('Notification not found');
    await this.db.query(`UPDATE notifications SET is_read=TRUE WHERE id=$1`, [notifId]);
    return successResponse(null, 'Marked as read');
  }

  async markAllRead(userId: string) {
    await this.db.query(
      `UPDATE notifications SET is_read=TRUE
       WHERE (user_id=$1 OR user_id IS NULL) AND is_read=FALSE`,
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
