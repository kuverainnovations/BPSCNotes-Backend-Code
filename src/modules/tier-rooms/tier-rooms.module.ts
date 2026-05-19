import {
  Module, Injectable, Controller,
  Get, Post, Put,
  Body, Param, Query, Req,
  HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ConflictException,
  UseGuards, ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { InjectDataSource }        from '@nestjs/typeorm';
import { DataSource }              from 'typeorm';
import { CACHE_MANAGER }           from '@nestjs/cache-manager';
import { Cache }                   from 'cache-manager';
import { Inject }                  from '@nestjs/common';
import { Cron }                    from '@nestjs/schedule';
import { ScheduleModule }          from '@nestjs/schedule';
import { ApiTags, ApiBearerAuth }  from '@nestjs/swagger';
import { AuthModule, AuthService } from '../auth/auth.module';
import {
  JwtAuthGuard, AdminJwtGuard,
  PermissionGuard, RequirePermission, Public,
} from '../../common/guards';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { TierNotificationsService } from './tier-notifications.service';
import { TierRoomsGateway }       from './tier-rooms.gateway';
import { AntiCheatService }       from './anti-cheat.service';
import { JwtModule } from '@nestjs/jwt';

// ============================================================
// TIER ROOMS SERVICE
// ============================================================
@Injectable()
export class TierRoomsService {
  private readonly logger = new Logger(TierRoomsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAllTiers() {
    const cacheKey = 'tier_rooms:all';
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const tiers = await this.db.query(`
      SELECT
        t.*,
        COUNT(DISTINCT urt.user_id)::int AS total_members,
        COUNT(DISTINCT ss.id)::int       AS active_sessions
      FROM room_tiers t
      LEFT JOIN user_room_tier urt ON urt.current_tier_id = t.id
      LEFT JOIN study_sessions ss  ON ss.tier_id = t.id AND ss.ended_at IS NULL
      WHERE t.is_active = TRUE
      GROUP BY t.id
      ORDER BY t.sort_order ASC
    `);
    const result = successResponse({ tiers });
    await this.cache.set(cacheKey, result, 60);
    return result;
  }

  async getMyTier(userId: string) {
    const cacheKey = `user_tier:${userId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.db.query(`
      SELECT
        urt.next_tier_progress, urt.promoted_at, urt.tier_joined_at,
        urt.demotion_grace_until, urt.last_evaluated_at,
        ct.id AS tier_id, ct.tier_key, ct.name AS tier_name,
        ct.description AS tier_description, ct.color_hex, ct.icon_emoji,
        ct.sort_order, ct.coin_multiplier, ct.xp_multiplier, ct.perks, ct.max_members,
        nt.id AS next_tier_id, nt.tier_key AS next_tier_key,
        nt.name AS next_tier_name, nt.icon_emoji AS next_tier_emoji,
        tpr.min_total_study_hours, tpr.min_streak_days,
        tpr.min_quizzes_completed, tpr.min_accuracy_pct,
        u.total_study_minutes, u.streak, u.quizzes_attempted,
        u.accuracy, u.xp, u.xp_level, u.coins,
        (SELECT COUNT(*) FROM user_room_tier WHERE current_tier_id = ct.id)::int AS tier_member_count,
        (SELECT COUNT(*) FROM study_sessions WHERE tier_id = ct.id AND ended_at IS NULL)::int AS active_now
      FROM user_room_tier urt
      JOIN room_tiers ct ON ct.id = urt.current_tier_id
      JOIN users u       ON u.id  = urt.user_id
      LEFT JOIN room_tiers nt
        ON nt.sort_order = ct.sort_order + 1 AND nt.is_active = TRUE
      LEFT JOIN tier_progression_rules tpr
        ON tpr.from_tier_id = ct.id AND tpr.to_tier_id = nt.id AND tpr.is_active = TRUE
      WHERE urt.user_id = $1
    `, [userId]);

    if (!rows.length) {
      await this.assignDefaultTier(userId);
      return this.getMyTier(userId);
    }

    const row             = rows[0];
    const totalStudyHours = (row.total_study_minutes || 0) / 60;
    const progressItems: any[] = [];

    if (row.min_total_study_hours > 0) {
      progressItems.push({
        label: 'Study Hours', current: +totalStudyHours.toFixed(1),
        required: +row.min_total_study_hours, unit: 'h',
        done: totalStudyHours >= row.min_total_study_hours,
      });
    }
    if (row.min_streak_days > 0) {
      progressItems.push({
        label: 'Streak', current: row.streak || 0,
        required: row.min_streak_days, unit: 'days',
        done: (row.streak || 0) >= row.min_streak_days,
      });
    }
    if (row.min_quizzes_completed > 0) {
      progressItems.push({
        label: 'Quizzes', current: row.quizzes_attempted || 0,
        required: row.min_quizzes_completed, unit: 'quizzes',
        done: (row.quizzes_attempted || 0) >= row.min_quizzes_completed,
      });
    }
    if (row.min_accuracy_pct > 0) {
      progressItems.push({
        label: 'Accuracy', current: +parseFloat(row.accuracy || '0').toFixed(1),
        required: +row.min_accuracy_pct, unit: '%',
        done: parseFloat(row.accuracy || '0') >= parseFloat(row.min_accuracy_pct),
      });
    }

    const data = {
      currentTier: {
        id: row.tier_id, tierKey: row.tier_key, name: row.tier_name,
        description: row.tier_description, colorHex: row.color_hex,
        iconEmoji: row.icon_emoji, sortOrder: row.sort_order,
        coinMultiplier: +row.coin_multiplier, xpMultiplier: +row.xp_multiplier,
        perks: row.perks, memberCount: row.tier_member_count, activeNow: row.active_now,
      },
      nextTier: row.next_tier_id ? {
        id: row.next_tier_id, tierKey: row.next_tier_key,
        name: row.next_tier_name, iconEmoji: row.next_tier_emoji,
      } : null,
      promotedAt:       row.promoted_at,
      nextTierProgress: +parseFloat(row.next_tier_progress || '0'),
      progressItems,
      demotionGraceUntil: row.demotion_grace_until,
      userStats: {
        totalStudyHours: +totalStudyHours.toFixed(2),
        streak: row.streak || 0, quizzesAttempted: row.quizzes_attempted || 0,
        accuracy: +parseFloat(row.accuracy || '0').toFixed(2),
        xp: row.xp || 0, xpLevel: row.xp_level || 1, coins: row.coins || 0,
      },
    };
    const result = successResponse(data);
    await this.cache.set(cacheKey, result, 120);
    return result;
  }

  async getTierMembers(tierKey: string, query: any) {
    const { page = 1, limit = 20 } = query;
    const offset = (page - 1) * limit;
    const [members, countResult] = await Promise.all([
      this.db.query(`
        SELECT u.id, u.name, u.streak, u.quizzes_attempted, u.accuracy,
               u.coins, u.xp, u.xp_level, u.total_study_minutes,
               urt.promoted_at, urt.next_tier_progress,
               EXISTS(SELECT 1 FROM study_sessions WHERE user_id=u.id AND ended_at IS NULL) AS is_studying_now
        FROM user_room_tier urt
        JOIN users u ON u.id = urt.user_id
        JOIN room_tiers t ON t.id = urt.current_tier_id
        WHERE t.tier_key=$1 AND u.status='active'
        ORDER BY u.xp DESC, u.streak DESC
        LIMIT $2 OFFSET $3
      `, [tierKey, limit, offset]),
      this.db.query(
        `SELECT COUNT(*) FROM user_room_tier urt
         JOIN room_tiers t ON t.id=urt.current_tier_id WHERE t.tier_key=$1`, [tierKey]
      ),
    ]);
    return successResponse({ members }, 'Success', paginationMeta(+countResult[0].count, +page, +limit));
  }

  async getLeaderboard(tierKey: string, period: string = 'weekly') {
    const periodKey = this.getCurrentPeriodKey(period);
    const cacheKey  = `leaderboard:${tierKey}:${period}:${periodKey}`;
    const cached    = await this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.db.query(`
      SELECT rl.rank_position, rl.study_minutes, rl.coins_earned, rl.xp_earned,
             rl.goals_completed, rl.streak_days,
             u.id AS user_id, u.name AS user_name, u.xp_level
      FROM room_leaderboard rl
      JOIN users u      ON u.id  = rl.user_id
      JOIN room_tiers t ON t.id  = rl.tier_id
      WHERE t.tier_key=$1 AND rl.period_type=$2 AND rl.period_key=$3
      ORDER BY rl.rank_position ASC
      LIMIT 100
    `, [tierKey, period, periodKey]);

    const result = successResponse({ leaderboard: rows, period, periodKey });
    await this.cache.set(cacheKey, result, 300);
    return result;
  }

  async assignDefaultTier(userId: string) {
    const silver = await this.db.query(
      `SELECT id FROM room_tiers WHERE tier_key='silver' AND is_active=TRUE LIMIT 1`
    );
    if (!silver.length) throw new NotFoundException('Silver tier not found. Run migration.');
    await this.db.query(
      `INSERT INTO user_room_tier (user_id, current_tier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, silver[0].id]
    );
    await this.db.query(`UPDATE users SET room_tier_id=$1 WHERE id=$2`, [silver[0].id, userId]);
  }

  async adminFindAllTiers() {
    const tiers = await this.db.query(`
      SELECT t.*,
        COUNT(DISTINCT urt.user_id)::int AS total_members,
        COUNT(DISTINCT ss.id)::int       AS active_sessions_7d,
        COALESCE(AVG(ss.duration_minutes),0)::int AS avg_session_minutes
      FROM room_tiers t
      LEFT JOIN user_room_tier urt ON urt.current_tier_id = t.id
      LEFT JOIN study_sessions ss  ON ss.tier_id = t.id AND ss.started_at > NOW()-INTERVAL '7 days'
      GROUP BY t.id ORDER BY t.sort_order ASC
    `);
    return successResponse({ tiers });
  }

  async adminUpdateTier(tierId: string, data: any) {
    const allowed = ['name','description','color_hex','icon_emoji','max_members',
                     'coin_multiplier','xp_multiplier','perks','is_active'];
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key}=$${i++}`);
        vals.push(key === 'perks' ? JSON.stringify(data[key]) : data[key]);
      }
    }
    if (!fields.length) throw new BadRequestException('No valid fields');
    fields.push('updated_at=NOW()');
    await this.db.query(`UPDATE room_tiers SET ${fields.join(',')} WHERE id=$${i}`, [...vals, tierId]);
    await this.cache.del('tier_rooms:all');
    return successResponse(null, 'Tier updated');
  }

  async adminGetRules() {
    const rules = await this.db.query(`
      SELECT tpr.*, ft.tier_key AS from_key, ft.name AS from_name,
             tt.tier_key AS to_key, tt.name AS to_name
      FROM tier_progression_rules tpr
      JOIN room_tiers ft ON ft.id=tpr.from_tier_id
      JOIN room_tiers tt ON tt.id=tpr.to_tier_id
      ORDER BY ft.sort_order ASC
    `);
    return successResponse({ rules });
  }

  async adminUpdateRule(ruleId: string, data: any) {
    const allowed = ['min_total_study_hours','min_streak_days','min_weekly_study_hours',
      'min_quizzes_completed','min_goals_completed','min_coins_earned_total',
      'min_accuracy_pct','evaluation_window_days','demotion_threshold_pct',
      'demotion_grace_days','is_active'];
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    for (const key of allowed) {
      if (data[key] !== undefined) { fields.push(`${key}=$${i++}`); vals.push(data[key]); }
    }
    if (!fields.length) throw new BadRequestException('No valid fields');
    fields.push('updated_at=NOW()');
    await this.db.query(`UPDATE tier_progression_rules SET ${fields.join(',')} WHERE id=$${i}`, [...vals, ruleId]);
    return successResponse(null, 'Rule updated');
  }

  async adminPromoteUser(userId: string, targetTierKey: string) {
    const tier = await this.db.query(
      `SELECT id FROM room_tiers WHERE tier_key=$1 AND is_active=TRUE LIMIT 1`, [targetTierKey]
    );
    if (!tier.length) throw new NotFoundException(`Tier not found: ${targetTierKey}`);
    const prev = await this.db.query(`SELECT current_tier_id FROM user_room_tier WHERE user_id=$1`, [userId]);
    await this.db.query(`
      UPDATE user_room_tier
      SET current_tier_id=$1, previous_tier_id=$2, promoted_at=NOW(),
          next_tier_progress=0.0000, updated_at=NOW()
      WHERE user_id=$3
    `, [tier[0].id, prev[0]?.current_tier_id || null, userId]);
    await this.db.query(`UPDATE users SET room_tier_id=$1 WHERE id=$2`, [tier[0].id, userId]);
    await this.cache.del(`user_tier:${userId}`);
    return successResponse(null, `User promoted to ${targetTierKey}`);
  }

  async adminTierDistribution() {
    const rows = await this.db.query(`
      SELECT t.tier_key, t.name, t.icon_emoji, t.color_hex,
        COUNT(urt.user_id)::int AS member_count,
        ROUND(COUNT(urt.user_id)*100.0/NULLIF(SUM(COUNT(urt.user_id)) OVER(),0),2) AS percentage
      FROM room_tiers t
      LEFT JOIN user_room_tier urt ON urt.current_tier_id=t.id
      WHERE t.is_active=TRUE GROUP BY t.id ORDER BY t.sort_order ASC
    `);
    return successResponse({ distribution: rows });
  }

  // ── GET "at risk" demotion status for calling user ──────────
  // Returns: { isAtRisk, progress, threshold, tierKey, graceUntil }
  // Called by Android on app resume to show the warning banner.
  async getAtRiskStatus(userId: string) {
    const rows = await this.db.query(`
      SELECT
        urt.next_tier_progress,
        urt.demotion_grace_until,
        ct.tier_key, ct.name AS tier_name, ct.icon_emoji,
        ct.sort_order,
        tpr.demotion_threshold_pct
      FROM user_room_tier urt
      JOIN room_tiers ct ON ct.id = urt.current_tier_id
      LEFT JOIN tier_progression_rules tpr
        ON tpr.from_tier_id = ct.id AND tpr.is_active = TRUE
      WHERE urt.user_id = $1
    `, [userId]);

    if (!rows.length) return successResponse({ isAtRisk: false });
    const row       = rows[0];
    const progress  = parseFloat(row.next_tier_progress || '0');
    const threshold = parseFloat(row.demotion_threshold_pct || '50') / 100;
    const inGrace   = row.demotion_grace_until && new Date(row.demotion_grace_until) > new Date();
    const isAtRisk  = row.sort_order > 1 && !inGrace && progress < threshold;

    return successResponse({
      isAtRisk,
      progress:           parseFloat((progress * 100).toFixed(1)),
      threshold:          parseFloat((threshold * 100).toFixed(1)),
      tierKey:            row.tier_key,
      tierName:           row.tier_name,
      tierEmoji:          row.icon_emoji,
      demotionGraceUntil: row.demotion_grace_until,
    });
  }

  getCurrentPeriodKey(period: string): string {
    const now = new Date();
    if (period === 'weekly') {
      const start = new Date(now.getFullYear(), 0, 1);
      const w = Math.ceil(((now.getTime()-start.getTime())/86400000+start.getDay()+1)/7);
      return `${now.getFullYear()}-W${String(w).padStart(2,'0')}`;
    }
    if (period === 'monthly')
      return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    return 'alltime';
  }
}

// ============================================================
// STUDY SESSIONS SERVICE
// ============================================================
@Injectable()
export class StudySessionsService {
  private readonly logger            = new Logger(StudySessionsService.name);
  private readonly BASE_COINS_PER_HOUR = 6;
  private readonly BASE_XP_PER_MINUTE  = 1;
  private readonly HEARTBEAT_INTERVAL_S = 300;
  private readonly AFK_THRESHOLD_S     = 420;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly authService: AuthService,
    private readonly notifService: TierNotificationsService,
    private readonly gateway: TierRoomsGateway,
    private readonly antiCheat: AntiCheatService,
  ) {}

  async startSession(userId: string, roomId?: string, mode: string = 'study') {
    // ── Anti-cheat: session start checks ──────────────────
    const startCheck = await this.antiCheat.checkSessionStart(userId);
    if (startCheck.result === 'BLOCK') {
      throw new BadRequestException(startCheck.reason || 'Session blocked');
    }

    const existing = await this.db.query(
      `SELECT id FROM study_sessions WHERE user_id=$1 AND ended_at IS NULL LIMIT 1`, [userId]
    );
    if (existing.length) {
      throw new ConflictException(`Active session exists (${existing[0].id}). End it first.`);
    }
    const tierRow = await this.db.query(`
      SELECT t.id AS tier_id, t.tier_key FROM user_room_tier urt
      JOIN room_tiers t ON t.id=urt.current_tier_id WHERE urt.user_id=$1
    `, [userId]);
    const tierId = tierRow[0]?.tier_id || null;
    const validModes = ['study','pomodoro','silent'];
    const sessionMode = validModes.includes(mode) ? mode : 'study';

    // ── Anti-cheat: block session velocity + concurrent session abuse ──
    const acStart = await this.antiCheat.checkSessionStart(userId);
    if (acStart.result === 'BLOCK') {
      throw new BadRequestException(`Session blocked: ${acStart.reason}. ${acStart.details?.message || ''}`);
    }

    const session = await this.db.query(`
      INSERT INTO study_sessions (user_id, room_id, tier_id, mode, last_heartbeat)
      VALUES ($1,$2,$3,$4,NOW()) RETURNING id, started_at, mode, tier_id
    `, [userId, roomId || null, tierId, sessionMode]);

    // Track in Redis for fast concurrent-session detection


    this.logger.log(`Session started: user=${userId} id=${session[0].id}`);

    // Broadcast presence update + member_joined event so other users see
    // the new member immediately (without waiting 30s for polling refresh)
    if (tierRow[0]?.tier_key) {
      const tierKey = tierRow[0].tier_key;
      // Get user's name for the member_joined broadcast
      const [userRow] = await this.db.query(`SELECT name FROM users WHERE id=$1`, [userId]);
      const userName  = userRow?.name ?? 'Member';
      // Emit presence update (updates count in lobby)
      this.gateway['broadcastPresenceUpdate'](tierKey);
      // Emit member_joined (updates members list in StudyFocusScreen immediately)
      this.gateway.server?.to(`tier:${tierKey}`).emit('room:member_joined', {
        tierKey, userId, userName,
      });
    }

    return successResponse({
      sessionId: session[0].id, startedAt: session[0].started_at,
      mode: session[0].mode, tierId: session[0].tier_id,
      heartbeatIntervalSeconds: this.HEARTBEAT_INTERVAL_S,
    }, 'Study session started. Send heartbeat every 5 minutes.');
  }

  async heartbeat(sessionId: string, userId: string) {
    const sessions = await this.db.query(`
      SELECT ss.id, ss.user_id, ss.tier_id, ss.active_minutes, ss.afk_count,
             ss.coins_earned, ss.xp_earned, ss.last_heartbeat,
             t.coin_multiplier, t.xp_multiplier
      FROM study_sessions ss
      LEFT JOIN room_tiers t ON t.id=ss.tier_id
      WHERE ss.id=$1 AND ss.user_id=$2 AND ss.ended_at IS NULL
    `, [sessionId, userId]);

    if (!sessions.length) throw new NotFoundException('No active session found.');
    const s = sessions[0];
    const gapSecs = (Date.now() - new Date(s.last_heartbeat).getTime()) / 1000;

    // ── Anti-cheat: heartbeat checks ───────────────────────
    const hbCheck = await this.antiCheat.checkHeartbeat(userId, sessionId, gapSecs, s);
    if (hbCheck.result === 'BLOCK') {
      // Revoke session — don't award any more coins
      await this.db.query(`UPDATE study_sessions SET ended_at=NOW() WHERE id=$1`, [sessionId]);
      await this.antiCheat.clearActiveSession(userId);
      await this.antiCheat.flagForReview(userId, hbCheck.reason || 'Anti-cheat block', hbCheck.details || {});
      throw new BadRequestException(hbCheck.reason || 'Session terminated by anti-cheat');
    }
    const antiCheatWarn = hbCheck.result === 'WARN';

    // ── Anti-cheat: check heartbeat + coin velocity ──────────────
    const acHb = await this.antiCheat.checkHeartbeat(userId, sessionId, gapSecs, s);
    if (acHb.result === 'BLOCK') {
      this.logger.warn(`Heartbeat BLOCKED for user=${userId}: ${acHb.reason}`);
      return successResponse({ isAfk: true, activeMinsThisBeat: 0,
        coinsEarnedThisBeat: 0, xpEarnedThisBeat: 0,
        totalCoinsThisSession: s.coins_earned, totalXpThisSession: s.xp_earned,
        totalActiveMinutes: s.active_minutes,
        message: 'Unusual activity detected. Coins not awarded.',
      });
    }
    // ─────────────────────────────────────────────────────────────

    if (gapSecs > this.AFK_THRESHOLD_S) {
      await this.db.query(
        `UPDATE study_sessions SET afk_count=afk_count+1, last_heartbeat=NOW() WHERE id=$1`,
        [sessionId]
      );
      this.logger.warn(`AFK: user=${userId} gap=${Math.round(gapSecs)}s`);
      return successResponse({
        isAfk: true, activeMinsThisBeat: 0, coinsEarnedThisBeat: 0, xpEarnedThisBeat: 0,
        totalCoinsThisSession: s.coins_earned, totalXpThisSession: s.xp_earned,
        totalActiveMinutes: s.active_minutes,
        message: 'AFK detected — study time not counted.',
      });
    }

    const activeMins     = Math.min(gapSecs / 60, 5);
    const coinMultiplier = +s.coin_multiplier || 1.0;
    const xpMultiplier   = +s.xp_multiplier   || 1.0;
    let coinsThisBeat    = Math.floor((activeMins / 60) * this.BASE_COINS_PER_HOUR * coinMultiplier);
    let xpThisBeat       = Math.floor(activeMins * this.BASE_XP_PER_MINUTE * xpMultiplier);

    // Anti-cheat WARN reduces coins to 50% for this beat


    if (coinsThisBeat > 0) {
      const capped = await this.checkDailyCap(userId, 'study_time');
      if (capped) {
        coinsThisBeat = 0;
      } else {
        await this.awardSessionCoins(userId, sessionId, coinsThisBeat, coinMultiplier);
      }
    }
    if (xpThisBeat > 0) await this.awardSessionXp(userId, sessionId, xpThisBeat);

    const roundMins = Math.round(activeMins);
    await this.db.query(`
      UPDATE study_sessions
      SET active_minutes=active_minutes+$1, coins_earned=coins_earned+$2,
          xp_earned=xp_earned+$3, last_heartbeat=NOW()
      WHERE id=$4
    `, [roundMins, coinsThisBeat, xpThisBeat, sessionId]);

    if (roundMins > 0) {
      await this.db.query(
        `UPDATE users SET total_study_minutes=total_study_minutes+$1 WHERE id=$2`,
        [roundMins, userId]
      );
    }
    await this.cache.del(`user_tier:${userId}`);

    return successResponse({
      isAfk: false, activeMinsThisBeat: roundMins,
      coinsEarnedThisBeat: coinsThisBeat, xpEarnedThisBeat: xpThisBeat,
      totalCoinsThisSession: s.coins_earned + coinsThisBeat,
      totalXpThisSession: s.xp_earned + xpThisBeat,
      totalActiveMinutes: s.active_minutes + roundMins,
      message: `Active! +${coinsThisBeat} coins, +${xpThisBeat} XP`,
    });
  }

  async endSession(sessionId: string, userId: string) {
    const sessions = await this.db.query(`
      SELECT ss.*, t.coin_multiplier, t.xp_multiplier, t.tier_key
      FROM study_sessions ss LEFT JOIN room_tiers t ON t.id=ss.tier_id
      WHERE ss.id=$1 AND ss.user_id=$2 AND ss.ended_at IS NULL
    `, [sessionId, userId]);
    if (!sessions.length) throw new NotFoundException('Active session not found.');

    const s = sessions[0];
    const durationMins = Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000);
    let bonusCoins = 0;
    if (s.active_minutes >= 30) {
      bonusCoins = await this.authService.awardCoins(userId, 'study_room', sessionId);
    }

    await this.db.query(`
      UPDATE study_sessions
      SET ended_at=NOW(), duration_minutes=$1, coins_earned=coins_earned+$2
      WHERE id=$3
    `, [durationMins, bonusCoins, sessionId]);
    // ── Update streak + last_study_date ─────────────────────────
    // Only count study days with at least 1 active minute to prevent
    // AFK-only sessions from counting as a study day.
    if (s.active_minutes >= 1) {
      const todayUTC = new Date().toISOString().slice(0, 10);
      const [lastStudy] = await this.db.query(
        `SELECT last_study_date FROM users WHERE id=$1`, [userId]
      );
      const lastDate = lastStudy?.last_study_date
        ? new Date(lastStudy.last_study_date).toISOString().slice(0, 10)
        : null;
      const yesterdayUTC = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

      // Streak logic:
      // - Same day as last study → keep current streak (no double-count)
      // - Yesterday → increment streak
      // - Anything else (gap) → reset to 1
      let streakSql = '';
      if (lastDate === todayUTC) {
        // Already counted today — only update last_active_at
        streakSql = `
          UPDATE users SET last_active_at=NOW(), last_study_date=CURRENT_DATE WHERE id=$1
        `;
      } else if (lastDate === yesterdayUTC) {
        // Consecutive day — increment streak
        streakSql = `
          UPDATE users SET
            last_active_at=NOW(),
            last_study_date=CURRENT_DATE,
            streak = streak + 1,
            longest_streak = GREATEST(longest_streak, streak + 1)
          WHERE id=$1
        `;
      } else {
        // Gap or first session ever — reset to 1
        streakSql = `
          UPDATE users SET
            last_active_at=NOW(),
            last_study_date=CURRENT_DATE,
            streak = 1,
            longest_streak = GREATEST(longest_streak, 1)
          WHERE id=$1
        `;
      }
      await this.db.query(streakSql, [userId]);
    } else {
      await this.db.query(`UPDATE users SET last_active_at=NOW() WHERE id=$1`, [userId]);
    }

    await this.cache.del(`user_tier:${userId}`);
    await this.cache.del(`user:${userId}`);       // invalidate getMe() cache
    await this.cache.del(`profile:${userId}`);    // invalidate profile cache


    // ── Anti-cheat: check session end ─────────────────────────────
    const durationSecs = durationMins * 60;
    await this.antiCheat.checkSessionEnd(userId, sessionId, durationSecs, s.active_minutes);
    // ─────────────────────────────────────────────────────────────

    this.logger.log(`Session ended: user=${userId} active=${s.active_minutes}min coins=${s.coins_earned}`);

    // Broadcast member_left + presence update so lobby and room members list
    // update immediately when a user ends their session
    if (s.tier_key) {
      this.gateway['broadcastPresenceUpdate'](s.tier_key);
      this.gateway.server?.to(`tier:${s.tier_key}`).emit('room:member_left', {
        tierKey: s.tier_key, userId,
      });
    }

    return successResponse({
      sessionId, durationMinutes: durationMins, activeMinutes: s.active_minutes,
      totalCoins: s.coins_earned + bonusCoins, totalXp: s.xp_earned, bonusCoins,
      message: s.active_minutes >= 60
        ? `Great session! ${(s.active_minutes / 60).toFixed(1)} hours of focused study.`
        : 'Good work! Keep building your daily habit.',
    }, 'Session ended');
  }

  async getActiveSession(userId: string) {
    const rows = await this.db.query(`
      SELECT ss.*, t.name AS tier_name, t.icon_emoji, t.color_hex
      FROM study_sessions ss LEFT JOIN room_tiers t ON t.id=ss.tier_id
      WHERE ss.user_id=$1 AND ss.ended_at IS NULL LIMIT 1
    `, [userId]);
    if (!rows.length) return successResponse({ session: null }, 'No active session');

    const s = rows[0];
    const gapSecs = (Date.now() - new Date(s.last_heartbeat).getTime()) / 1000;
    return successResponse({
      session: {
        id: s.id, startedAt: s.started_at, mode: s.mode,
        activeMinutes: s.active_minutes, coinsEarned: s.coins_earned, xpEarned: s.xp_earned,
        afkCount: s.afk_count, isAfkNow: gapSecs > this.AFK_THRESHOLD_S,
        lastHeartbeat: s.last_heartbeat,
        tier: s.tier_name ? { name: s.tier_name, iconEmoji: s.icon_emoji, colorHex: s.color_hex } : null,
      },
    });
  }

  private async checkDailyCap(userId: string, action: string): Promise<boolean> {
    const rule = await this.db.query(
      `SELECT max_per_day FROM coin_rules WHERE action=$1 AND is_active=TRUE LIMIT 1`, [action]
    );
    if (!rule.length) return false;
    const today = await this.db.query(`
      SELECT COALESCE(SUM(amount),0)::int AS total
      FROM coin_transactions WHERE user_id=$1 AND action=$2 AND created_at::date=CURRENT_DATE
    `, [userId, action]);
    return +today[0].total >= +rule[0].max_per_day;
  }

  private async awardSessionCoins(userId: string, sessionId: string, amount: number, multiplier: number) {
    if (amount <= 0) return;
    const bal = await this.db.query(
      `UPDATE users SET coins=coins+$1, total_coins_earned=total_coins_earned+$1 WHERE id=$2 RETURNING coins`,
      [amount, userId]
    );
    await this.db.query(
      `INSERT INTO coin_transactions (user_id,type,amount,description,action,ref_id,balance)
       VALUES ($1,'earned',$2,$3,'study_time',$4,$5)`,
      [userId, amount, `Study time (${multiplier}x tier)`, sessionId, bal[0].coins]
    );
  }

  private async awardSessionXp(userId: string, sessionId: string, amount: number) {
    if (amount <= 0) return;
    await this.db.query(`UPDATE users SET xp=xp+$1 WHERE id=$2`, [amount, userId]);
    const user = await this.db.query(`SELECT xp, xp_level FROM users WHERE id=$1`, [userId]);
    const nextLevel = await this.db.query(
      `SELECT level, xp_required, coin_bonus FROM xp_levels WHERE level=$1 LIMIT 1`,
      [user[0].xp_level + 1]
    );
    if (nextLevel.length && user[0].xp >= nextLevel[0].xp_required) {
      await this.db.query(`UPDATE users SET xp_level=$1 WHERE id=$2`, [nextLevel[0].level, userId]);
      if (nextLevel[0].coin_bonus > 0)
        await this.awardSessionCoins(userId, sessionId, nextLevel[0].coin_bonus, 1);
      this.logger.log(`Level up! user=${userId} => level ${nextLevel[0].level}`);
    }
  }
}

// ============================================================
// CRON SERVICE
// ============================================================
@Injectable()
export class TierRoomsCronService {
  private readonly logger = new Logger(TierRoomsCronService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly authService: AuthService,
    private readonly antiCheat: AntiCheatService,
    private readonly gateway: TierRoomsGateway,
    private readonly notifService: TierNotificationsService,
  ) {}

  @Cron('*/5 * * * *')
  async closeExpiredSessions() {
    const result = await this.db.query(`
      UPDATE study_sessions
      SET ended_at         = last_heartbeat + INTERVAL '5 minutes',
          duration_minutes = EXTRACT(EPOCH FROM (last_heartbeat+INTERVAL '5 minutes'-started_at))::int/60
      WHERE ended_at IS NULL AND last_heartbeat < NOW()-INTERVAL '15 minutes'
      RETURNING id
    `);
    if (result.length) this.logger.log(`Auto-closed ${result.length} expired sessions`);
  }

  @Cron('5 0 * * *')
  async evaluateTierProgressions() {
    this.logger.log('Running tier progression evaluation...');
    const rules = await this.db.query(`
      SELECT tpr.*, ft.tier_key AS from_key, tt.tier_key AS to_key,
             ft.sort_order AS from_order
      FROM tier_progression_rules tpr
      JOIN room_tiers ft ON ft.id=tpr.from_tier_id
      JOIN room_tiers tt ON tt.id=tpr.to_tier_id
      WHERE tpr.is_active=TRUE ORDER BY ft.sort_order ASC
    `);

    for (const rule of rules) {
      const candidates = await this.db.query(`
        SELECT urt.user_id, u.total_study_minutes, u.streak,
               u.quizzes_attempted, u.accuracy, u.total_coins_earned,
               urt.tier_joined_at, urt.demotion_grace_until,
               COALESCE((
                 SELECT SUM(active_minutes)/60.0 FROM study_sessions
                 WHERE user_id=urt.user_id
                   AND started_at > NOW()-($1||' days')::interval
               ),0) AS weekly_study_hours
        FROM user_room_tier urt JOIN users u ON u.id=urt.user_id
        WHERE urt.current_tier_id=$2 AND u.status='active'
      `, [rule.evaluation_window_days, rule.from_tier_id]);

      let promoted = 0, demoted = 0;
      for (const user of candidates) {
        const totalHours = (user.total_study_minutes || 0) / 60;
        const progress   = this.computeProgress(user, rule, totalHours);

        await this.db.query(`
          UPDATE user_room_tier SET next_tier_progress=$1, last_evaluated_at=NOW(), updated_at=NOW()
          WHERE user_id=$2
        `, [progress, user.user_id]);

        if (this.meetsCriteria(user, rule, totalHours)) {
          await this.promoteUser(user.user_id, rule.to_tier_id, rule.from_tier_id);
          promoted++;
        } else {
          const inGrace = user.demotion_grace_until && new Date(user.demotion_grace_until) > new Date();
          const daysSince = user.tier_joined_at
            ? (Date.now() - new Date(user.tier_joined_at).getTime()) / 86400000 : 0;
          if (!inGrace && progress < rule.demotion_threshold_pct/100 && daysSince >= 7) {
            await this.demoteUser(user.user_id, rule.from_tier_id, rule.demotion_grace_days);
            demoted++;
          }
        }
      }
      this.logger.log(`${rule.from_key}->${rule.to_key}: +${promoted} promoted, -${demoted} demoted`);
    }
  }

  // ── Every 30 min during study hours — live leaderboard tick ─
  // Broadcasts current top-3 of each tier to WS-connected clients.
  // Cheap: reads from the already-computed room_leaderboard snapshot.
  @Cron('*/30 6-23 * * *')
  async broadcastLeaderboardTick() {
    const tiers      = await this.db.query(`SELECT id, tier_key FROM room_tiers WHERE is_active=TRUE`);
    const period     = this.getCurrentPeriodKey('weekly');

    for (const tier of tiers) {
      const top3 = await this.db.query(`
        SELECT rl.rank_position, rl.study_minutes, rl.coins_earned,
               u.id AS user_id, u.name AS user_name
        FROM room_leaderboard rl
        JOIN users u ON u.id = rl.user_id
        WHERE rl.tier_id=$1 AND rl.period_type='weekly' AND rl.period_key=$2
        ORDER BY rl.rank_position ASC LIMIT 3
      `, [tier.id, period]);

      if (top3.length > 0) {
        this.gateway.broadcastLeaderboardTick(tier.tier_key, top3);
      }
    }
  }

  private getCurrentPeriodKey(period: string): string {
    const now = new Date();
    if (period === 'weekly') {
      const s = new Date(now.getFullYear(), 0, 1);
      const w = Math.ceil(((now.getTime()-s.getTime())/86400000+s.getDay()+1)/7);
      return `${now.getFullYear()}-W${String(w).padStart(2,'0')}`;
    }
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }

  // ── 1st of month at 01:00 — monthly leaderboard snapshot ──
  @Cron('0 1 1 * *')
  async snapshotMonthlyLeaderboard() {
    this.logger.log('Snapshotting monthly leaderboard...');
    const now        = new Date();
    // Previous month
    const prevMonth  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const periodKey  = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth()+1).padStart(2,'0')}`;
    const monthStart = prevMonth;
    const monthEnd   = new Date(now.getFullYear(), now.getMonth(), 1);
    const tiers      = await this.db.query(`SELECT id, tier_key FROM room_tiers WHERE is_active=TRUE`);

    for (const tier of tiers) {
      const stats = await this.db.query(`
        SELECT urt.user_id,
          COALESCE(SUM(ss.active_minutes),0)::int AS study_minutes,
          COALESCE(SUM(ss.coins_earned),0)::int   AS coins_earned,
          COALESCE(SUM(ss.xp_earned),0)::int      AS xp_earned,
          COALESCE(u.streak,0)::int                AS streak_days
        FROM user_room_tier urt JOIN users u ON u.id=urt.user_id
        LEFT JOIN study_sessions ss ON ss.user_id=urt.user_id
          AND ss.started_at>=$1 AND ss.started_at<$2 AND ss.ended_at IS NOT NULL
        WHERE urt.current_tier_id=$3 AND u.status='active'
        GROUP BY urt.user_id, u.streak ORDER BY study_minutes DESC, coins_earned DESC
      `, [monthStart.toISOString(), monthEnd.toISOString(), tier.id]);

      for (let i = 0; i < stats.length; i++) {
        const s = stats[i];
        await this.db.query(`
          INSERT INTO room_leaderboard
            (tier_id,user_id,period_type,period_key,study_minutes,coins_earned,xp_earned,streak_days,rank_position)
          VALUES ($1,$2,'monthly',$3,$4,$5,$6,$7,$8)
          ON CONFLICT (tier_id,user_id,period_type,period_key) DO UPDATE SET
            study_minutes=$4,coins_earned=$5,xp_earned=$6,streak_days=$7,rank_position=$8,computed_at=NOW()
        `, [tier.id,s.user_id,periodKey,s.study_minutes,s.coins_earned,s.xp_earned,s.streak_days,i+1]);
      }
      // Top 3 monthly bonus (2× weekly rewards)
      const rewards = [100, 60, 40];
      for (let i = 0; i < Math.min(3, stats.length); i++) {
        await this.authService.awardCoins(stats[i].user_id, 'leaderboard_reward', tier.id);
      }
      await this.cache.del(`leaderboard:${tier.tier_key}:monthly:${periodKey}`);
    }
    this.logger.log(`Monthly leaderboard snapshotted for ${periodKey}`);
  }

  @Cron('55 23 * * 0')
  async snapshotWeeklyLeaderboard() {
    this.logger.log('Snapshotting weekly leaderboard...');
    const tiers = await this.db.query(`SELECT id, tier_key FROM room_tiers WHERE is_active=TRUE`);
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const w = Math.ceil(((now.getTime()-start.getTime())/86400000+start.getDay()+1)/7);
    const periodKey = `${now.getFullYear()}-W${String(w).padStart(2,'0')}`;
    const weekStart = new Date(now.getTime()-7*86400000);

    for (const tier of tiers) {
      const stats = await this.db.query(`
        SELECT urt.user_id,
          COALESCE(SUM(ss.active_minutes),0)::int AS study_minutes,
          COALESCE(SUM(ss.coins_earned),0)::int   AS coins_earned,
          COALESCE(SUM(ss.xp_earned),0)::int      AS xp_earned,
          COALESCE(u.streak,0)::int                AS streak_days
        FROM user_room_tier urt JOIN users u ON u.id=urt.user_id
        LEFT JOIN study_sessions ss
          ON ss.user_id=urt.user_id AND ss.started_at>=$1 AND ss.ended_at IS NOT NULL
        WHERE urt.current_tier_id=$2 AND u.status='active'
        GROUP BY urt.user_id, u.streak
        ORDER BY study_minutes DESC, coins_earned DESC
      `, [weekStart.toISOString(), tier.id]);

      for (let i = 0; i < stats.length; i++) {
        const s = stats[i];
        await this.db.query(`
          INSERT INTO room_leaderboard
            (tier_id,user_id,period_type,period_key,study_minutes,coins_earned,xp_earned,streak_days,rank_position)
          VALUES ($1,$2,'weekly',$3,$4,$5,$6,$7,$8)
          ON CONFLICT (tier_id,user_id,period_type,period_key) DO UPDATE SET
            study_minutes=$4, coins_earned=$5, xp_earned=$6, streak_days=$7,
            rank_position=$8, computed_at=NOW()
        `, [tier.id, s.user_id, periodKey, s.study_minutes, s.coins_earned, s.xp_earned, s.streak_days, i+1]);
      }

      // Award top 3
      const rewards = [50, 30, 20];
      for (let i = 0; i < Math.min(3, stats.length); i++) {
        await this.authService.awardCoins(stats[i].user_id, 'leaderboard_reward', tier.id);
      }
      await this.cache.del(`leaderboard:${tier.tier_key}:weekly:${periodKey}`);
    }
    this.logger.log(`Weekly leaderboard done for ${periodKey}`);
  }

  private computeProgress(user: any, rule: any, totalHours: number): number {
    const parts: number[] = [];
    if (+rule.min_total_study_hours > 0) parts.push(Math.min(totalHours/+rule.min_total_study_hours,1));
    if (+rule.min_streak_days > 0) parts.push(Math.min((user.streak||0)/+rule.min_streak_days,1));
    if (+rule.min_quizzes_completed > 0) parts.push(Math.min((user.quizzes_attempted||0)/+rule.min_quizzes_completed,1));
    if (+rule.min_accuracy_pct > 0) parts.push(Math.min(+(user.accuracy||0)/+rule.min_accuracy_pct,1));
    if (!parts.length) return 0;
    return +Math.min(parts.reduce((a,b)=>a+b,0)/parts.length,1).toFixed(4);
  }

  private meetsCriteria(user: any, rule: any, totalHours: number): boolean {
    if (+rule.min_total_study_hours > 0 && totalHours < +rule.min_total_study_hours) return false;
    if (+rule.min_streak_days > 0 && (user.streak||0) < +rule.min_streak_days) return false;
    if (+rule.min_quizzes_completed > 0 && (user.quizzes_attempted||0) < +rule.min_quizzes_completed) return false;
    if (+rule.min_accuracy_pct > 0 && +(user.accuracy||0) < +rule.min_accuracy_pct) return false;
    return true;
  }

  private async promoteUser(userId: string, toTierId: string, fromTierId: string) {
    await this.db.query(`
      UPDATE user_room_tier
      SET current_tier_id=$1, previous_tier_id=$2, promoted_at=NOW(), tier_joined_at=NOW(),
          next_tier_progress=0.0000, demotion_grace_until=NOW()+INTERVAL '3 days', updated_at=NOW()
      WHERE user_id=$3
    `, [toTierId, fromTierId, userId]);
    await this.db.query(`UPDATE users SET room_tier_id=$1 WHERE id=$2`, [toTierId, userId]);
    await this.authService.awardCoins(userId, 'tier_promotion', toTierId);
    await this.cache.del(`user_tier:${userId}`);
    await this.cache.del('tier_rooms:all');
    // Emit WS event first (instant if user online), then push notif as fallback
    const tierInfo = await this.db.query(
      `SELECT tier_key, name, icon_emoji FROM room_tiers WHERE id=$1 LIMIT 1`, [toTierId]
    );
    if (tierInfo.length) {
      const t = tierInfo[0];
      const wsDelivered = this.gateway.emitPromotion(userId, t.tier_key, t.name, t.icon_emoji);
      // If user offline (WS not connected), fall back to push notification
      if (!wsDelivered) {
        this.notifService.notifyPromotion(userId, t.tier_key, t.name, t.icon_emoji)
          .catch(e => this.logger.error(`Promotion push failed: ${e.message}`));
      }
    }
  }

  private async demoteUser(userId: string, currentTierId: string, graceDays: number) {
    const lower = await this.db.query(`
      SELECT t.id FROM room_tiers t JOIN room_tiers curr ON curr.id=$1
      WHERE t.sort_order=curr.sort_order-1 AND t.is_active=TRUE LIMIT 1
    `, [currentTierId]);
    if (!lower.length) return;
    await this.db.query(`
      UPDATE user_room_tier
      SET current_tier_id=$1, previous_tier_id=$2, promoted_at=NOW(), tier_joined_at=NOW(),
          next_tier_progress=0.5000,
          demotion_grace_until=NOW()+($3||' days')::interval, updated_at=NOW()
      WHERE user_id=$4
    `, [lower[0].id, currentTierId, graceDays, userId]);
    await this.db.query(`UPDATE users SET room_tier_id=$1 WHERE id=$2`, [lower[0].id, userId]);
    await this.cache.del(`user_tier:${userId}`);
    this.logger.log(`Demoted user=${userId}`);
  }
}

// ============================================================
// USER CONTROLLER  /api/v1/rooms/*
// ============================================================
@ApiTags('Study Rooms — Tiers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rooms')
export class TierRoomsController {
  constructor(
    private readonly tiersService:    TierRoomsService,
    private readonly sessionsService: StudySessionsService,
    private readonly gateway:         TierRoomsGateway,
  ) {}

  @Get('tiers')
  findAllTiers() { return this.tiersService.findAllTiers(); }

  @Get('tiers/my')
  getMyTier(@Req() r: any) { return this.tiersService.getMyTier(r.user.id); }

  @Get('tiers/:tierKey/members')
  getTierMembers(@Param('tierKey') tierKey: string, @Query() q: any) {
    return this.tiersService.getTierMembers(tierKey, q);
  }

  @Get('tiers/:tierKey/leaderboard')
  getLeaderboard(
    @Param('tierKey') tierKey: string,
    @Query('period') period: string = 'weekly',
  ) { return this.tiersService.getLeaderboard(tierKey, period); }

  @Post('sessions/start')
  @HttpCode(HttpStatus.CREATED)
  startSession(@Req() r: any, @Body() body: any) {
    return this.sessionsService.startSession(r.user.id, body.roomId, body.mode);
  }

  @Post('sessions/heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Req() r: any, @Body() body: any) {
    if (!body.sessionId) throw new BadRequestException('sessionId required');
    return this.sessionsService.heartbeat(body.sessionId, r.user.id);
  }

  @Post('sessions/end')
  @HttpCode(HttpStatus.OK)
  endSession(@Req() r: any, @Body() body: any) {
    if (!body.sessionId) throw new BadRequestException('sessionId required');
    return this.sessionsService.endSession(body.sessionId, r.user.id);
  }

  @Get('sessions/active')
  getActiveSession(@Req() r: any) {
    return this.sessionsService.getActiveSession(r.user.id);
  }

  /** GET /rooms/tiers/at-risk — is the user at risk of demotion? */
  @Get('tiers/at-risk')
  getAtRiskStatus(@Req() r: any) {
    return this.tiersService.getAtRiskStatus(r.user.id);
  }

  /**
   * GET /rooms/tiers/:tierKey/messages?limit=50
   * Returns last N chat messages for a tier room, oldest-first.
   * Called by ChatSheet on open to load history before live WS messages.
   * FIX: This endpoint was MISSING — causing chat history to always fail (404).
   */
  @Get('tiers/:tierKey/messages')
  async getChatHistory(
    @Param('tierKey') tierKey: string,
    @Query('limit')   limit:   number = 50,
  ) {
    const msgs = await this.gateway.getChatHistory(tierKey, Math.min(+limit || 50, 100));
    // gateway returns newest-first from DB; reverse for oldest-first display
    return successResponse({ messages: msgs.reverse() });
  }
}

// ============================================================
// ADMIN CONTROLLER  /api/v1/admin/room-tiers/*
// ============================================================
@ApiTags('Admin — Room Tiers')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/room-tiers')
export class AdminTierRoomsController {
  constructor(
    private readonly tiersService: TierRoomsService,
    private readonly antiCheat: AntiCheatService,
  ) {}

  @Get()                 @RequirePermission('study-rooms') findAll()            { return this.tiersService.adminFindAllTiers(); }
  @Get('distribution')   @RequirePermission('study-rooms') distribution()       { return this.tiersService.adminTierDistribution(); }
  @Get('rules')          @RequirePermission('study-rooms') getRules()           { return this.tiersService.adminGetRules(); }
  @Put(':id')            @RequirePermission('study-rooms') updateTier(@Param('id',ParseUUIDPipe) id: string, @Body() dto: any) { return this.tiersService.adminUpdateTier(id, dto); }
  @Put('rules/:id')      @RequirePermission('study-rooms') updateRule(@Param('id',ParseUUIDPipe) id: string, @Body() dto: any) { return this.tiersService.adminUpdateRule(id, dto); }

  @Post('promote')
  @RequirePermission('study-rooms')
  @HttpCode(HttpStatus.OK)
  promoteUser(@Body() dto: any) {
    if (!dto.userId || !dto.targetTierKey) throw new BadRequestException('userId and targetTierKey required');
    return this.tiersService.adminPromoteUser(dto.userId, dto.targetTierKey);
  }

  // ── Anti-cheat review endpoints ───────────────────────────
  @Get('flagged-users')
  @RequirePermission('study-rooms')
  getFlaggedUsers(@Query() q: any) {
    return this.antiCheat.getFlaggedUsers(q);
  }

  @Post('flagged-users/:userId/clear')
  @RequirePermission('study-rooms')
  @HttpCode(HttpStatus.OK)
  clearFlags(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.antiCheat.clearFlags(userId);
  }
}

// ============================================================
// MODULE
// ============================================================
@Module({
  imports: [JwtModule, ScheduleModule.forRoot(), AuthModule],
  controllers: [TierRoomsController, AdminTierRoomsController],
  providers: [
    TierRoomsService,
    StudySessionsService,
    TierRoomsCronService,
    TierNotificationsService,
    TierRoomsGateway,
    AntiCheatService,         // Anti-cheat layer
  ],
  exports: [TierRoomsService, StudySessionsService, TierNotificationsService, TierRoomsGateway, AntiCheatService],
})
export class TierRoomsModule {}