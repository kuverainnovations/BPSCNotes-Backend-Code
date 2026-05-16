import {
  Module, Injectable, Controller,
  Get, Post, Param, Query, Req,
  UseGuards, HttpCode, HttpStatus, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource }       from '@nestjs/typeorm';
import { DataSource }             from 'typeorm';
import { JwtAuthGuard }           from '../../common/guards';
import { AuthModule }             from '../auth/auth.module';
import { successResponse }        from '../../common/utils/response.util';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/notifications/notifications.module.ts
// Endpoints:
//   GET  /notifications?page=1&limit=30
//   POST /notifications/:id/read
//   POST /notifications/read-all
// ════════════════════════════════════════════════════════════
// Migration needed (add to existing migration or create new):
// CREATE TABLE IF NOT EXISTS notifications (
//   id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//   title           VARCHAR(255) NOT NULL,
//   body            TEXT NOT NULL,
//   type            VARCHAR(50) NOT NULL DEFAULT 'system',
//   user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
//   is_read         BOOLEAN NOT NULL DEFAULT FALSE,
//   data            JSONB NOT NULL DEFAULT '{}',
//   created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
// );
// CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

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
        WHERE user_id = $1 OR user_id IS NULL   -- NULL = broadcast to all users
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]),
      this.db.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE (user_id=$1 OR user_id IS NULL) AND NOT is_read)::int AS unread_count
        FROM notifications
        WHERE user_id = $1 OR user_id IS NULL
      `, [userId]),
    ]);

    const { total, unread_count } = countRow[0];
    return successResponse({
      notifications: rows.map((n: any) => ({
        id:         n.id,
        title:      n.title,
        body:       n.body,
        type:       n.type,
        is_read:    n.is_read,
        data:       n.data,
        created_at: n.created_at,
      })),
      total,
      unread_count,
    });
  }

  async markRead(notifId: string, userId: string) {
    const rows = await this.db.query(
      `SELECT id FROM notifications WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)`, [notifId, userId]
    );
    if (!rows.length) throw new NotFoundException('Notification not found');
    await this.db.query(
      `UPDATE notifications SET is_read=TRUE WHERE id=$1`, [notifId]
    );
    return successResponse(null, 'Marked as read');
  }

  async markAllRead(userId: string) {
    await this.db.query(
      `UPDATE notifications SET is_read=TRUE WHERE (user_id=$1 OR user_id IS NULL) AND is_read=FALSE`,
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
    @Req() r: any,
    @Query('page')  page  = 1,
    @Query('limit') limit = 30
  ) { return this.svc.getForUser(r.user.id, +page, +limit); }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Param('id') id: string, @Req() r: any) {
    return this.svc.markRead(id, r.user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@Req() r: any) { return this.svc.markAllRead(r.user.id); }
}

@Module({
  imports:     [AuthModule],
  controllers: [NotificationsController],
  providers:   [NotificationsService],
  exports:     [NotificationsService],
})
export class NotificationsModule {}
