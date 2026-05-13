import {
  Module, Injectable, Controller,
  Get, Post,
  Body, Query, Req, Param,
  HttpCode, HttpStatus,
  UseGuards, ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { InjectDataSource }        from '@nestjs/typeorm';
import { DataSource }              from 'typeorm';
import { CACHE_MANAGER }           from '@nestjs/cache-manager';
import { Cache }                   from 'cache-manager';
import { Inject }                  from '@nestjs/common';
import { ApiTags, ApiBearerAuth }  from '@nestjs/swagger';
import {
  JwtAuthGuard, AdminJwtGuard,
  PermissionGuard, RequirePermission, Public,
} from '../../common/guards';
import { successResponse } from '../../common/utils/response.util';
import { AuthModule, AuthService } from '../auth/auth.module';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/achievements/achievements.module.ts
//
// AchievementsService   — check + award achievements after events
// WeeklyChallengesService — CRUD + progress tracking
// Controllers           — user + admin endpoints
// ════════════════════════════════════════════════════════════

// ── Achievement condition types ───────────────────────────────
// { type: "study_hours",  threshold: 10 }
// { type: "streak_days",  threshold: 7 }
// { type: "quizzes",      threshold: 50 }
// { type: "goals",        threshold: 10 }
// { type: "tier_reach",   tier_key: "gold" }
// { type: "coins",        threshold: 1000 }

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly authService: AuthService,
  ) {}

  // ── GET all achievements with user's earned status ─────────
  async findAll(userId: string) {
    const cacheKey = `achievements:user:${userId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.db.query(`
      SELECT
        at.id, at.key, at.title, at.description,
        at.emoji, at.category, at.condition,
        at.coins_reward, at.xp_reward,
        at.sort_order, at.is_active,
        ua.earned_at,
        (ua.id IS NOT NULL) AS is_earned
      FROM achievement_types at
      LEFT JOIN user_achievements ua
        ON ua.achievement_type_id = at.id AND ua.user_id = $1
      WHERE at.is_active = TRUE
      ORDER BY at.category ASC, at.sort_order ASC
    `, [userId]);

    const grouped = rows.reduce((acc: any, row: any) => {
      const cat = row.category;
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(row);
      return acc;
    }, {});

    const result = successResponse({
      achievements:  rows,
      grouped,
      earnedCount:   rows.filter((r: any) => r.is_earned).length,
      totalCount:    rows.length,
    });
    await this.cache.set(cacheKey, result, 300);
    return result;
  }

  // ── GET recently earned achievements ─────────────────────────
  async getRecent(userId: string, limit = 5) {
    const rows = await this.db.query(`
      SELECT
        at.id, at.key, at.title, at.description,
        at.emoji, at.category, at.coins_reward, at.xp_reward,
        ua.earned_at
      FROM user_achievements ua
      JOIN achievement_types at ON at.id = ua.achievement_type_id
      WHERE ua.user_id = $1
      ORDER BY ua.earned_at DESC
      LIMIT $2
    `, [userId, limit]);

    return successResponse({ achievements: rows });
  }

  // ── Called after any user event to check + award achievements ─
  // Events: 'study_session_end', 'streak_update', 'quiz_complete',
  //         'goal_complete', 'tier_promotion'
  async checkAndAward(userId: string, event: string, payload: any = {}): Promise<string[]> {
    const awarded: string[] = [];

    // Get user's current stats
    const userRows = await this.db.query(`
      SELECT
        u.total_study_minutes, u.streak, u.quizzes_attempted,
        u.total_coins_earned, u.room_tier_id,
        t.tier_key,
        (SELECT COUNT(*) FROM daily_targets
         WHERE user_id = u.id AND is_completed = TRUE)::int AS goals_completed
      FROM users u
      LEFT JOIN room_tiers t ON t.id = u.room_tier_id
      WHERE u.id = $1
    `, [userId]);
    if (!userRows.length) return [];

    const u               = userRows[0];
    const totalStudyHours = (u.total_study_minutes || 0) / 60;

    // Get all active achievement types user hasn't earned yet
    const pending = await this.db.query(`
      SELECT at.id, at.key, at.condition, at.coins_reward, at.xp_reward, at.title
      FROM achievement_types at
      WHERE at.is_active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM user_achievements ua
          WHERE ua.user_id = $1 AND ua.achievement_type_id = at.id
        )
    `, [userId]);

    for (const ach of pending) {
      const cond      = ach.condition;
      let   satisfied = false;

      switch (cond.type) {
        case 'study_hours':
          satisfied = totalStudyHours >= cond.threshold;
          break;
        case 'streak_days':
          satisfied = (u.streak || 0) >= cond.threshold;
          break;
        case 'quizzes':
          satisfied = (u.quizzes_attempted || 0) >= cond.threshold;
          break;
        case 'goals':
          satisfied = (u.goals_completed || 0) >= cond.threshold;
          break;
        case 'tier_reach':
          satisfied = u.tier_key === cond.tier_key ||
            this.tierOrder(u.tier_key) >= this.tierOrder(cond.tier_key);
          break;
        case 'coins':
          satisfied = (u.total_coins_earned || 0) >= cond.threshold;
          break;
      }

      if (satisfied) {
        await this.awardAchievement(userId, ach);
        awarded.push(ach.key);
      }
    }

    if (awarded.length > 0) {
      await this.cache.del(`achievements:user:${userId}`);
      this.logger.log(`Awarded achievements to user=${userId}: ${awarded.join(', ')}`);
    }
    return awarded;
  }

  private tierOrder(tierKey: string): number {
    return { silver: 1, gold: 2, premium: 3, diamond: 4 }[tierKey] || 0;
  }

  private async awardAchievement(userId: string, ach: any) {
    try {
      await this.db.query(`
        INSERT INTO user_achievements (user_id, achievement_type_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [userId, ach.id]);

      if (ach.coins_reward > 0) {
        await this.authService.awardCoins(userId, 'achievement', ach.id);
      }
      if (ach.xp_reward > 0) {
        await this.db.query(
          `UPDATE users SET xp = xp + $1 WHERE id = $2`, [ach.xp_reward, userId]
        );
      }
    } catch (e: any) {
      // ON CONFLICT handles duplicates — log others
      if (!e.message?.includes('duplicate')) {
        this.logger.error(`awardAchievement failed: ${e.message}`);
      }
    }
  }

  // ── Admin: list all achievement types ──────────────────────
  async adminFindAll() {
    const rows = await this.db.query(`
      SELECT
        at.*,
        COUNT(ua.id)::int AS earned_count
      FROM achievement_types at
      LEFT JOIN user_achievements ua ON ua.achievement_type_id = at.id
      GROUP BY at.id
      ORDER BY at.category, at.sort_order
    `);
    return successResponse({ achievements: rows });
  }

  // ── Admin: create achievement type ─────────────────────────
  async adminCreate(data: any) {
    const result = await this.db.query(`
      INSERT INTO achievement_types
        (key, title, description, emoji, category, condition,
         coins_reward, xp_reward, sort_order, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      data.key, data.title, data.description,
      data.emoji || '🏅', data.category || 'study',
      JSON.stringify(data.condition),
      data.coinsReward || 0, data.xpReward || 0,
      data.sortOrder   || 0, data.isActive !== false,
    ]);
    return successResponse({ achievement: result[0] }, 'Achievement created ✅');
  }

  // ── Admin: toggle is_active ─────────────────────────────────
  async adminToggle(id: string, isActive: boolean) {
    await this.db.query(
      `UPDATE achievement_types SET is_active=$1 WHERE id=$2`, [isActive, id]
    );
    return successResponse(null, 'Updated ✅');
  }
}


// ═════════════════════════════════════════════════════════════
// WEEKLY CHALLENGES SERVICE
// ═════════════════════════════════════════════════════════════
@Injectable()
export class WeeklyChallengesService {
  private readonly logger = new Logger(WeeklyChallengesService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly authService: AuthService,
  ) {}

  // ── GET current week's challenges + user progress ─────────
  async getCurrent(userId: string) {
    const periodKey = this.currentWeekKey();
    const cacheKey  = `challenges:${periodKey}:${userId}`;
    const cached    = await this.cache.get(cacheKey);
    if (cached) return cached;

    const challenges = await this.db.query(`
      SELECT
        wc.*,
        t.tier_key AS target_tier_key,
        t.icon_emoji AS target_tier_emoji,
        COALESCE(ucp.current_value, 0)  AS user_progress,
        COALESCE(ucp.is_completed, false) AS is_completed,
        COALESCE(ucp.reward_claimed, false) AS reward_claimed,
        ucp.completed_at
      FROM weekly_challenges wc
      LEFT JOIN room_tiers t  ON t.id  = wc.target_tier_id
      LEFT JOIN user_challenge_progress ucp
        ON ucp.challenge_id = wc.id AND ucp.user_id = $1
      WHERE wc.period_key = $2 AND wc.is_active = TRUE
      ORDER BY wc.created_at ASC
    `, [userId, periodKey]);

    // Compute percentage progress for UI
    const enriched = challenges.map((c: any) => ({
      ...c,
      progress_pct: c.goal?.target > 0
        ? Math.min(100, Math.round((c.user_progress / c.goal.target) * 100))
        : 0,
    }));

    const result = successResponse({
      challenges:  enriched,
      periodKey,
      weekLabel:   this.weekLabel(),
    });
    await this.cache.set(cacheKey, result, 120);
    return result;
  }

  // ── Claim reward after completing a challenge ─────────────
  async claimReward(userId: string, challengeId: string) {
    const rows = await this.db.query(`
      SELECT ucp.*, wc.coins_reward, wc.xp_reward, wc.title
      FROM user_challenge_progress ucp
      JOIN weekly_challenges wc ON wc.id = ucp.challenge_id
      WHERE ucp.user_id=$1 AND ucp.challenge_id=$2
    `, [userId, challengeId]);

    if (!rows.length || !rows[0].is_completed) {
      return successResponse(null, 'Challenge not completed yet');
    }
    if (rows[0].reward_claimed) {
      return successResponse(null, 'Reward already claimed');
    }

    const ch = rows[0];
    await this.db.query(
      `UPDATE user_challenge_progress SET reward_claimed=TRUE WHERE user_id=$1 AND challenge_id=$2`,
      [userId, challengeId]
    );
    if (ch.coins_reward > 0) {
      await this.authService.awardCoins(userId, 'weekly_challenge', challengeId);
    }
    if (ch.xp_reward > 0) {
      await this.db.query(`UPDATE users SET xp=xp+$1 WHERE id=$2`, [ch.xp_reward, userId]);
    }

    await this.cache.del(`challenges:${this.currentWeekKey()}:${userId}`);
    return successResponse({
      coinsRewarded: ch.coins_reward,
      xpRewarded:    ch.xp_reward,
    }, `🎉 +${ch.coins_reward} coins claimed!`);
  }

  // ── Called after events to increment challenge progress ────
  // eventType: 'study_minutes' | 'quiz_complete' | 'goal_complete'
  //            | 'streak_days' | 'sessions'
  async updateProgress(userId: string, eventType: string, amount: number) {
    const periodKey = this.currentWeekKey();

    // Find active challenges this user hasn't completed that match the event type
    const challenges = await this.db.query(`
      SELECT wc.id, wc.goal, wc.coins_reward, wc.xp_reward,
             COALESCE(ucp.current_value, 0) AS current_value,
             COALESCE(ucp.is_completed, false) AS is_completed
      FROM weekly_challenges wc
      LEFT JOIN user_challenge_progress ucp
        ON ucp.challenge_id = wc.id AND ucp.user_id = $1
      LEFT JOIN user_room_tier urt ON urt.user_id = $1
      WHERE wc.period_key   = $2
        AND wc.is_active    = TRUE
        AND (wc.target_tier_id IS NULL OR wc.target_tier_id = urt.current_tier_id)
        AND COALESCE(ucp.is_completed, false) = FALSE
    `, [userId, periodKey]);

    for (const ch of challenges) {
      const goalType = ch.goal?.type;
      // Map event type to goal type
      const matches =
        (eventType === 'study_minutes' && goalType === 'study_hours') ||
        (eventType === 'study_minutes' && goalType === 'study_minutes') ||
        (eventType === 'quiz_complete' && goalType === 'quizzes') ||
        (eventType === 'goal_complete' && goalType === 'goals') ||
        (eventType === 'sessions'      && goalType === 'sessions') ||
        (eventType === 'streak_days'   && goalType === 'streak_days');

      if (!matches) continue;

      // Normalize to goal unit
      const increment = goalType === 'study_hours' ? amount / 60 : amount;
      const newValue  = parseFloat(ch.current_value) + increment;
      const target    = ch.goal?.target || 1;
      const done      = newValue >= target;

      await this.db.query(`
        INSERT INTO user_challenge_progress
          (user_id, challenge_id, current_value, is_completed, completed_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, challenge_id) DO UPDATE SET
          current_value = $3,
          is_completed  = $4,
          completed_at  = COALESCE(user_challenge_progress.completed_at, $5)
      `, [userId, ch.id, newValue, done, done ? new Date() : null]);

      await this.cache.del(`challenges:${periodKey}:${userId}`);
    }
  }

  // ── Admin: get all challenges ──────────────────────────────
  async adminFindAll(query: any) {
    const { week } = query;
    const rows = await this.db.query(`
      SELECT wc.*,
        t.name AS target_tier_name, t.icon_emoji AS target_tier_emoji,
        COUNT(DISTINCT ucp.user_id) FILTER (WHERE ucp.is_completed)::int AS completions
      FROM weekly_challenges wc
      LEFT JOIN room_tiers t ON t.id = wc.target_tier_id
      LEFT JOIN user_challenge_progress ucp ON ucp.challenge_id = wc.id
      WHERE ($1::text IS NULL OR wc.period_key = $1)
      GROUP BY wc.id, t.name, t.icon_emoji
      ORDER BY wc.period_key DESC, wc.created_at ASC
    `, [week || null]);
    return successResponse({ challenges: rows });
  }

  // ── Admin: create challenge ────────────────────────────────
  async adminCreate(data: any) {
    const periodKey = data.periodKey || this.currentWeekKey();
    const result    = await this.db.query(`
      INSERT INTO weekly_challenges
        (title, description, emoji, period_key, target_tier_id, goal, coins_reward, xp_reward, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      data.title, data.description || '', data.emoji || '🎯',
      periodKey,
      data.targetTierId || null,
      JSON.stringify(data.goal),
      data.coinsReward || 0,
      data.xpReward    || 0,
      data.isActive !== false,
    ]);
    return successResponse({ challenge: result[0] }, 'Challenge created ✅');
  }

  // ── Admin: toggle active ───────────────────────────────────
  async adminToggle(id: string, isActive: boolean) {
    await this.db.query(
      `UPDATE weekly_challenges SET is_active=$1 WHERE id=$2`, [isActive, id]
    );
    return successResponse(null, 'Updated ✅');
  }

  // ── Helpers ───────────────────────────────────────────────
  private currentWeekKey(): string {
    const now   = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const week  = Math.ceil(
      ((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7
    );
    return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  private weekLabel(): string {
    const now     = new Date();
    const monday  = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const sunday  = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const fmt     = (d: Date) =>
      d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return `${fmt(monday)} – ${fmt(sunday)}`;
  }
}


// ═════════════════════════════════════════════════════════════
// USER CONTROLLERS
// ═════════════════════════════════════════════════════════════
@ApiTags('Achievements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('achievements')
export class AchievementsController {
  constructor(private readonly svc: AchievementsService) {}

  /** GET /achievements — all achievements with earned status */
  @Get()
  findAll(@Req() r: any) { return this.svc.findAll(r.user.id); }

  /** GET /achievements/recent — last 5 earned */
  @Get('recent')
  recent(@Req() r: any, @Query('limit') limit = 5) {
    return this.svc.getRecent(r.user.id, +limit);
  }
}

@ApiTags('Challenges')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('challenges')
export class ChallengesController {
  constructor(private readonly svc: WeeklyChallengesService) {}

  /** GET /challenges/current — this week's challenges + progress */
  @Get('current')
  getCurrent(@Req() r: any) { return this.svc.getCurrent(r.user.id); }

  /** POST /challenges/:id/claim — claim reward */
  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @Req() r: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) { return this.svc.claimReward(r.user.id, id); }
}


// ═════════════════════════════════════════════════════════════
// ADMIN CONTROLLERS
// ═════════════════════════════════════════════════════════════
@ApiTags('Admin — Achievements')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/achievements')
export class AdminAchievementsController {
  constructor(private readonly svc: AchievementsService) {}

  @Get()    @RequirePermission('library') adminList() { return this.svc.adminFindAll(); }
  @Post()   @RequirePermission('library') @HttpCode(201) adminCreate(@Body() dto: any) { return this.svc.adminCreate(dto); }
  @Post(':id/toggle') @RequirePermission('library') @HttpCode(200)
  adminToggle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.svc.adminToggle(id, dto.isActive);
  }
}

@ApiTags('Admin — Challenges')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/challenges')
export class AdminChallengesController {
  constructor(private readonly svc: WeeklyChallengesService) {}

  @Get()    @RequirePermission('study-rooms') adminList(@Query() q: any) { return this.svc.adminFindAll(q); }
  @Post()   @RequirePermission('study-rooms') @HttpCode(201) adminCreate(@Body() dto: any) { return this.svc.adminCreate(dto); }
  @Post(':id/toggle') @RequirePermission('study-rooms') @HttpCode(200)
  adminToggle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.svc.adminToggle(id, dto.isActive);
  }
}


// ═════════════════════════════════════════════════════════════
// MODULE
// ═════════════════════════════════════════════════════════════
@Module({
  imports: [AuthModule],
  controllers: [
    AchievementsController,
    ChallengesController,
    AdminAchievementsController,
    AdminChallengesController,
  ],
  providers: [AchievementsService, WeeklyChallengesService],
  exports:   [AchievementsService, WeeklyChallengesService],
})
export class AchievementsModule {}
