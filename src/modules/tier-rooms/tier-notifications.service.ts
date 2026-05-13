import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource }    from '@nestjs/typeorm';
import { DataSource }          from 'typeorm';
import { Cron }                from '@nestjs/schedule';
import * as admin              from 'firebase-admin';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/tier-rooms/tier-notifications.service.ts
//
// Sends push notifications for tier-system events:
//   1. Tier promotion         — fired immediately by TierRoomsCronService
//   2. Demotion "At Risk"     — cron: daily 08:00, warns users below threshold
//   3. Weekly rank reveal     — cron: Monday 09:00, tell users their rank
//   4. Challenge deadline     — cron: Sunday 18:00, nudge uncompleted challenges
//
// Reuses users.fcm_token (already in schema) + Firebase Admin SDK
// which is already initialised in combined-modules-1.module.ts.
// ════════════════════════════════════════════════════════════

@Injectable()
export class TierNotificationsService {
  private readonly logger = new Logger(TierNotificationsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  // ── Core push helper ──────────────────────────────────────
  // Sends to a single user. Gracefully skips if no FCM token.
  async pushToUser(
    userId:   string,
    title:    string,
    body:     string,
    data:     Record<string, string> = {},
  ): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT fcm_token FROM users WHERE id=$1 AND notification_enabled=TRUE LIMIT 1`,
      [userId]
    );
    const token = rows[0]?.fcm_token;
    if (!token) return false;

    return this.sendFcm([token], title, body, data);
  }

  // ── Push to all users in a tier ───────────────────────────
  async pushToTier(
    tierKey:  string,
    title:    string,
    body:     string,
    data:     Record<string, string> = {},
  ): Promise<number> {
    const rows = await this.db.query(`
      SELECT u.fcm_token
      FROM users u
      JOIN user_room_tier urt ON urt.user_id = u.id
      JOIN room_tiers t       ON t.id  = urt.current_tier_id
      WHERE t.tier_key             = $1
        AND u.fcm_token IS NOT NULL
        AND u.notification_enabled = TRUE
        AND u.status               = 'active'
    `, [tierKey]);

    const tokens = rows.map((r: any) => r.fcm_token).filter(Boolean);
    if (!tokens.length) return 0;

    let sent = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const ok = await this.sendFcm(tokens.slice(i, i + 500), title, body, data);
      if (ok) sent += Math.min(500, tokens.length - i);
    }
    return sent;
  }

  // ── Promotion notification (called by cron immediately) ───
  async notifyPromotion(userId: string, newTierKey: string, newTierName: string, newTierEmoji: string) {
    const messages: Record<string, { title: string; body: string }> = {
      gold:    { title: `${newTierEmoji} You've reached ${newTierName}!`, body: 'Now earning 1.5× coins per study hour. Keep the streak going!' },
      premium: { title: `${newTierEmoji} Welcome to ${newTierName}!`,    body: '2× coins, exclusive notes, and premium challenges await you.' },
      diamond: { title: `💎 Diamond Elite — You made it!`,                body: 'Top 3% of all BPSC aspirants. 3× coins and Diamond leaderboard. Incredible!' },
    };
    const msg = messages[newTierKey] || {
      title: `${newTierEmoji} Promoted to ${newTierName}!`,
      body:  `You unlocked a new tier. Open the app to see your rewards.`,
    };
    await this.pushToUser(userId, msg.title, msg.body, {
      type:    'tier_promotion',
      tierKey: newTierKey,
      screen:  'rooms_hub',
    });
    this.logger.log(`Promotion push sent: user=${userId} tier=${newTierKey}`);
  }

  // ── Cron: Daily 08:00 — "At Risk" demotion warnings ───────
  // Users whose next_tier_progress < demotion_threshold for the tier
  // but haven't been warned in the last 24 hours.
  @Cron('0 8 * * *')
  async sendDemotionWarnings() {
    this.logger.log('Running demotion warning push...');

    const atRisk = await this.db.query(`
      SELECT
        urt.user_id,
        urt.next_tier_progress,
        ct.tier_key, ct.name AS tier_name, ct.icon_emoji,
        tpr.demotion_threshold_pct
      FROM user_room_tier urt
      JOIN room_tiers ct ON ct.id = urt.current_tier_id
      JOIN tier_progression_rules tpr ON tpr.from_tier_id = ct.id AND tpr.is_active=TRUE
      JOIN users u ON u.id = urt.user_id
      WHERE urt.next_tier_progress < (tpr.demotion_threshold_pct / 100.0)
        -- Only warn users in Gold+ (Silver has no demotion below it)
        AND ct.sort_order > 1
        -- Don't warn if already in grace period
        AND (urt.demotion_grace_until IS NULL OR urt.demotion_grace_until < NOW())
        AND u.status = 'active'
        AND u.notification_enabled = TRUE
        AND u.fcm_token IS NOT NULL
      LIMIT 500
    `);

    let sent = 0;
    for (const user of atRisk) {
      const pct   = Math.round(user.next_tier_progress * 100);
      const ok    = await this.pushToUser(
        user.user_id,
        `⚠️ ${user.icon_emoji} ${user.tier_name} at risk`,
        `Your activity dropped to ${pct}% of the requirement. Study today to keep your tier!`,
        { type: 'demotion_warning', tierKey: user.tier_key, screen: 'rooms_hub' }
      );
      if (ok) sent++;
    }
    this.logger.log(`Demotion warnings sent: ${sent}/${atRisk.length}`);
  }

  // ── Cron: Monday 09:00 — Weekly rank reveal ───────────────
  // Tell each user their rank in last week's leaderboard.
  @Cron('0 9 * * 1')
  async sendWeeklyRankNotifications() {
    this.logger.log('Sending weekly rank notifications...');

    const now        = new Date();
    // Last week's ISO key
    const lastSun    = new Date(now); lastSun.setDate(now.getDate() - now.getDay());
    const start      = new Date(lastSun.getFullYear(), 0, 1);
    const weekNum    = Math.ceil(((lastSun.getTime()-start.getTime())/86400000+start.getDay()+1)/7);
    const periodKey  = `${lastSun.getFullYear()}-W${String(weekNum-1).padStart(2,'0')}`;

    // Get top 10 per tier + every user's own rank
    const entries = await this.db.query(`
      SELECT
        rl.user_id, rl.rank_position, rl.study_minutes, rl.coins_earned,
        t.name AS tier_name, t.icon_emoji,
        u.fcm_token, u.notification_enabled
      FROM room_leaderboard rl
      JOIN room_tiers t ON t.id = rl.tier_id
      JOIN users u      ON u.id = rl.user_id
      WHERE rl.period_type = 'weekly' AND rl.period_key = $1
        AND u.fcm_token IS NOT NULL AND u.notification_enabled = TRUE
      ORDER BY rl.rank_position ASC
    `, [periodKey]);

    let sent = 0;
    for (const e of entries) {
      const rank    = e.rank_position;
      const medal   = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
      const studyH  = Math.round(e.study_minutes / 60 * 10) / 10;
      const title   = rank <= 3
        ? `${medal} You're in the top 3 of ${e.icon_emoji} ${e.tier_name}!`
        : `${e.icon_emoji} Week summary — You ranked ${medal}`;
      const body    = `${studyH}h studied · 🪙${e.coins_earned} coins earned. ${rank <= 10 ? 'Amazing work!' : 'Push harder this week!'}`;
      const ok = await this.pushToUser(e.user_id, title, body, {
        type:   'weekly_rank',
        rank:   String(rank),
        screen: 'rooms_hub',
      });
      if (ok) sent++;
    }
    this.logger.log(`Weekly rank notifications sent: ${sent}`);
  }

  // ── Cron: Sunday 18:00 — Challenge deadline nudge ─────────
  // Reminds users who haven't completed this week's challenges.
  @Cron('0 18 * * 0')
  async sendChallengeDeadlineReminders() {
    this.logger.log('Sending challenge deadline reminders...');

    const now        = new Date();
    const start      = new Date(now.getFullYear(), 0, 1);
    const week       = Math.ceil(((now.getTime()-start.getTime())/86400000+start.getDay()+1)/7);
    const periodKey  = `${now.getFullYear()}-W${String(week).padStart(2,'0')}`;

    // Users with incomplete challenges this week
    const rows = await this.db.query(`
      SELECT DISTINCT
        ucp.user_id, u.fcm_token, u.notification_enabled,
        COUNT(*) FILTER (WHERE NOT ucp.is_completed) AS incomplete_count
      FROM user_challenge_progress ucp
      JOIN weekly_challenges wc ON wc.id = ucp.challenge_id
      JOIN users u ON u.id = ucp.user_id
      WHERE wc.period_key            = $1
        AND ucp.is_completed         = FALSE
        AND u.fcm_token IS NOT NULL
        AND u.notification_enabled   = TRUE
        AND u.status                 = 'active'
      GROUP BY ucp.user_id, u.fcm_token, u.notification_enabled
      LIMIT 2000
    `, [periodKey]);

    let sent = 0;
    for (const row of rows) {
      const n  = parseInt(row.incomplete_count);
      const ok = await this.pushToUser(
        row.user_id,
        `⏰ ${n} challenge${n > 1 ? 's' : ''} ending tonight!`,
        `Complete your weekly challenges before midnight to earn coins and XP.`,
        { type: 'challenge_deadline', screen: 'weekly_challenges' }
      );
      if (ok) sent++;
    }
    this.logger.log(`Challenge deadline reminders sent: ${sent}`);
  }

  // ── FCM multicast send ────────────────────────────────────
  private async sendFcm(
    tokens: string[],
    title:  string,
    body:   string,
    data:   Record<string, string> = {},
  ): Promise<boolean> {
    if (!admin.apps.length) return false;
    try {
      await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data,
        android: { priority: 'high', notification: { channelId: 'study_rooms', sound: 'default' } },
        apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      return true;
    } catch (err: any) {
      this.logger.error(`FCM send failed: ${err.message}`);
      return false;
    }
  }
}
