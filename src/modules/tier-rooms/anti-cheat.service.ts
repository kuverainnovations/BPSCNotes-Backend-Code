import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource }   from '@nestjs/typeorm';
import { DataSource }         from 'typeorm';
import { CACHE_MANAGER }      from '@nestjs/cache-manager';
import { Cache }              from 'cache-manager';
import { Inject }             from '@nestjs/common';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/tier-rooms/anti-cheat.service.ts
//
// Phase 5 — Production anti-cheat for the study sessions system.
//
// Checks performed:
//   1. Session velocity    — max N sessions per day
//   2. Heartbeat velocity  — heartbeat gap < 4 min = bot (too fast)
//   3. AFK ratio           — >60% of session = AFK = suspicious
//   4. Coin velocity       — coins earned > expected max × 1.2
//   5. Session duration    — session < 60 sec = likely bot/test
//   6. Concurrent sessions — more than 1 active session (impossible in normal use)
//   7. Device fingerprint  — future: compare against known bad actors
//
// Result: ALLOW | WARN | BLOCK
// BLOCK:  session immediately closed, no coins awarded
// WARN:   coins awarded but flagged for review
// ════════════════════════════════════════════════════════════

export type AntiCheatResult = 'ALLOW' | 'WARN' | 'BLOCK';

export interface AntiCheatCheckResult {
  result:  AntiCheatResult;
  reason?: string;
  details?: Record<string, any>;
}

@Injectable()
export class AntiCheatService {
  clearActiveSession(userId: string) {
    throw new Error('Method not implemented.');
  }
  flagForReview(userId: string, arg1: string, arg2: Record<string, any>) {
    throw new Error('Method not implemented.');
  }
  private readonly logger = new Logger(AntiCheatService.name);

  // Thresholds (admin can override via env or DB config in future)
  private readonly MAX_SESSIONS_PER_DAY    = 8;
  private readonly MIN_HEARTBEAT_GAP_SECS  = 240;   // 4 min — below = bot
  private readonly MAX_AFK_RATIO           = 0.60;  // >60% AFK = suspicious
  private readonly MAX_COINS_MULTIPLIER    = 1.20;  // >120% expected = block
  private readonly MIN_SESSION_SECS        = 60;    // < 60s = test/bot

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ── CHECK 1: called on POST /rooms/sessions/start ─────────
  async checkSessionStart(userId: string): Promise<AntiCheatCheckResult> {
    // 1a. Concurrent sessions (should be impossible — belt-and-suspenders check)
    const active = await this.db.query(
      `SELECT COUNT(*) FROM study_sessions WHERE user_id=$1 AND ended_at IS NULL`,
      [userId]
    );
    if (parseInt(active[0].count) > 0) {
      return { result: 'BLOCK', reason: 'concurrent_session',
        details: { message: 'Another active session exists' } };
    }

    // 1b. Session velocity — max sessions per day
    const today = await this.db.query(
      `SELECT COUNT(*) FROM study_sessions WHERE user_id=$1 AND started_at::date=CURRENT_DATE`,
      [userId]
    );
    if (parseInt(today[0].count) >= this.MAX_SESSIONS_PER_DAY) {
      return { result: 'BLOCK', reason: 'session_velocity',
        details: { todaySessions: parseInt(today[0].count), max: this.MAX_SESSIONS_PER_DAY } };
    }

    return { result: 'ALLOW' };
  }

  // ── CHECK 2: called on every heartbeat ────────────────────
  async checkHeartbeat(
    userId:    string,
    sessionId: string,
    gapSecs:   number,
    session:   { afk_count: number; active_minutes: number; coins_earned: number }
  ): Promise<AntiCheatCheckResult> {

    // 2a. Heartbeat velocity — too fast = bot or fake heartbeat
    if (gapSecs < this.MIN_HEARTBEAT_GAP_SECS && gapSecs > 0) {
      await this.flagUser(userId, 'heartbeat_velocity',
        `Heartbeat gap ${gapSecs}s is below minimum ${this.MIN_HEARTBEAT_GAP_SECS}s`
      );
      return { result: 'WARN', reason: 'heartbeat_velocity',
        details: { gapSecs, minExpected: this.MIN_HEARTBEAT_GAP_SECS } };
    }

    // 2b. AFK ratio — too many AFK events in this session
    const totalBeats = session.active_minutes > 0
      ? Math.ceil(session.active_minutes / 5)
      : 1;
    const afkRatio   = session.afk_count / totalBeats;
    if (afkRatio > this.MAX_AFK_RATIO && session.afk_count > 3) {
      await this.flagUser(userId, 'afk_ratio',
        `AFK ratio ${(afkRatio * 100).toFixed(0)}% exceeds ${this.MAX_AFK_RATIO * 100}%`
      );
      return { result: 'WARN', reason: 'afk_ratio',
        details: { afkRatio, afkCount: session.afk_count, totalBeats } };
    }

    // 2c. Coin velocity — daily study coins vs maximum expected
    const todayCoins = await this.db.query(`
      SELECT COALESCE(SUM(amount),0)::int AS total
      FROM coin_transactions
      WHERE user_id=$1 AND action='study_time' AND created_at::date=CURRENT_DATE
    `, [userId]);
    const earned      = parseInt(todayCoins[0].total);
    const rule        = await this.db.query(
      `SELECT max_per_day FROM coin_rules WHERE action='study_time' AND is_active=TRUE LIMIT 1`
    );
    const maxAllowed  = rule.length ? parseInt(rule[0].max_per_day) : 24;
    if (earned > maxAllowed * this.MAX_COINS_MULTIPLIER) {
      await this.flagUser(userId, 'coin_velocity',
        `Study coins today: ${earned}, max expected: ${maxAllowed}`
      );
      return { result: 'BLOCK', reason: 'coin_velocity',
        details: { earned, maxAllowed } };
    }

    return { result: 'ALLOW' };
  }

  // ── CHECK 3: called on session end ────────────────────────
  async checkSessionEnd(
    userId:     string,
    sessionId:  string,
    durationSecs: number,
    activeMinutes: number
  ): Promise<AntiCheatCheckResult> {

    // Very short session — likely bot or network error
    if (durationSecs < this.MIN_SESSION_SECS) {
      await this.flagUser(userId, 'short_session',
        `Session duration ${durationSecs}s < minimum ${this.MIN_SESSION_SECS}s`
      );
      return { result: 'WARN', reason: 'short_session',
        details: { durationSecs, min: this.MIN_SESSION_SECS } };
    }

    return { result: 'ALLOW' };
  }

  // ── Get flagged users for admin review ────────────────────
  async getFlaggedUsers(query: { page?: number; limit?: number }) {
    const { page = 1, limit = 50 } = query;
    const offset = (page - 1) * limit;

    const rows = await this.db.query(`
      SELECT
        uf.user_id,
        u.name, u.mobile,
        uf.reason,
        uf.details,
        uf.created_at,
        COUNT(*) OVER (PARTITION BY uf.user_id)::int AS total_flags
      FROM user_flags uf
      JOIN users u ON u.id = uf.user_id
      ORDER BY uf.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const total = await this.db.query(`SELECT COUNT(DISTINCT user_id) FROM user_flags`);
    return {
      flaggedUsers: rows,
      total: parseInt(total[0].count),
      page, limit,
    };
  }

  // ── Mark session as verified clean (admin) ────────────────
  async clearFlags(userId: string) {
    await this.db.query(
      `DELETE FROM user_flags WHERE user_id=$1`, [userId]
    );
    this.logger.log(`Flags cleared for user=${userId}`);
  }

  // ── Internal flag helper ──────────────────────────────────
  private async flagUser(userId: string, reason: string, details: string) {
    // Rate-limit flags to once per reason per hour (avoid log spam)
    const cacheKey  = `flag:${userId}:${reason}`;
    const recentFlag = await this.cache.get(cacheKey);
    if (recentFlag) return;

    try {
      await this.db.query(`
        INSERT INTO user_flags (user_id, reason, details)
        VALUES ($1, $2, $3)
      `, [userId, reason, details]);

      await this.cache.set(cacheKey, true, 3600); // suppress for 1h
      this.logger.warn(`Anti-cheat flag: user=${userId} reason=${reason} details=${details}`);
    } catch (e: any) {
      // Table may not exist yet — fail silently until migration runs
      this.logger.debug(`user_flags not ready: ${e.message}`);
    }
  }

  // ── Redis presence tracking helpers ──────────────────────
  // Used by gateway to track who is actively in each tier room.
  // More reliable than in-memory Map for multi-instance deployments.
  async markSessionActive(userId: string, sessionId: string, tierKey: string) {
    const key = `presence:${tierKey}`;
    // Use cache SET with user-to-session mapping (TTL = 20 min max session gap)
    await this.cache.set(`session:active:${userId}`, { sessionId, tierKey }, 1200);
  }

  async markSessionInactive(userId: string, tierKey: string) {
    await this.cache.del(`session:active:${userId}`);
  }

  async getActiveMemberCount(tierKey: string): Promise<number> {
    // For scale: use Redis SCARD — here we count from DB as fallback
    const result = await this.db.query(`
      SELECT COUNT(DISTINCT user_id)::int AS cnt
      FROM study_sessions
      WHERE tier_id = (SELECT id FROM room_tiers WHERE tier_key=$1 LIMIT 1)
        AND ended_at IS NULL
        AND last_heartbeat > NOW() - INTERVAL '7 minutes'
    `, [tierKey]);
    return result[0]?.cnt ?? 0;
  }
}
