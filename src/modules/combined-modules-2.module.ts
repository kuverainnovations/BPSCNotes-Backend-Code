import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException,
  UseGuards, ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule, AuthService } from './auth/auth.module';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../common/guards';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../common/utils/response.util';

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
      `SELECT sr.*, u.name AS host_name,
         COUNT(rm.user_id) FILTER (WHERE rm.left_at IS NULL) AS current_members,
         (SELECT TRUE FROM room_members WHERE room_id=sr.id AND user_id=$${params.length+1} AND left_at IS NULL) AS is_member
       FROM study_rooms sr JOIN users u ON sr.host_id=u.id
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
      `SELECT sr.*, u.name AS host_name,
         COUNT(rm.user_id) FILTER (WHERE rm.left_at IS NULL) AS current_members
       FROM study_rooms sr JOIN users u ON sr.host_id=u.id
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
//     return this.s.create(dto, r.admin.id);
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
  create(@Body() dto: any, @Req() r: any) {
    console.log('ADMIN CREATE 👉', r.admin);
    return this.s.create(dto, r.admin.id);
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
  ) {}

  // ── GET /users/daily-targets ──────────────────────────────
  // Returns:
  //   • today's targets  (target_date = CURRENT_DATE)
  //   • carried-forward targets (incomplete targets from prev days)
  async getTargets(userId: string) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // First: auto-carry-forward any incomplete targets from past 3 days
    // that haven't already been carried forward (idempotent)
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
         -- Don't duplicate: skip if already carried forward today
         AND NOT EXISTS (
           SELECT 1 FROM daily_targets existing
           WHERE existing.user_id = dt.user_id
             AND existing.title = dt.title
             AND existing.target_date = $2::date
             AND existing.is_carried_forward = TRUE
         )`,
      [userId, today]
    );

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
        const bal   = (await this.db.query(`UPDATE users SET coins=coins+$1 WHERE id=$2 RETURNING coins`, [coins, userId]))[0].coins;
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

    // Award coin for first completion (not if toggling back)
    let coinsEarned = 0;
    if (nowComplete) {
      const rule = await this.db.query(
        `SELECT coins_awarded, max_per_day FROM coin_rules WHERE action='target_complete' AND is_active=TRUE`
      );
      if (rule.length) {
        const todayCompletions = await this.db.query(
          `SELECT COUNT(*) FROM coin_transactions
           WHERE user_id=$1 AND action='target_complete' AND created_at::date=CURRENT_DATE`,
          [userId]
        );
        if (parseInt(todayCompletions[0].count) < rule[0].max_per_day) {
          coinsEarned = rule[0].coins_awarded;
          const bal   = (await this.db.query(
            `UPDATE users SET coins=coins+$1 WHERE id=$2 RETURNING coins`,
            [coinsEarned, userId]
          ))[0].coins;
          await this.db.query(
            `INSERT INTO coin_transactions (user_id,type,amount,description,action,ref_id,balance)
             VALUES ($1,'earned',$2,'Target completed!','target_complete',$3,$4)`,
            [userId, coinsEarned, targetId, bal]
          );
        }
      }

      // Update user's study minutes (+estimated time)
      await this.db.query(
        `UPDATE users SET total_study_minutes=total_study_minutes+$1 WHERE id=$2`,
        [target.estimated_minutes, userId]
      );
    }

    // Invalidate user cache so stats refresh
    await this.cache.del(`user:${userId}`);
    await this.cache.del(`profile:${userId}`);

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
      `SELECT id FROM daily_targets WHERE id=$1 AND user_id=$2`,
      [targetId, userId]
    );
    if (!rows.length) throw new NotFoundException('Target not found');
    if (rows[0].is_completed) throw new BadRequestException('Cannot delete a completed target');

    await this.db.query(
      `DELETE FROM daily_targets WHERE id=$1 AND user_id=$2`,
      [targetId, userId]
    );
    return successResponse(null, 'Target deleted');
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
}

@Module({
  imports:     [AuthModule],
  controllers: [DailyTargetsController],   // StudyRooms controllers live in StudyRoomsModule only
  providers:   [DailyTargetsService],
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
    const allowed = ['name','bio','email','district','state'];
    for (const key of allowed) {
      if (data[key] !== undefined) { fields.push(`${key}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${i}`, [...vals, userId]); }
    await this.cache.del(`profile:${userId}`);
    await this.cache.del(`user:${userId}`);
    return successResponse(null, 'Profile updated');
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
    const [userRow, subjectStats, recentQuizzes, weeklyActivity] = await Promise.all([
      // Fetch user-level stats so Android header (rank/accuracy/study) always has data
      this.db.query(
        `SELECT streak, accuracy, rank, total_study_minutes, quizzes_attempted FROM users WHERE id=$1`,
        [userId]
      ),
      this.db.query(
        `SELECT q.subject, COUNT(*) AS attempts, ROUND(AVG(qa.score::decimal/NULLIF(qa.total_questions,0)*100),1) AS avg_accuracy
         FROM quiz_attempts qa JOIN quizzes q ON qa.quiz_id=q.id WHERE qa.user_id=$1 GROUP BY q.subject`,
        [userId]
      ),
      this.db.query(
        `SELECT qa.score, qa.total_questions, qa.attempted_at, qa.is_passed, q.title, q.type, q.subject
         FROM quiz_attempts qa JOIN quizzes q ON qa.quiz_id=q.id
         WHERE qa.user_id=$1 ORDER BY qa.attempted_at DESC LIMIT 10`,
        [userId]
      ),
      this.db.query(
        `SELECT DATE(qa.attempted_at) AS date, COUNT(*) AS activity
FROM quiz_attempts qa
WHERE qa.user_id=$1 AND qa.attempted_at >= NOW() - INTERVAL '28 days'
GROUP BY DATE(qa.attempted_at)
ORDER BY date ASC`,
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
      quizzes_attempted:  u.quizzes_attempted || 0,
      rank:               u.rank || null,
      // ── Activity data ─────────────────────────────────────────
      weekly_activity:    weeklyActivity,       // snake_case matches @SerializedName("weekly_activity")
      subjectAccuracy:    subjectStats,
      recentQuizzes,
    });
  }

  async getLeaderboard(query: any, userId: string) {
    const { exam } = query;
    let userQuery = `SELECT id, name, avatar_url, primary_exam, streak, accuracy, rank, coins, total_study_minutes FROM users WHERE status='active' AND deleted_at IS NULL`;
    const params: any[] = [];
    if (exam) { userQuery += ` AND primary_exam=$1`; params.push(exam); }
    userQuery += ` ORDER BY rank ASC NULLS LAST, coins DESC LIMIT 100`;
    const [rows, myRank] = await Promise.all([
      this.db.query(userQuery, params),
      this.db.query(`SELECT rank, coins, streak, accuracy FROM users WHERE id=$1`, [userId]),
    ]);
    return successResponse({ leaderboard: rows, myRank: myRank[0] });
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
      `SELECT c.*, co.title AS course_title, co.subject
       FROM certificates c JOIN courses co ON c.course_id=co.id
       WHERE c.user_id=$1 ORDER BY c.issued_at DESC`,
      [userId]
    );
    return successResponse({ certificates: rows });
  }

  async getLiveClasses(userId: string) {
    const rows = await this.db.query(
      `SELECT lc.*, (SELECT TRUE FROM live_class_registrations WHERE live_class_id=lc.id AND user_id=$1) AS is_registered
       FROM live_classes lc WHERE lc.status!='cancelled' ORDER BY lc.scheduled_at ASC`,
      [userId]
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
      `SELECT lc.*, (SELECT COUNT(*) FROM live_class_registrations WHERE live_class_id=lc.id) AS registered_count FROM live_classes lc ORDER BY lc.scheduled_at DESC`
    );
    return successResponse({ liveClasses: rows });
  }

  async createLiveClass(data: any, adminId: string) {
    if (!data.title || !data.scheduledAt) throw new BadRequestException('Title and scheduled time required');
    const result = await this.db.query(
      `INSERT INTO live_classes (title, instructor, subject, description, meeting_link, scheduled_at, duration_mins, exam_tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.title, data.instructor, data.subject, data.description, data.meetingLink, data.scheduledAt, data.durationMins||60, data.examTags||[], adminId]
    );
    return successResponse({ liveClass: result[0] }, 'Live class scheduled — visible in app ✅');
  }

  async updateLiveClass(classId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', instructor:'instructor', scheduledAt:'scheduled_at', durationMins:'duration_mins', status:'status', meetingLink:'meeting_link' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE live_classes SET ${fields.join(',')} WHERE id=$${i}`, [...vals, classId]); }
    return successResponse(null, 'Live class updated ✅');
  }
}

@ApiTags('Users') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('users')
class UsersController {
  constructor(private s: UsersService) {}
  @Get('profile')     getProfile(@Req() r: any) { return this.s.getProfile(r.user.id); }
  @Put('profile')     updateProfile(@Req() r: any, @Body() dto: any) { return this.s.updateProfile(r.user.id, dto); }
  @Put('exam-target') updateExamTarget(@Req() r: any, @Body() dto: any) { return this.s.updateExamTarget(r.user.id, dto); }
  @Get('stats')       getStats(@Req() r: any) { return this.s.getStats(r.user.id); }
  @Get('leaderboard') getLeaderboard(@Query() q: any, @Req() r: any) { return this.s.getLeaderboard(q, r.user.id); }
  @Get('enrollments') getEnrollments(@Req() r: any) { return this.s.getMyEnrollments(r.user.id); }
  @Get('downloads')   getDownloads(@Req() r: any) { return this.s.getDownloads(r.user.id); }
  @Get('certificates') getCertificates(@Req() r: any) { return this.s.getCertificates(r.user.id); }
  @Get('live-classes') getLiveClasses(@Req() r: any) { return this.s.getLiveClasses(r.user.id); }
  @Post('live-classes/:id/register') @HttpCode(200) registerLiveClass(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.registerLiveClass(id, r.user.id); }
  @Put('notification-settings') updateNotifSettings(@Req() r: any, @Body() b: any) { return this.s.updateNotificationSettings(r.user.id, b.enabled); }
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
}

@Module({ controllers:[UsersController, AdminUsersExtraController], providers:[UsersService], exports:[UsersService] })
export class UsersModule {}

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
      `SELECT id, title, subtitle, image_url, action_link, type, bg_gradient, target
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
    const result = await this.db.query(
      `INSERT INTO banners (title, subtitle, image_url, action_link, type, target, bg_gradient, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.title, data.subtitle, data.imageUrl, data.actionLink, data.type||'promotion', data.target||'all', data.bgGradient, data.sortOrder||0, adminId]
    );
    await this.invalidateCache();
    return successResponse({ banner: result[0] }, 'Banner created — live in app ✅');
  }

  async update(bannerId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', subtitle:'subtitle', isActive:'is_active', sortOrder:'sort_order', actionLink:'action_link', imageUrl:'image_url' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
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
    // Delete all banner cache keys — in production use Redis SCAN
    const patterns = ['banners:all', 'banners:BPSC 70th CCE', 'banners:Bihar Police SI'];
    for (const key of patterns) await this.cache.del(key);
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
    await this.cache.del('exams:active');
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
//   id, subject, topic, question, answer, hint, example, difficulty, related_mcq
//
// Mapping: front→question, back→answer, topic="General" (not in schema, derive from subject)
// ════════════════════════════════════════════════════════════

@Injectable()
class FlashcardsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll(query: any) {
    const { subject, limit = 200, exam } = query;
    const cacheKey = `flashcards:${subject || 'all'}:${exam || 'all'}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const conditions = [`f.is_active = TRUE`];
    const params: any[] = [];

    if (subject) {
      conditions.push(`f.subject = $${params.length + 1}`);
      params.push(subject);
    }
    if (exam) {
      conditions.push(`$${params.length + 1} = ANY(f.exam_tags)`);
      params.push(exam);
    }

    const rows = await this.db.query(
      `SELECT
         f.id,
         f.subject,
         f.subject AS topic,       -- topic derives from subject (table has no separate topic column)
         f.front   AS question,    -- front → question (Android expects "question")
         f.back    AS answer,      -- back  → answer   (Android expects "answer")
         ''        AS hint,
         ''        AS example,
         f.difficulty,
         NULL      AS related_mcq,
         f.exam_tags
       FROM flashcards f
       WHERE ${conditions.join(' AND ')}
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
    if (!data.front || !data.back) {
      throw new BadRequestException('front (question) and back (answer) are required');
    }
    const result = await this.db.query(
      `INSERT INTO flashcards (front, back, subject, exam_tags, difficulty, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        data.front || data.question,
        data.back  || data.answer,
        data.subject || 'General',
        data.examTags || data.exam_tags || [],
        data.difficulty || 'medium',
        adminId,
      ]
    );
    await this.invalidateCache();
    return successResponse({ flashcard: result[0] }, 'Flashcard created ✅');
  }

  async update(id: string, data: any) {
    const existing = await this.db.query(`SELECT id FROM flashcards WHERE id=$1`, [id]);
    if (!existing.length) throw new NotFoundException('Flashcard not found');
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = {
      front: 'front', back: 'back', question: 'front', answer: 'back',
      subject: 'subject', difficulty: 'difficulty', isActive: 'is_active',
    };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (data.examTags) { fields.push(`exam_tags=$${i++}`); vals.push(data.examTags); }
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
    // Clear all flashcard cache keys
    await this.cache.del('flashcards:all:all');
    const subjects = ['Polity','History','Geography','Economy','Bihar GK','Science','Environment'];
    for (const s of subjects) await this.cache.del(`flashcards:${s}:all`);
  }
}

@ApiTags('Flashcards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('flashcards')
class FlashcardsController {
  constructor(private s: FlashcardsService) {}

  /** GET /api/v1/flashcards?subject=Polity&limit=200 */
  @Get()
  findAll(@Query() q: any) {
    return this.s.findAll(q);
  }
}

@ApiTags('Admin — Flashcards')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/flashcards')
class AdminFlashcardsController {
  constructor(private s: FlashcardsService) {}

  @Get()                @RequirePermission('library')    findAll(@Query() q: any)  { return this.s.findAllAdmin(q); }
  @Post()               @RequirePermission('library')    @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.admin.id); }
  @Put(':id')           @RequirePermission('library')    update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.update(id, dto); }
  @Delete(':id')        @RequirePermission('library')    remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.remove(id); }
}

@Module({
  controllers: [FlashcardsController, AdminFlashcardsController],
  providers:   [FlashcardsService],
})
export class FlashcardsModule {}
