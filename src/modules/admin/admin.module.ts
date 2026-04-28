// ════════════════════════════════════════════════════════════
// ADMIN MODULE — Login, Dashboard Stats, Settings, Users
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
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
import { IsString, IsEmail, IsNotEmpty, IsOptional, IsArray, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';

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
  @ApiProperty() amount: number;
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
  
    const [users, revenue, subs, content, coins, quizStats, rooms] = await Promise.all([
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
      this.db.query(`
        SELECT
          (SELECT COUNT(*) FROM courses WHERE status='published') AS courses,
          (SELECT COUNT(*) FROM library_notes WHERE status='published') AS notes,
          (SELECT COUNT(*) FROM quizzes WHERE status='published') AS quizzes,
          (SELECT COUNT(*) FROM current_affairs WHERE status='published') AS affairs,
          (SELECT COUNT(*) FROM job_vacancies WHERE status='active') AS jobs
      `),
      this.db.query(`SELECT COALESCE(SUM(amount),0) AS circulation FROM coin_transactions WHERE type='earned'`),
      this.db.query(`
        SELECT
          COUNT(*) AS attempts,
          ROUND(AVG(score)::numeric, 1) AS avg_score
        FROM quiz_attempts WHERE attempted_at > NOW() - INTERVAL '30 days'
      `),
      this.db.query(`SELECT COUNT(*) AS count FROM study_rooms WHERE status='active'`),
    ]);

    console.log(await this.db.query(`SELECT current_database()`));
console.log(await this.db.query(`SELECT * FROM public.users LIMIT 1`));
  
    // 🔍 DEBUG (optional)
    console.log('USERS 👉', users);
  
    const stats = {
      totalUsers:          Number(users?.[0]?.total || 0),
      activeToday:         Number(users?.[0]?.active_today || 0),
      newThisWeek:         Number(users?.[0]?.new_this_week || 0),
      newThisMonth:        Number(users?.[0]?.new_this_month || 0),
  
      totalRevenue:        Number(revenue?.[0]?.total || 0),
      revenueThisMonth:    Number(revenue?.[0]?.this_month || 0),
      revenueLastMonth:    Number(revenue?.[0]?.last_month || 0),
  
      revenueGrowthPct:
        Number(revenue?.[0]?.last_month) > 0
          ? Math.round(
              (Number(revenue?.[0]?.this_month) - Number(revenue?.[0]?.last_month)) /
              Number(revenue?.[0]?.last_month) * 100
            )
          : 0,
  
      activeSubscriptions: Number(subs?.[0]?.active || 0),
  
      totalCourses:        Number(content?.[0]?.courses || 0),
      totalNotes:          Number(content?.[0]?.notes || 0),
      totalQuizzes:        Number(content?.[0]?.quizzes || 0),
      totalAffairs:        Number(content?.[0]?.affairs || 0),
      activeJobs:          Number(content?.[0]?.jobs || 0),
  
      quizAttempts:        Number(quizStats?.[0]?.attempts || 0),
      avgAccuracy:         Number(quizStats?.[0]?.avg_score || 0),
  
      coinCirculation:     Number(coins?.[0]?.circulation || 0),
  
      activeStudyRooms:    Number(rooms?.[0]?.count || 0),
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
               COALESCE(SUM(s.final_amount), 0) AS value
        FROM generate_series(NOW() - INTERVAL '${months - 1} months', NOW(), '1 month') gs
        LEFT JOIN subscriptions s ON DATE_TRUNC('month', s.created_at) = DATE_TRUNC('month', gs)
          AND s.payment_status = 'success'
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
             COUNT(*) AS count,
             COALESCE(SUM(final_amount), 0) AS amount
      FROM subscriptions
      WHERE payment_status = 'success'
      GROUP BY plan ORDER BY amount DESC
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
                    'coin_value_inr','new_registrations','android_store_url','support_email')
    `);
    const config = Object.fromEntries(result.map(r => [r.key, r.value]));
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
    const balResult = await this.db.query(
      `UPDATE users SET coins = coins + $1, total_coins_earned = total_coins_earned + $1 WHERE id = $2 RETURNING coins`,
      [dto.amount, dto.userId]
    );
    if (!balResult.length) throw new NotFoundException('User not found');

    await this.db.query(
      `INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
       VALUES ($1, 'earned', $2, $3, 'admin_award', $4)`,
      [dto.userId, dto.amount, dto.reason || 'Admin award', balResult[0].coins]
    );
    await this.cache.del(`user:${dto.userId}`);
    return { newBalance: balResult[0].coins };
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

  async updateAdmin(adminId: string, data: { permissions?: string[]; status?: string }) {
    await this.db.query(
      `UPDATE admin_users SET permissions=COALESCE($1,permissions), status=COALESCE($2,status), updated_at=NOW() WHERE id=$3`,
      [data.permissions, data.status, adminId]
    );
  }

  async deactivateAdmin(adminId: string, currentAdminId: string) {
    if (adminId === currentAdminId) throw new BadRequestException('Cannot deactivate your own account');
    await this.db.query(`UPDATE admin_users SET status='inactive' WHERE id=$1`, [adminId]);
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
  async login(@Body() dto: AdminLoginDto) {
    const data = await this.adminAuthService.login(dto.email, dto.password);
    return successResponse(data, 'Welcome back!');
  }
}

@ApiTags('Admin — Dashboard')
@ApiBearerAuth()
// @Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin')
export class AdminDashboardController {
  constructor(private readonly service: AdminDashboardService) {}

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
    return successResponse({ users: rows }, 'Success', paginationMeta(query.page || 1, query.page || 1, query.limit || 20));
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
  @RequirePermission('coins')
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
  ],
  providers: [
    AdminAuthService,
    AdminDashboardService,
    AdminSettingsService,
    AdminUsersService,
  ],
  exports: [AdminSettingsService, AdminAuthService],
})
export class AdminModule {}
