import * as CashfreeUtil from '../../common/utils/cashfree.util';
// ════════════════════════════════════════════════════════════
// ADMIN MODULE — Login, Dashboard Stats, Settings, Users
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, Res, HttpCode, HttpStatus, Logger,
  UnauthorizedException, NotFoundException, BadRequestException,
  UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEmail, IsNotEmpty, IsOptional, IsArray, IsObject, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { Response } from 'express';

import { AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { PaginationDto } from '../../common/dtos/pagination.dto';

// ── DTOs ──────────────────────────────────────────────────────
class AdminLoginDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @IsNotEmpty() password: string;
}

class CreateAdminDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @IsNotEmpty() password: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() permissions?: string[];
}

class UpdateSettingsDto {
  @ApiProperty() @IsObject() settings: Record<string, string>;
}

class UserStatusDto {
  @ApiProperty({ enum: ['active','banned','pending'] })
  @IsString() status: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

class AwardCoinsDto {
  @ApiProperty() @IsString() @IsNotEmpty() userId: string;
  // Without a class-validator decorator, ValidationPipe{whitelist:true}
  // strips this field → NULL hits the NOT NULL users.coins column → 500.
  @ApiProperty() @IsInt() @Min(1) @Max(100000) amount: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

// ── Admin Auth Service ────────────────────────────────────────
@Injectable()
export class AdminAuthService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const result = await this.db.query(
      `SELECT * FROM admin_users WHERE email = $1 AND status = 'active'`,
      [email.toLowerCase()]
    );
    if (!result.length) throw new UnauthorizedException('Invalid email or password');

    const admin   = result[0];
    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) throw new UnauthorizedException('Invalid email or password');

    const token = this.jwtService.sign(
      { adminId: admin.id },
      {
        secret:     this.config.get('jwt.adminSecret'),
        expiresIn:  this.config.get('jwt.adminExpiresIn'),
      }
    );

    await this.db.query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [admin.id]);

    return {
      token,
      admin: {
        id:          admin.id,
        name:        admin.name,
        email:       admin.email,
        permissions: admin.permissions,
      },
    };
  }
}

// ── Dashboard Service ─────────────────────────────────────────
@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getStats() {
    const cacheKey = 'admin:dashboard:stats';
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;
  
    const [users, revenue, subs, marketplaceRevenue, content, coins, quizStats, rooms] = await Promise.all([
      this.db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE u.last_active_at > NOW() - INTERVAL '1 day') AS active_today,
          COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '7 days') AS new_this_week,
          COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '30 days') AS new_this_month
        FROM public.users u
        WHERE u.status != 'deleted'
      `),
      this.db.query(`
        SELECT
          COALESCE(SUM(final_amount), 0) AS total,
          COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN final_amount END), 0) AS this_month,
          COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                             AND created_at < date_trunc('month', NOW()) THEN final_amount END), 0) AS last_month
        FROM subscriptions WHERE payment_status = 'success'
      `),
      this.db.query(`SELECT COUNT(*) AS active FROM subscriptions WHERE status='active' AND ends_at > NOW()`),
      // Marketplace platform revenue — the platform's net cut (platform_fee)
      // from study material sales. This is "BPSCNotes' money" the same way
      // subscriptions are, vs. the seller's 60% which just passes through.
      this.db.query(`
        SELECT
          COALESCE(SUM(platform_fee), 0) AS total,
          COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) THEN platform_fee END), 0) AS this_month,
          COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                             AND created_at < date_trunc('month', NOW()) THEN platform_fee END), 0) AS last_month
        FROM material_purchases WHERE price_paid > 0
      `),
      this.db.query(`
        SELECT
          (SELECT COUNT(*) FROM courses WHERE status='published') AS courses,
          (SELECT COUNT(*) FROM library_notes WHERE status='published') AS notes,
          (SELECT COUNT(*) FROM quizzes WHERE status='published') AS quizzes,
          (SELECT COUNT(*) FROM current_affairs WHERE status='published') AS affairs,
          (SELECT COUNT(*) FROM job_vacancies WHERE status='active') AS jobs,
          (SELECT COUNT(*) FROM study_materials WHERE status='approved') AS study_materials,
          (SELECT COUNT(*) FROM flashcards WHERE is_active=TRUE) AS flashcards
      `),
      this.db.query(`SELECT COALESCE(SUM(amount),0) AS circulation FROM coin_transactions WHERE type='earned'`),
      this.db.query(`
        SELECT
          COUNT(*) AS attempts,
          ROUND(AVG(score)::numeric, 1) AS avg_score
        FROM quiz_attempts WHERE attempted_at > NOW() - INTERVAL '30 days'
      `),
      // room_id is NULL in sessions (app doesn't pass it) — count by last_heartbeat instead
      this.db.query(`
        SELECT
          (SELECT COUNT(*) FROM study_rooms WHERE status='active') AS room_count,
          COUNT(DISTINCT ss.user_id) AS member_count
        FROM study_sessions ss
        WHERE ss.ended_at IS NULL
          AND ss.last_heartbeat > NOW() - INTERVAL '15 minutes'
      `),
    ]);


  
    const stats = {
      totalUsers:          Number(users?.[0]?.total || 0),
      activeToday:         Number(users?.[0]?.active_today || 0),
      newThisWeek:         Number(users?.[0]?.new_this_week || 0),
      newThisMonth:        Number(users?.[0]?.new_this_month || 0),
  
      // Revenue = subscriptions (100% BPSCNotes) + marketplace platform_fee
      // (the platform's net cut from study material sales; the seller's
      // 60% share is excluded since it's a pass-through, not BPSCNotes revenue).
      totalRevenue:        Number(revenue?.[0]?.total || 0) + Number(marketplaceRevenue?.[0]?.total || 0),
      revenueThisMonth:    Number(revenue?.[0]?.this_month || 0) + Number(marketplaceRevenue?.[0]?.this_month || 0),
      revenueLastMonth:    Number(revenue?.[0]?.last_month || 0) + Number(marketplaceRevenue?.[0]?.last_month || 0),
  
      revenueGrowthPct:
        (Number(revenue?.[0]?.last_month || 0) + Number(marketplaceRevenue?.[0]?.last_month || 0)) > 0
          ? Math.round(
              ((Number(revenue?.[0]?.this_month || 0) + Number(marketplaceRevenue?.[0]?.this_month || 0)) -
               (Number(revenue?.[0]?.last_month || 0) + Number(marketplaceRevenue?.[0]?.last_month || 0))) /
              (Number(revenue?.[0]?.last_month || 0) + Number(marketplaceRevenue?.[0]?.last_month || 0)) * 100
            )
          : 0,
  
      activeSubscriptions: Number(subs?.[0]?.active || 0),
  
      totalCourses:        Number(content?.[0]?.courses || 0),
      totalNotes:          Number(content?.[0]?.notes || 0),
      totalFlashcards:     Number(content?.[0]?.flashcards || 0),
      totalStudyMaterials: Number(content?.[0]?.study_materials || 0),
      totalQuizzes:        Number(content?.[0]?.quizzes || 0),
      totalAffairs:        Number(content?.[0]?.affairs || 0),
      activeJobs:          Number(content?.[0]?.jobs || 0),
  
      quizAttempts:        Number(quizStats?.[0]?.attempts || 0),
      avgAccuracy:         Number(quizStats?.[0]?.avg_score || 0),
  
      coinCirculation:     Number(coins?.[0]?.circulation || 0),
  
      activeStudyRooms:       Number(rooms?.[0]?.room_count || 0),
      activeMembersInRooms:   Number(rooms?.[0]?.member_count || 0),
    };
  
    await this.cache.set(cacheKey, stats, 60);
    return stats;
  }

  async getChartData(type: string, period: string) {
    const cacheKey = `admin:chart:${type}:${period}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    let query: string;
    const months = period === '12months' ? 12 : 6;

    if (type === 'users') {
      query = `
        SELECT TO_CHAR(DATE_TRUNC('month', gs), 'Mon') AS date,
               COUNT(u.id) AS value
        FROM generate_series(NOW() - INTERVAL '${months - 1} months', NOW(), '1 month') gs
        LEFT JOIN users u ON DATE_TRUNC('month', u.created_at) = DATE_TRUNC('month', gs)
          AND u.status != 'deleted'
        GROUP BY gs ORDER BY gs
      `;
    } else if (type === 'revenue') {
      query = `
        SELECT TO_CHAR(DATE_TRUNC('month', gs), 'Mon') AS date,
               COALESCE(SUM(s.final_amount), 0) + COALESCE(MAX(mp.platform_fee_sum), 0) AS value
        FROM generate_series(NOW() - INTERVAL '${months - 1} months', NOW(), '1 month') gs
        LEFT JOIN subscriptions s ON DATE_TRUNC('month', s.created_at) = DATE_TRUNC('month', gs)
          AND s.payment_status = 'success'
        LEFT JOIN (
          SELECT DATE_TRUNC('month', created_at) AS month, SUM(platform_fee) AS platform_fee_sum
          FROM material_purchases WHERE price_paid > 0
          GROUP BY DATE_TRUNC('month', created_at)
        ) mp ON mp.month = DATE_TRUNC('month', gs)
        GROUP BY gs ORDER BY gs
      `;
    } else {
      query = `
        SELECT TO_CHAR(attempted_at::date, 'Dy') AS date, COUNT(*) AS value
        FROM quiz_attempts WHERE attempted_at >= NOW() - INTERVAL '7 days'
        GROUP BY date ORDER BY MIN(attempted_at)
      `;
    }

    const result = await this.db.query(query);
    await this.cache.set(cacheKey, result, 300);
    return result;
  }

  async getRevenueBreakdown() {
    const result = await this.db.query(`
      SELECT plan,
             COUNT(*)::int AS count,
             COALESCE(SUM(final_amount), 0)::int AS amount
      FROM subscriptions
      WHERE payment_status = 'success'
      GROUP BY plan

      UNION ALL

      SELECT 'study_materials' AS plan,
             COUNT(*)::int AS count,
             COALESCE(SUM(platform_fee), 0)::int AS amount
      FROM material_purchases
      WHERE price_paid > 0
      HAVING COUNT(*) > 0

      ORDER BY amount DESC
    `);
    return result;
  }

  async getExamDistribution() {
    const result = await this.db.query(`
      SELECT primary_exam AS exam,
             COUNT(*) AS users
      FROM users
      WHERE status != 'deleted' AND primary_exam IS NOT NULL
      GROUP BY primary_exam ORDER BY users DESC LIMIT 10
    `);
    return result;
  }
}

// ── Admin Settings Service ────────────────────────────────────
@Injectable()
export class AdminSettingsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getAll() {
    const result = await this.db.query(`SELECT key, value, description, updated_at FROM app_settings ORDER BY key`);
    return result;
  }

  async update(settings: Record<string, string>, adminId: string) {
    for (const [key, value] of Object.entries(settings)) {
      await this.db.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
        [key, String(value), adminId]
      );
    }
    await this.cache.del('app:config');
    return 'Settings saved — effective immediately in mobile app ✅';
  }

  async getPublicConfig() {
    const cacheKey = 'app:config';
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.db.query(`
      SELECT key, value FROM app_settings
      WHERE key IN ('maintenance_mode','force_update','app_version','min_app_version',
                    'new_registrations','android_store_url','support_email',
                    'daily_quiz_limit','leaderboard_enabled','ads_enabled',
                    'coin_system_enabled','coin_to_inr_rate',
                    'rank_tier_0','rank_tier_1','rank_tier_2','rank_tier_3',
                    'rank_tier_4','rank_tier_5',
                    'screen_capture_protection','quiz_shuffle_questions','quiz_shuffle_options',
                    'streak_warning_hour',
                    'notif_daily_quiz_enabled','notif_streak_risk_enabled','notif_target_reminder_enabled')
    `);
    const rawConfig = Object.fromEntries(result.map(r => [r.key, r.value]));
    // Provide defaults for keys not yet set by admin
    const defaults: Record<string, string> = {
      daily_quiz_limit:      '5',
      leaderboard_enabled:   'true',
      ads_enabled:           'true',
      coin_system_enabled:   'true',
      coin_to_inr_rate:      '1',
      rank_tier_0:           '500',   // Beginner threshold
      rank_tier_1:           '1500',  // Explorer threshold
      rank_tier_2:           '3000',  // Achiever threshold
      rank_tier_3:           '6000',  // Expert threshold
      rank_tier_4:              '12000', // Champion threshold
      rank_tier_5:              '20000', // Legend threshold
      screen_capture_protection:     'true',
      quiz_shuffle_questions:        'true',
      quiz_shuffle_options:          'true',
      streak_warning_hour:           '20',
      notif_daily_quiz_enabled:      'true',
      notif_streak_risk_enabled:     'true',
      notif_target_reminder_enabled: 'true',
    };
    const config: Record<string, string> = { ...defaults, ...rawConfig };
    // Back/forward-compat aliases:
    //  - coins_enabled mirrors coin_system_enabled (Coins page master switch)
    //  - coin_value_inr is now just an alias of coin_to_inr_rate — both keys
    //    are sent so older app builds that read coin_value_inr keep working,
    //    while the Coins page only has ONE rate to configure.
    config.coins_enabled  = config.coin_system_enabled;
    config.coin_value_inr = config.coin_to_inr_rate;
    await this.cache.set(cacheKey, config, 300);
    return config;
  }
}

// ── Admin Users Service ───────────────────────────────────────
@Injectable()
export class AdminUsersService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll(query: PaginationDto & { search?: string; status?: string; plan?: string }) {
    const { page = 1, limit = 20, search, status, plan } = query;
    const offset = (page - 1) * limit;
    const conditions: string[] = [`u.deleted_at IS NULL`];
    const params: any[] = [];

    if (status) { conditions.push(`u.status = $${params.length + 1}`); params.push(status); }
    if (plan === 'free') conditions.push(`u.id NOT IN (SELECT user_id FROM subscriptions WHERE status='active' AND ends_at > NOW())`);
    else if (plan) {
      conditions.push(`u.id IN (SELECT user_id FROM subscriptions WHERE status='active' AND ends_at > NOW() AND plan=$${params.length + 1})`);
      params.push(plan);
    }
    if (search) {
      conditions.push(`(u.name ILIKE $${params.length + 1} OR u.email ILIKE $${params.length + 1} OR u.mobile LIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT u.id, u.name, u.email, u.mobile, u.role, u.status, u.primary_exam,
                u.prep_level, u.streak, u.coins, u.rank, u.accuracy, u.total_study_minutes,
                u.is_verified, u.created_at, u.last_active_at, u.district,
                u.quizzes_attempted,
                (SELECT plan FROM subscriptions WHERE user_id=u.id AND status='active' AND ends_at>NOW() LIMIT 1) AS subscription,
                (SELECT COUNT(*) FROM user_enrollments WHERE user_id=u.id) AS courses_enrolled
         FROM users u WHERE ${where}
         ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM users u WHERE ${where}`, params),
    ]);

    return { rows, total: parseInt(countResult[0].count) };
  }

  async findOne(userId: string) {
    const result = await this.db.query(
      `SELECT u.*,
         (SELECT json_agg(row_to_json(s) ORDER BY s.created_at DESC) FROM subscriptions s WHERE s.user_id = u.id) AS subscription_history,
         (SELECT json_agg(row_to_json(qa)) FROM (
           SELECT qa.score, qa.attempted_at, q.title FROM quiz_attempts qa
           JOIN quizzes q ON qa.quiz_id = q.id WHERE qa.user_id = u.id
           ORDER BY qa.attempted_at DESC LIMIT 10
         ) qa) AS recent_quizzes,
         (SELECT json_agg(row_to_json(ct)) FROM (
           SELECT * FROM coin_transactions WHERE user_id=u.id ORDER BY created_at DESC LIMIT 20
         ) ct) AS coin_history
       FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId]
    );
    if (!result.length) throw new NotFoundException('User not found');
    const user = result[0];
    delete user.password_hash;
    delete user.refresh_token;
    return user;
  }

  async updateStatus(userId: string, status: string) {
    if (!['active','banned','pending'].includes(status)) {
      throw new BadRequestException('Invalid status');
    }
    await this.db.query(`UPDATE users SET status=$1, updated_at=NOW() WHERE id=$2`, [status, userId]);
    await this.cache.del(`user:${userId}`);
    return `User ${status}`;
  }

  async verify(userId: string) {
    await this.db.query(`UPDATE users SET is_verified=TRUE, updated_at=NOW() WHERE id=$1`, [userId]);
    await this.cache.del(`user:${userId}`);
  }

  async awardCoins(dto: AwardCoinsDto, adminId: string) {
    if (dto.amount <= 0) throw new BadRequestException('Amount must be positive');
    // TypeORM's raw query() returns [rows, affectedCount] for UPDATE — the
    // rows must be unwrapped first. Reading .coins off the outer array gave
    // undefined → NULL balance → NOT NULL violation → the admin "award
    // coins" 500 (QA issue 1, second round).
    const [balRows] = await this.db.query(
      `UPDATE users SET coins = COALESCE(coins, 0) + $1, total_coins_earned = COALESCE(total_coins_earned, 0) + $1 WHERE id = $2 RETURNING COALESCE(coins, 0)::int AS coins`,
      [dto.amount, dto.userId]
    );
    if (!balRows.length) throw new NotFoundException('User not found');
    const newBalance = Number(balRows[0].coins) || 0;

    await this.db.query(
      `INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
       VALUES ($1, 'earned', $2, $3, 'admin_award', $4)`,
      [dto.userId, dto.amount, dto.reason || 'Admin award', newBalance]
    );
    await this.cache.del(`user:${dto.userId}`);
    return { newBalance };
  }

  async deleteAccount(userId: string) {
    await this.db.query(
      `UPDATE users SET deleted_at = NOW(), status = 'deleted', email = NULL, mobile = CONCAT(mobile, '_deleted_', EXTRACT(EPOCH FROM NOW())::text) WHERE id = $1`,
      [userId]
    );
    await this.cache.del(`user:${userId}`);
  }

  async getAdminUsers() {
    return this.db.query(
      `SELECT id, name, email, permissions, status, last_login_at, created_at FROM admin_users ORDER BY created_at`
    );
  }

  async createAdmin(dto: CreateAdminDto) {
    const existing = await this.db.query(`SELECT id FROM admin_users WHERE email=$1`, [dto.email.toLowerCase()]);
    if (existing.length) throw new BadRequestException('Email already registered');

    const hash = await bcrypt.hash(dto.password, 12);
    const result = await this.db.query(
      `INSERT INTO admin_users (name, email, password_hash, permissions) VALUES ($1,$2,$3,$4) RETURNING id, name, email, permissions`,
      [dto.name, dto.email.toLowerCase(), hash, dto.permissions || []]
    );
    return result[0];
  }

  async updateAdmin(adminId: string, data: { permissions?: string[]; status?: string; name?: string; email?: string; password?: string }) {
    // The Edit Admin dialog sends email + optional new password; both must
    // actually persist — dropping them here is how "old password still
    // works after change" happened (QA issue 2, 04-Jul).
    let passwordHash: string | null = null;
    if (data.password) {
      if (data.password.length < 8) {
        throw new BadRequestException('Password must be at least 8 characters');
      }
      passwordHash = await bcrypt.hash(data.password, 12);
    }

    let email: string | null = null;
    if (data.email) {
      email = data.email.toLowerCase();
      const clash = await this.db.query(
        `SELECT id FROM admin_users WHERE email=$1 AND id<>$2`, [email, adminId]
      );
      if (clash.length) throw new BadRequestException('Email already used by another admin');
    }

    await this.db.query(
      `UPDATE admin_users SET
        permissions=COALESCE($1,permissions),
        status=COALESCE($2,status),
        name=COALESCE($3,name),
        email=COALESCE($4,email),
        password_hash=COALESCE($5,password_hash),
        updated_at=NOW()
       WHERE id=$6`,
      [data.permissions||null, data.status||null, data.name||null, email, passwordHash, adminId]
    );
  }

  async deactivateAdmin(adminId: string, currentAdminId: string) {
    if (adminId === currentAdminId) throw new BadRequestException('Cannot deactivate your own account');
    await this.db.query(`UPDATE admin_users SET status='inactive' WHERE id=$1`, [adminId]);
  }

  // MED-18: accounts sharing a device_id — possible multi-account abuse
  async getSuspiciousAccounts(query: any) {
    const { page = 1, limit = 20 } = query;
    const offset = (page - 1) * limit;
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT u.device_id,
                COUNT(*)::int                                            AS account_count,
                array_agg(json_build_object(
                  'id',         u.id,
                  'name',       u.name,
                  'mobile',     u.mobile,
                  'email',      u.email,
                  'status',     u.status,
                  'created_at', u.created_at,
                  'last_active_at', u.last_active_at
                ) ORDER BY u.created_at)                                AS accounts,
                MAX(u.created_at)                                       AS last_registered,
                MIN(u.created_at)                                       AS first_registered
           FROM users u
          WHERE u.device_id IS NOT NULL
            AND u.deleted_at IS NULL
          GROUP BY u.device_id
         HAVING COUNT(*) > 1
          ORDER BY account_count DESC, last_registered DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(DISTINCT device_id)::int AS total
           FROM (SELECT device_id FROM users
                  WHERE device_id IS NOT NULL AND deleted_at IS NULL
                  GROUP BY device_id HAVING COUNT(*) > 1) sub`
      ),
    ]);
    return { rows, total: parseInt(countResult[0]?.total || '0') };
  }

  // MED-20: flagged quiz sessions + anti-cheat alerts
  async getSecurityAlerts(query: any) {
    const { page = 1, limit = 20, severity } = query;
    const offset = (page - 1) * limit;
    const severityClause = severity ? `AND ql.severity = '${severity}'` : '';
    const [alerts, quizFlags, countResult] = await Promise.all([
      // Anti-cheat flags from study rooms
      this.db.query(
        `SELECT ql.id, ql.session_id, ql.user_id, ql.flag_type, ql.severity,
                ql.details, ql.created_at,
                u.name AS user_name, u.mobile AS user_mobile
           FROM quiz_session_flags ql
           JOIN users u ON u.id = ql.user_id
          WHERE TRUE ${severityClause}
          ORDER BY ql.created_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      ).catch(() => []),
      // Quiz sessions with unusually high background_secs (possible tab-switching)
      this.db.query(
        `SELECT qs.id, qs.user_id, qs.quiz_id, qs.background_secs, qs.status,
                qs.started_at, qs.submitted_at,
                u.name AS user_name, q.title AS quiz_title
           FROM quiz_sessions qs
           JOIN users u ON u.id = qs.user_id
           JOIN quizzes q ON q.id = qs.quiz_id
          WHERE qs.background_secs > 120
          ORDER BY qs.background_secs DESC
          LIMIT 50`
      ).catch(() => []),
      this.db.query(
        `SELECT COUNT(*)::int AS total FROM quiz_session_flags WHERE TRUE ${severityClause}`
      ).catch(() => [{ total: 0 }]),
    ]);
    return {
      alerts,
      flaggedSessions: quizFlags,
      total: parseInt(countResult[0]?.total || '0'),
    };
  }
}

// ── Controllers ───────────────────────────────────────────────
@ApiTags('Admin — Auth')
@Public()
@Controller('admin')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: AdminLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.adminAuthService.login(dto.email, dto.password);
    res.cookie('adminToken', data.token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   24 * 60 * 60 * 1000,
      path:     '/',
    });
    return successResponse(data, 'Welcome back!');
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('adminToken', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    return successResponse(null, 'Logged out');
  }
}

@ApiTags('Admin — Dashboard')
@ApiBearerAuth()
// @Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin')
export class AdminDashboardController {
  constructor(
    private readonly service: AdminDashboardService,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  @Get('stats')
  @RequirePermission('dashboard')
  async getStats() {
    const stats = await this.service.getStats();
    return successResponse(stats);
  }

  @Get('analytics/chart')
  @RequirePermission('dashboard')
  async getChart(@Query('type') type = 'users', @Query('period') period = '12months') {
    const data = await this.service.getChartData(type, period);
    return successResponse({ data });
  }

  @Get('analytics/revenue-breakdown')
  @RequirePermission('dashboard')
  async getRevenueBreakdown() {
    const data = await this.service.getRevenueBreakdown();
    return successResponse({ data });
  }

  @Get('analytics/exam-distribution')
  @RequirePermission('dashboard')
  async getExamDistribution() {
    const data = await this.service.getExamDistribution();
    return successResponse({ data });
  }

  /** GET /admin/activity?page=1&limit=50&action=quiz_started&search=name */
  @Get('activity')
  @RequirePermission('dashboard')
  async getActivityLog(@Query() q: any) {
    // Ensure table exists before querying
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS user_activity_log (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
        action     VARCHAR(60) NOT NULL,
        description TEXT,
        metadata   JSONB       DEFAULT '{}',
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});

    const page   = Math.max(1, +(q.page  || 1));
    const limit  = Math.min(100, +(q.limit || 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let pi = 1;

    if (q.action) {
      // Map frontend tab group → actual action strings stored in user_activity_log
      const GROUP_MAP: Record<string, string[]> = {
        auth:         ['user_login_otp','user_login_mpin','user_registered','user_logout',
                       'user_mpin_created','user_mpin_changed','user_mpin_reset',
                       'user_profile_updated','user_avatar_uploaded','user_account_deleted'],
        course:       ['course_enrolled','course_review_submitted','lesson_completed'],
        quiz:         ['quiz_started','quiz_submitted'],
        material:     ['material_uploaded','material_downloaded','material_purchased','material_bookmarked'],
        study_session:['study_session_started','study_session_ended','tier_promoted','live_class_registered'],
        subscription: ['subscription_started','coins_awarded','referral_used','job_saved'],
      };
      const actions = GROUP_MAP[q.action];
      if (actions && actions.length) {
        const placeholders = actions.map(() => `$${pi++}`).join(', ');
        conditions.push(`l.action IN (${placeholders})`);
        params.push(...actions);
      } else {
        // Unknown group — fall back to direct ILIKE match (allows searching specific action)
        conditions.push(`l.action ILIKE $${pi++}`);
        params.push(`%${q.action}%`);
      }
    }
    if (q.search) {
      conditions.push(`(u.name ILIKE $${pi} OR u.mobile ILIKE $${pi} OR l.description ILIKE $${pi})`);
      params.push(`%${q.search}%`);
      pi++;
    }

    const where = conditions.join(' AND ');

    const [logs, cnt] = await Promise.all([
      this.db.query(
        `SELECT l.id, l.action, l.description, l.metadata, l.ip_address, l.created_at,
                u.name AS user_name, u.mobile AS user_mobile
         FROM user_activity_log l
         LEFT JOIN users u ON u.id = l.user_id
         WHERE ${where}
         ORDER BY l.created_at DESC
         LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(*) FROM user_activity_log l LEFT JOIN users u ON u.id=l.user_id WHERE ${where}`,
        params
      ),
    ]);

    return successResponse({ logs, total: parseInt(cnt[0].count, 10) });
  }
}

@ApiTags('Admin — Settings')
@ApiBearerAuth()
// @Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly service: AdminSettingsService) {}

  @Get()
  @RequirePermission('settings')
  async getAll() {
    const settings = await this.service.getAll();
    return successResponse({ settings });
  }

  @Put()
  @RequirePermission('settings')
  async update(@Body() dto: UpdateSettingsDto, @Req() req: any) {
    const msg = await this.service.update(dto.settings, req.admin.id);
    return successResponse(null, msg);
  }
}

@ApiTags('Admin — Users')
@ApiBearerAuth()
// @Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get()
  @RequirePermission('users')
  async findAll(@Query() query: any) {
    const { rows, total } = await this.service.findAll(query);
    return successResponse({ users: rows }, 'Success', paginationMeta(total, Number(query.page || 1), Number(query.limit || 20)));
  }

  @Get(':id')
  @RequirePermission('users')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.service.findOne(id);
    return successResponse({ user });
  }

  @Put(':id/status')
  @RequirePermission('users')
  async updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UserStatusDto) {
    const msg = await this.service.updateStatus(id, dto.status);
    return successResponse(null, msg);
  }

  @Put(':id/verify')
  @RequirePermission('users')
  async verify(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.verify(id);
    return successResponse(null, 'User verified ✅');
  }

  @Delete(':id')
  @RequirePermission('users')
  async deleteAccount(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.deleteAccount(id);
    return successResponse(null, 'Account deleted');
  }

  @Post('award-coins')
  @RequirePermission('users')
  async awardCoins(@Body() dto: AwardCoinsDto, @Req() req: any) {
    const data = await this.service.awardCoins(dto, req.admin.id);
    return successResponse(data, `${dto.amount} coins awarded ✅`);
  }

  @Get('admin-accounts/list')
  @RequirePermission('roles')
  async getAdmins() {
    const admins = await this.service.getAdminUsers();
    return successResponse({ admins });
  }

  @Post('admin-accounts')
  @RequirePermission('roles')
  @HttpCode(HttpStatus.CREATED)
  async createAdmin(@Body() dto: CreateAdminDto) {
    const admin = await this.service.createAdmin(dto);
    return successResponse({ admin }, 'Admin created');
  }

  @Put('admin-accounts/:id')
  @RequirePermission('roles')
  async updateAdmin(@Param('id', ParseUUIDPipe) id: string, @Body() data: any) {
    await this.service.updateAdmin(id, data);
    return successResponse(null, 'Admin updated');
  }

  @Delete('admin-accounts/:id')
  @RequirePermission('roles')
  async deactivateAdmin(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.service.deactivateAdmin(id, req.admin.id);
    return successResponse(null, 'Admin deactivated');
  }

  // MED-18: accounts sharing a device — possible multi-account abuse
  @Get('suspicious')
  @RequirePermission('users')
  async getSuspiciousAccounts(@Query() query: any) {
    const { rows, total } = await this.service.getSuspiciousAccounts(query);
    return successResponse({ groups: rows, total });
  }

  // MED-20: flagged quiz sessions + anti-cheat alerts
  @Get('security-alerts')
  @RequirePermission('users')
  async getSecurityAlerts(@Query() query: any) {
    const result = await this.service.getSecurityAlerts(query);
    return successResponse(result);
  }
}

// ── App Config for Mobile ─────────────────────────────────────
@ApiTags('App Config')
@Public()
@Controller('app-config')
export class AppConfigController {
  constructor(private readonly service: AdminSettingsService) {}

  // @Public()
  @Get()
  async getConfig() {
    const config = await this.service.getPublicConfig();
    return successResponse({ config });
  }
}

// ── Admin Module ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
// PAYMENT SETTINGS (Admin)
// ═══════════════════════════════════════════════════════════
@Injectable()
class PaymentSettingsService {
  constructor(@InjectDataSource() private db: DataSource) {}

  async getSettings() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const rows = await this.db.query(`SELECT key, value FROM payment_settings`);
    const map: any = {};
    rows.forEach((r: any) => { map[r.key] = r.value; });
    return {
      cashfreeAppId:  map['cashfree_app_id']  || '',
      paymentMode:    map['payment_mode']      || 'sandbox',
      upiDisplayName: map['upi_display_name']  || 'BPSCNotes',
      paymentEnabled: (map['payment_enabled']  || 'true') === 'true',
      // Never return secrets
    };
  }

  async saveSettings(data: any) {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const entries: any[] = [
      ['cashfree_app_id',  data.cashfreeAppId  || ''],
      ['payment_mode',     data.paymentMode     || 'sandbox'],
      ['upi_display_name', data.upiDisplayName  || 'BPSCNotes'],
      ['payment_enabled',  String(data.paymentEnabled !== false)],
    ];
    if (data.cashfreeSecretKey)    entries.push(['cashfree_secret_key',    data.cashfreeSecretKey]);
    if (data.cashfreeWebhookSecret) entries.push(['cashfree_webhook_secret', data.cashfreeWebhookSecret]);
    for (const [k, v] of entries) {
      await this.db.query(
        `INSERT INTO payment_settings(key,value,updated_at) VALUES($1,$2,NOW())
         ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [k, v]
      );
    }
    return successResponse(null, 'Payment settings saved ✅');
  }

  async refundSubscription(subId: string) {
    const [sub] = await this.db.query(
      `SELECT * FROM subscriptions WHERE id=$1 AND payment_status='success'`, [subId]
    );
    if (!sub) throw new NotFoundException('Subscription not found');

    // ── Cashfree refund ───────────────────────────────────────
    const providerPaymentId = sub.provider_payment_id;
    const providerOrderId   = sub.provider_order_id;
    if (providerPaymentId && providerOrderId) {
      try {
        const { refundCashfreePayment, buildCashfreeCredentials } = CashfreeUtil;
        const rows = await this.db.query(
          `SELECT key, value FROM payment_settings
           WHERE key IN ('cashfree_app_id','cashfree_secret_key','payment_mode')
             AND value IS NOT NULL AND value != ''`
        ).catch(() => []);
        const cfMap: any = {};
        for (const r of rows) cfMap[r.key] = r.value;
        const creds = buildCashfreeCredentials({
          appId:     cfMap['cashfree_app_id'] || process.env.CASHFREE_APP_ID,
          secretKey: cfMap['cashfree_secret_key'] || process.env.CASHFREE_SECRET_KEY,
          env:       cfMap['payment_mode'],
        });
        await refundCashfreePayment(creds, providerOrderId, {
          refundId:     `refund_sub_${subId.substring(0, 16)}`,
          refundAmount: sub.final_amount,
          refundNote:   'Admin initiated refund via BPSCNotes admin panel',
        });
      } catch (err: any) {
        console.error('Cashfree refund failed:', err.message);
        throw new BadRequestException('Refund API call failed: ' + err.message);
      }
    }

    await this.db.query(
      `UPDATE subscriptions SET payment_status='refunded', status='cancelled', updated_at=NOW() WHERE id=$1`,
      [subId]
    );
    await this.db.query(
      `UPDATE users SET coins=GREATEST(0,coins-$1) WHERE id=$2`,
      [sub.coins_used, sub.user_id]
    );
    return successResponse(null, 'Refund initiated ✅');
  }

  async getAnalyticsSummary() {
    const [activeUsers, quizzesToday, monthRevenue, studySessions] = await Promise.all([
      this.db.query(
        `SELECT COUNT(DISTINCT user_id) AS count FROM quiz_attempts WHERE attempted_at > NOW() - INTERVAL '7 days'`
      ),
      this.db.query(
        `SELECT COUNT(*) AS count FROM quiz_attempts WHERE attempted_at::date = CURRENT_DATE`
      ),
      this.db.query(
        `SELECT COALESCE(SUM(final_amount),0) AS total FROM subscriptions WHERE payment_status='success' AND date_trunc('month',created_at)=date_trunc('month',NOW())`
      ),
      this.db.query(
        `SELECT COUNT(*) AS count FROM study_sessions WHERE started_at > NOW() - INTERVAL '7 days'`
      ).catch(() => [{ count: 0 }]),
    ]);
    return successResponse({
      activeUsers7d:   parseInt(activeUsers[0]?.count || '0'),
      quizzesToday:    parseInt(quizzesToday[0]?.count || '0'),
      monthRevenue:    parseInt(monthRevenue[0]?.total || '0'),
      studySessions7d: parseInt(studySessions[0]?.count || '0'),
    });
  }

  async getRevenueStats() {
    const [daily] = await this.db.query(
      `SELECT COALESCE(SUM(final_amount),0) AS today
       FROM subscriptions WHERE payment_status='success' AND created_at::date=CURRENT_DATE`
    );
    const [monthly] = await this.db.query(
      `SELECT COALESCE(SUM(final_amount),0) AS month
       FROM subscriptions WHERE payment_status='success'
       AND date_trunc('month',created_at)=date_trunc('month',NOW())`
    );
    const [total] = await this.db.query(
      `SELECT COALESCE(SUM(final_amount),0) AS total FROM subscriptions WHERE payment_status='success'`
    );
    const planBreakdown = await this.db.query(
      `SELECT plan, COUNT(*) as count, SUM(final_amount) as revenue
       FROM subscriptions WHERE payment_status='success'
       GROUP BY plan ORDER BY revenue DESC`
    );
    const recentPayments = await this.db.query(
      `SELECT s.id, u.name, u.phone, s.plan, s.final_amount, s.payment_method,
              s.payment_status, s.provider_payment_id, s.payment_provider, s.created_at
       FROM subscriptions s JOIN users u ON u.id=s.user_id
       WHERE s.payment_status IN ('success','failed','refunded')
       ORDER BY s.created_at DESC LIMIT 50`
    );
    return successResponse({
      todayRevenue:   parseInt(daily.today),
      monthlyRevenue: parseInt(monthly.month),
      totalRevenue:   parseInt(total.total),
      planBreakdown,
      recentPayments
    });
  }
}

@ApiTags('Admin — Payments') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/settings')
class AdminPaymentSettingsController {
  constructor(private s: PaymentSettingsService) {}

  @Get('payment')
  getSettings() { return this.s.getSettings(); }

  @Post('payment')
  @HttpCode(200)
  saveSettings(@Body() dto: any) { return this.s.saveSettings(dto); }

  @Get('payment/revenue')
  getRevenue() { return this.s.getRevenueStats(); }

  @Get('analytics/summary')
  @RequirePermission('subscriptions')
  async getAnalyticsSummary() {
    return this.s.getAnalyticsSummary();
  }

  @Post('subscriptions/:id/refund')
  @HttpCode(200)
  refund(@Param('id', ParseUUIDPipe) id: string) { return this.s.refundSubscription(id); }
}

// ── Exam & Job Categories Controller ────────────────────────
@UseGuards(AdminJwtGuard)
@Controller('admin')
class CategoriesController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private async ensureTable(table: string) {
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${table} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
  }

  @Get('exam-categories')
  @RequirePermission('settings')
  async getExamCategories() {
    await this.ensureTable('exam_categories');
    const rows = await this.db.query(`SELECT * FROM exam_categories ORDER BY name ASC`);
    return successResponse({ categories: rows });
  }

  @Post('exam-categories')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('settings')
  async createExamCategory(@Body() dto: any) {
    await this.ensureTable('exam_categories');
    const [row] = await this.db.query(
      `INSERT INTO exam_categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=$1 RETURNING *`,
      [dto.name]
    );
    return successResponse(row, 'Category added');
  }

  @Delete('exam-categories/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings')
  async deleteExamCategory(@Param('id') id: string) {
    await this.db.query(`DELETE FROM exam_categories WHERE id=$1`, [id]);
    return successResponse(null, 'Deleted');
  }

  @Get('job-categories')
  @RequirePermission('settings')
  async getJobCategories() {
    await this.ensureTable('job_categories');
    const rows = await this.db.query(`SELECT * FROM job_categories ORDER BY name ASC`);
    return successResponse({ categories: rows });
  }

  @Post('job-categories')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('settings')
  async createJobCategory(@Body() dto: any) {
    await this.ensureTable('job_categories');
    const [row] = await this.db.query(
      `INSERT INTO job_categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=$1 RETURNING *`,
      [dto.name]
    );
    return successResponse(row, 'Category added');
  }

  @Delete('job-categories/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings')
  async deleteJobCategory(@Param('id') id: string) {
    await this.db.query(`DELETE FROM job_categories WHERE id=$1`, [id]);
    return successResponse(null, 'Deleted');
  }
}

// ════════════════════════════════════════════════════════════
// ADMIN PAYMENTS — Issue 4
// Full transaction tracking for all purchase types
// ════════════════════════════════════════════════════════════
@Injectable()
class AdminPaymentsService {
  private readonly logger = new Logger('AdminPaymentsService');

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // ── Dashboard metrics — total revenue across all purchase types ──
  async getDashboard() {
    const [subRevenue] = await this.db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN payment_status='success' THEN final_amount ELSE 0 END), 0)::int  AS total_revenue,
        COALESCE(SUM(CASE WHEN payment_status='success' AND created_at::date=CURRENT_DATE THEN final_amount ELSE 0 END), 0)::int AS revenue_today,
        COALESCE(SUM(CASE WHEN payment_status='success' AND date_trunc('month',created_at)=date_trunc('month',NOW()) THEN final_amount ELSE 0 END), 0)::int AS revenue_this_month,
        COUNT(*) FILTER (WHERE payment_status='success')::int  AS successful_payments,
        COUNT(*) FILTER (WHERE payment_status='failed')::int   AS failed_payments,
        COUNT(*) FILTER (WHERE payment_status='refunded')::int AS refunds
      FROM subscriptions
    `).catch(() => [{ total_revenue:0,revenue_today:0,revenue_this_month:0,successful_payments:0,failed_payments:0,refunds:0 }]);

    const [courseRevenue] = await this.db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END), 0)::int  AS total_revenue,
        COALESCE(SUM(CASE WHEN status='completed' AND created_at::date=CURRENT_DATE THEN amount ELSE 0 END), 0)::int AS revenue_today,
        COALESCE(SUM(CASE WHEN status='completed' AND date_trunc('month',created_at)=date_trunc('month',NOW()) THEN amount ELSE 0 END), 0)::int AS revenue_this_month,
        COUNT(*) FILTER (WHERE status='completed')::int AS successful_payments,
        COUNT(*) FILTER (WHERE status='failed')::int    AS failed_payments,
        COUNT(*) FILTER (WHERE status='refunded')::int  AS refunds
      FROM course_purchases
    `).catch(() => [{ total_revenue:0,revenue_today:0,revenue_this_month:0,successful_payments:0,failed_payments:0,refunds:0 }]);

    const [materialRevenue] = await this.db.query(`
      SELECT
        COALESCE(SUM(price_paid), 0)::int AS total_revenue,
        COALESCE(SUM(CASE WHEN created_at::date=CURRENT_DATE THEN price_paid ELSE 0 END), 0)::int AS revenue_today,
        COALESCE(SUM(CASE WHEN date_trunc('month',created_at)=date_trunc('month',NOW()) THEN price_paid ELSE 0 END), 0)::int AS revenue_this_month,
        COUNT(*)::int                     AS successful_payments
      FROM material_purchases WHERE price_paid > 0
    `).catch(() => [{ total_revenue:0,revenue_today:0,revenue_this_month:0,successful_payments:0 }]);

    const totalRevenue     = (subRevenue.total_revenue     || 0) + (courseRevenue.total_revenue     || 0) + (materialRevenue.total_revenue     || 0);
    const revenueToday     = (subRevenue.revenue_today     || 0) + (courseRevenue.revenue_today     || 0) + (materialRevenue.revenue_today     || 0);
    const revenueThisMonth = (subRevenue.revenue_this_month|| 0) + (courseRevenue.revenue_this_month|| 0) + (materialRevenue.revenue_this_month|| 0);

    return successResponse({
      totalRevenue,
      revenueToday,
      revenueThisMonth,
      courseRevenue:          courseRevenue.total_revenue    || 0,
      studyMaterialRevenue:   materialRevenue.total_revenue  || 0,
      subscriptionRevenue:    subRevenue.total_revenue       || 0,
      successfulPayments:    (subRevenue.successful_payments || 0) + (courseRevenue.successful_payments || 0) + (materialRevenue.successful_payments || 0),
      failedPayments:        (subRevenue.failed_payments     || 0) + (courseRevenue.failed_payments     || 0),
      refunds:               (subRevenue.refunds             || 0) + (courseRevenue.refunds             || 0),
    });
  }

  // ── Course purchases list ────────────────────────────────────
  async getCoursePurchases(query: any) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let pi = 1;

    if (query.status)    { conditions.push(`cp.status = $${pi++}`);          params.push(query.status); }
    if (query.search)    { conditions.push(`(u.name ILIKE $${pi} OR u.mobile ILIKE $${pi} OR c.title ILIKE $${pi})`); params.push(`%${query.search}%`); pi++; }
    if (query.dateFrom)  { conditions.push(`cp.created_at >= $${pi++}`);     params.push(query.dateFrom); }
    if (query.dateTo)    { conditions.push(`cp.created_at <= $${pi++}`);     params.push(query.dateTo); }

    const where = conditions.join(' AND ');
    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT cp.id, cp.status, cp.amount, cp.coins_applied, cp.coin_discount_inr,
                cp.provider_order_id, cp.payment_provider,
                cp.created_at, cp.updated_at,
                u.id AS user_id, u.name AS user_name, u.mobile AS user_mobile, u.email AS user_email,
                c.id AS course_id, c.title AS course_title, c.price AS course_price
         FROM course_purchases cp
         JOIN users u  ON u.id  = cp.user_id
         JOIN courses c ON c.id = cp.course_id
         WHERE ${where}
         ORDER BY cp.created_at DESC
         LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ).catch(() => []),
      this.db.query(
        `SELECT COUNT(*) FROM course_purchases cp JOIN users u ON u.id=cp.user_id JOIN courses c ON c.id=cp.course_id WHERE ${where}`,
        params
      ).catch(() => [{ count: 0 }]),
    ]);

    return successResponse({
      purchases: rows,
      meta: paginationMeta(parseInt(cnt?.count ?? '0', 10), page, limit),
    });
  }

  // ── Study material purchases list ────────────────────────────
  async getMaterialPurchases(query: any) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['mp.price_paid >= 0'];
    const params: any[] = [];
    let pi = 1;

    if (query.search)   { conditions.push(`(u.name ILIKE $${pi} OR u.mobile ILIKE $${pi} OR sm.title ILIKE $${pi})`); params.push(`%${query.search}%`); pi++; }
    if (query.dateFrom) { conditions.push(`mp.created_at >= $${pi++}`); params.push(query.dateFrom); }
    if (query.dateTo)   { conditions.push(`mp.created_at <= $${pi++}`); params.push(query.dateTo); }

    const where = conditions.join(' AND ');
    const [rows, [cnt], [totals]] = await Promise.all([
      this.db.query(
        `SELECT mp.id, mp.price_paid, mp.coins_paid, mp.platform_fee,
                mp.created_at,
                u.id AS user_id, u.name AS user_name, u.mobile AS user_mobile, u.email AS user_email,
                sm.id AS material_id, sm.title AS material_title, sm.price AS material_price,
                mpo.provider_order_id, mpo.provider_payment_id, mpo.payment_provider, mpo.status AS order_status
         FROM material_purchases mp
         JOIN users u ON u.id = mp.user_id
         JOIN study_materials sm ON sm.id = mp.material_id
         LEFT JOIN material_purchase_orders mpo ON mpo.material_id=mp.material_id AND mpo.user_id=mp.user_id AND mpo.status='completed'
         WHERE ${where}
         ORDER BY mp.created_at DESC
         LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ).catch(() => []),
      this.db.query(
        `SELECT COUNT(*) FROM material_purchases mp JOIN users u ON u.id=mp.user_id JOIN study_materials sm ON sm.id=mp.material_id WHERE ${where}`,
        params
      ).catch(() => [{ count: 0 }]),
      this.db.query(
        `SELECT COALESCE(SUM(mp.price_paid),0)::int AS total_collected,
                COALESCE(SUM(mp.platform_fee),0)::int AS total_platform_fee
         FROM material_purchases mp JOIN users u ON u.id=mp.user_id JOIN study_materials sm ON sm.id=mp.material_id WHERE ${where}`,
        params
      ).catch(() => [{ total_collected: 0, total_platform_fee: 0 }]),
    ]);

    return successResponse({
      purchases: rows,
      totals,
      meta: paginationMeta(parseInt(cnt?.count ?? '0', 10), page, limit),
    });
  }

  // ── Subscription payments list ────────────────────────────────
  async getSubscriptionPayments(query: any) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let pi = 1;

    if (query.status)   { conditions.push(`s.payment_status = $${pi++}`); params.push(query.status); }
    if (query.search)   { conditions.push(`(u.name ILIKE $${pi} OR u.mobile ILIKE $${pi})`); params.push(`%${query.search}%`); pi++; }
    if (query.dateFrom) { conditions.push(`s.created_at >= $${pi++}`); params.push(query.dateFrom); }
    if (query.dateTo)   { conditions.push(`s.created_at <= $${pi++}`); params.push(query.dateTo); }

    const where = conditions.join(' AND ');
    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT s.id, s.plan, s.final_amount, s.payment_status, s.payment_method,
                s.provider_order_id, s.provider_payment_id, s.payment_provider,
                s.created_at, s.ends_at,
                u.id AS user_id, u.name AS user_name, u.mobile AS user_mobile, u.email AS user_email
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         WHERE ${where}
         ORDER BY s.created_at DESC
         LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ).catch(() => []),
      this.db.query(
        `SELECT COUNT(*) FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE ${where}`,
        params
      ).catch(() => [{ count: 0 }]),
    ]);

    return successResponse({
      payments: rows,
      meta: paginationMeta(parseInt(cnt?.count ?? '0', 10), page, limit),
    });
  }

  // ── CSV Export ───────────────────────────────────────────────
  async exportCsv(type: 'courses' | 'materials' | 'subscriptions', query: any) {
    let rows: any[] = [];
    let headers: string[] = [];

    if (type === 'courses') {
      rows = await this.db.query(
        `SELECT cp.created_at, u.name AS user, u.mobile, c.title AS course,
                cp.amount, cp.status, cp.provider_order_id, cp.payment_provider
         FROM course_purchases cp
         JOIN users u ON u.id=cp.user_id JOIN courses c ON c.id=cp.course_id
         ORDER BY cp.created_at DESC LIMIT 5000`
      ).catch(() => []);
      headers = ['Date','User','Mobile','Course','Amount','Status','Order ID','Provider'];
    } else if (type === 'materials') {
      rows = await this.db.query(
        `SELECT mp.created_at, u.name AS user, u.mobile, sm.title AS material,
                mp.price_paid AS amount, 'completed' AS status,
                mpo.provider_order_id, mpo.payment_provider
         FROM material_purchases mp
         JOIN users u ON u.id=mp.user_id JOIN study_materials sm ON sm.id=mp.material_id
         LEFT JOIN material_purchase_orders mpo ON mpo.material_id=mp.material_id AND mpo.user_id=mp.user_id AND mpo.status='completed'
         ORDER BY mp.created_at DESC LIMIT 5000`
      ).catch(() => []);
      headers = ['Date','User','Mobile','Material','Amount','Status','Order ID','Provider'];
    } else {
      rows = await this.db.query(
        `SELECT s.created_at, u.name AS user, u.mobile, s.plan, s.final_amount AS amount,
                s.payment_status AS status, s.provider_order_id, s.provider_payment_id, s.payment_provider
         FROM subscriptions s
         JOIN users u ON u.id=s.user_id
         ORDER BY s.created_at DESC LIMIT 5000`
      ).catch(() => []);
      headers = ['Date','User','Mobile','Plan','Amount','Status','Order ID','Payment ID','Provider'];
    }

    const csvLines = [
      headers.join(','),
      ...rows.map((r: any) =>
        Object.values(r).map((v: any) =>
          v == null ? '' : `"${String(v).replace(/"/g, '""')}"`
        ).join(',')
      ),
    ];

    return { csv: csvLines.join('\n'), filename: `payments_${type}_${new Date().toISOString().slice(0,10)}.csv` };
  }
}

@ApiTags('Admin — Payments')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/payments')
class AdminPaymentsController {
  constructor(private readonly svc: AdminPaymentsService) {}

  // GET /admin/payments/dashboard — unified revenue metrics
  @Get('dashboard')
  @RequirePermission('subscriptions')
  getDashboard() { return this.svc.getDashboard(); }

  // GET /admin/payments/courses — course purchase history
  @Get('courses')
  @RequirePermission('subscriptions')
  getCoursePurchases(@Query() q: any) { return this.svc.getCoursePurchases(q); }

  // GET /admin/payments/materials — study material purchase history
  @Get('materials')
  @RequirePermission('subscriptions')
  getMaterialPurchases(@Query() q: any) { return this.svc.getMaterialPurchases(q); }

  // GET /admin/payments/subscriptions — subscription payment history
  @Get('subscriptions')
  @RequirePermission('subscriptions')
  getSubscriptionPayments(@Query() q: any) { return this.svc.getSubscriptionPayments(q); }

  // GET /admin/payments/export?type=courses|materials|subscriptions — CSV download
  @Get('export')
  @RequirePermission('subscriptions')
  async exportCsv(@Query('type') type: 'courses' | 'materials' | 'subscriptions' = 'courses', @Query() q: any, @Res() res: any) {
    const { csv, filename } = await this.svc.exportCsv(type, q);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:      config.get('jwt.adminSecret'),
        signOptions: { expiresIn: config.get('jwt.adminExpiresIn') || '24h' },
      }),
    }),
  ],
  controllers: [
    AdminAuthController,
    AdminDashboardController,
    AdminSettingsController,
    AdminUsersController,
    AppConfigController,
    CategoriesController,
    AdminPaymentSettingsController,
    AdminPaymentsController,
  ],
  providers: [
    AdminAuthService,
    AdminDashboardService,
    AdminSettingsService,
    AdminUsersService,
    PaymentSettingsService,
    AdminPaymentsService,
  ],
  exports: [AdminSettingsService, AdminAuthService],
})
export class AdminModule {}