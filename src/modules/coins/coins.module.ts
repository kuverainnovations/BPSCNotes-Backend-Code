import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Body, Param, Query, Req, OnModuleInit,
  UseGuards, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { InjectDataSource }       from '@nestjs/typeorm';
import { DataSource }             from 'typeorm';
import { CACHE_MANAGER }          from '@nestjs/cache-manager';
import { Cache }                  from 'cache-manager';
import { Inject }                 from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, AdminJwtGuard } from '../../common/guards';
import { AuthModule, AuthService } from '../auth/auth.module';
import { successResponse }        from '../../common/utils/response.util';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/coins/coins.module.ts
//
// COIN ECONOMY — single source of truth is the `coin_rules` table
// (see migration 1781700000000-UnifyCoinEconomy). Every coin-earning
// action's amount/cap/active-state lives there and is fully editable
// from the admin "Coins" page; AuthService.awardCoins() reads it for
// every award across the whole app.
//
// Powers: CoinWalletScreen
// Endpoints:
//   GET  /coins/balance        — balance + streak + 7-day check-in grid
//   GET  /coins/tasks          — wallet "earn" cards, amounts from coin_rules
//   GET  /coins/transactions   — paginated history
//   GET  /coins/config         — full rules + economy config (single feed for the app)
//   POST /coins/check-in       — daily check-in (idempotent, dynamic reward ladder)
//   POST /coins/tasks/:id/claim — claim a task reward (only ad_watch / study_session
//                                  actually award here; others are informational —
//                                  they're auto-awarded by their real flows)
//   POST /coins/ad-reward      — credit coins for a watched rewarded ad
//   GET  /coins/ad-config      — coins-per-ad + min-ads-per-session
//
// Admin (admin.bpscnotes.in/coins):
//   GET    /admin/coins/rules        — every coin-earning action, with category/icon/unit
//   POST   /admin/coins/rules        — create a custom action
//   PUT    /admin/coins/rules/:id    — edit coins/cap/active/description/etc
//   DELETE /admin/coins/rules/:id    — delete (core actions can only be deactivated)
//   GET/PUT /admin/coins/economy     — master switch, coin↔₹ rate, redemption caps,
//                                       check-in reward ladder, ad settings
//   GET/PUT /admin/coins/ad-config   — legacy alias, kept for the existing UI section
//   GET    /admin/coins/stats        — circulating supply, txns today/this week
//   GET    /admin/coins/top-earners  — leaderboard by total coins earned
// ════════════════════════════════════════════════════════════

// ── Wallet "Earn Tasks" — DISPLAY metadata only (title/icon/colors/
// navigation). The coin AMOUNT, daily cap and active state for each
// of these always come live from coin_rules, so admin edits on the
// Coins page are reflected immediately without a code change. ──────
const WALLET_TASKS = [
  {
    action: 'daily_quiz', title: "Complete Daily Quiz", subtitle: "Answer today's quiz correctly",
    icon: 'quiz', actionLabel: 'Take Quiz',
    actionBgHex: '#1565C0', iconBgHex: '#E3F2FD', iconTintHex: '#1565C0', isAd: false,
  },
  {
    action: 'study_session', title: 'Complete Study Session', subtitle: 'Study for at least 30 minutes',
    icon: 'study', actionLabel: 'Study Now',
    actionBgHex: '#2E7D32', iconBgHex: '#E8F5E9', iconTintHex: '#2E7D32', isAd: false,
  },
  {
    action: 'material_upload', title: 'Upload Study Notes', subtitle: 'Share notes with the community',
    icon: 'study', actionLabel: 'Upload',
    actionBgHex: '#FF8F00', iconBgHex: '#FFF3E0', iconTintHex: '#FF8F00', isAd: false,
  },
  {
    action: 'referral_signup', title: 'Refer a Friend', subtitle: 'Invite friends and earn coins',
    icon: 'referral', actionLabel: 'Invite',
    actionBgHex: '#7B1FA2', iconBgHex: '#F3E5F5', iconTintHex: '#7B1FA2', isAd: false,
  },
  {
    action: 'ad_watch', title: 'Watch a Short Ad', subtitle: 'Watch a short ad to earn coins',
    icon: 'ad', actionLabel: 'Watch',
    actionBgHex: '#E74C3C', iconBgHex: '#FEE8E8', iconTintHex: '#E74C3C', isAd: true,
  },
] as const;

// Fallback only — used if app_settings.checkin_streak_rewards is
// missing/invalid. Admin edits this ladder from the Coins page.
const DEFAULT_CHECKIN_REWARDS = [5, 5, 10, 10, 15, 15, 25];

interface EconomySettings {
  enabled: boolean;
  coinToInrRate: number;
  maxCoinsPerPurchase: number;
  maxCoinDiscountPctSubscription: number;
  checkInRewards: number[];
  adMinPerSession: number;
}

// Reads the consolidated "coin economy" app_settings block (cached
// 5 min). Shared by CoinsService and AdminCoinsService so the wallet,
// the unified /coins/config feed, and the admin Coins page always
// agree on the same numbers.
async function readEconomySettings(db: DataSource, cache: Cache): Promise<EconomySettings> {
  const cached = await cache.get<EconomySettings>('coins:economy');
  if (cached) return cached;

  const rows = await db.query(`
    SELECT key, value FROM app_settings WHERE key IN (
      'coin_system_enabled','coin_to_inr_rate','max_coin_discount_pct_course',
      'max_coin_discount_pct_subscription','checkin_streak_rewards','ad_min_per_session'
    )
  `).catch(() => []);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  const parsedRewards = (map['checkin_streak_rewards'] ?? '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 0);

  const settings: EconomySettings = {
    enabled:                        map['coin_system_enabled'] !== 'false',
    coinToInrRate:                  parseFloat(map['coin_to_inr_rate'] ?? '1') || 1,
    maxCoinDiscountPctCourse:        parseInt(map['max_coin_discount_pct_course'] ?? '10', 10) || 10,
    maxCoinDiscountPctSubscription:  parseInt(map['max_coin_discount_pct_subscription'] ?? '30', 10) || 30,
    checkInRewards:                  parsedRewards.length === 7 ? parsedRewards : DEFAULT_CHECKIN_REWARDS,
    adMinPerSession:                 parseInt(map['ad_min_per_session'] ?? '2', 10) || 2,
  };
  await cache.set('coins:economy', settings, 300);
  return settings;
}

// Invalidates every cache entry derived from coin_rules / the economy
// settings block. Called after ANY admin write so the wallet, the
// /coins/config feed and /app-config pick up changes immediately.
async function invalidateCoinsCache(cache: Cache): Promise<void> {
  await Promise.all([
    cache.del('coins:config'),
    cache.del('coins:economy'),
    cache.del('coin:system_enabled'),
    cache.del('app:config'),
  ]);
}

@Injectable()
export class CoinsService implements OnModuleInit {
  private readonly logger = new Logger(CoinsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS coin_rules (
          id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
          action        TEXT        NOT NULL UNIQUE,
          description   TEXT        NOT NULL,
          coins_awarded INT         NOT NULL DEFAULT 5,
          max_per_day   INT         NOT NULL DEFAULT 1,
          is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
          category      VARCHAR(40),
          icon          VARCHAR(10),
          unit_label    VARCHAR(120),
          is_core       BOOLEAN     NOT NULL DEFAULT FALSE,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Defensive only — the UnifyCoinEconomy migration adds these
      // columns + seeds the canonical rows. This keeps a fresh boot
      // self-healing if migrations haven't run yet for some reason.
      await this.db.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS category   VARCHAR(40)`);
      await this.db.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS icon       VARCHAR(10)`);
      await this.db.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS unit_label VARCHAR(120)`);
      await this.db.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS is_core    BOOLEAN NOT NULL DEFAULT FALSE`);
      this.logger.log('coin_rules ready ✅');
    } catch (err) {
      this.logger.error('coin_rules init failed:', err.message);
    }
  }

  // ── GET /coins/balance ────────────────────────────────────────
  // Returns: balance, totalEarned, totalSpent, checkInStreak,
  //          checkedInToday, checkInDays (7-day array)
  async getBalance(userId: string) {
    const [user] = await this.db.query(`
      SELECT coins, total_coins_earned, last_active_at,
             streak, COALESCE(last_check_in_date, NULL) AS last_check_in
      FROM users WHERE id = $1
    `, [userId]);

    if (!user) throw new NotFoundException('User not found');

    // Bootstrap: if user has coins but zero transaction records,
    // create an initial_grant row so History tab shows their existing balance.
    const userCoins = user.coins ?? 0;
    if (userCoins > 0) {
      const [txnCount] = await this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM coin_transactions WHERE user_id = $1`, [userId]
      );
      if (txnCount.cnt === 0) {
        await this.db.query(`
          INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
          VALUES ($1, 'earned', $2, 'Initial coins balance', 'initial_grant', $2)
        `, [userId, userCoins]).catch(() => {});  // best-effort
      }
    }

    const totalSpent = await this.db.query(`
      SELECT COALESCE(SUM(amount), 0)::int AS spent
      FROM coin_transactions WHERE user_id = $1 AND type = 'spent'
    `, [userId]);

    const todayUTC  = new Date().toISOString().slice(0, 10);
    const lastCheckin = user.last_check_in ? new Date(user.last_check_in).toISOString().slice(0, 10) : null;
    const checkedInToday = lastCheckin === todayUTC;

    // Build 7-day check-in grid: look at coin_transactions for 'daily_checkin' last 7 days
    const txns = await this.db.query(`
      SELECT DATE(created_at AT TIME ZONE 'UTC') AS day
      FROM coin_transactions
      WHERE user_id = $1 AND action = 'daily_checkin'
        AND created_at >= NOW() - INTERVAL '7 days'
    `, [userId]);
    const checkedDays = new Set(txns.map((t: any) => t.day?.toISOString?.()?.slice(0, 10) ?? t.day));

    const economy = await readEconomySettings(this.db, this.cache);

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const now       = new Date();
    const todayIdx  = (now.getDay() + 6) % 7; // 0=Mon … 6=Sun

    const checkInDays = dayLabels.map((label, i) => {
      const d       = new Date(now);
      const diff    = i - todayIdx;
      d.setDate(d.getDate() + diff);
      const dateStr = d.toISOString().slice(0, 10);
      return {
        day:        i + 1,
        label,
        isDone:     checkedDays.has(dateStr),
        isToday:    i === todayIdx,
        bonusLabel: i === 6 ? `+${economy.checkInRewards[6]} Bonus!` : '',
        isBonus:    i === 6,
      };
    });

    const streak = checkedInToday ? user.streak : Math.max(0, user.streak - 1);

    return successResponse({
      balance:           user.coins ?? 0,
      totalEarned:       user.total_coins_earned ?? 0,
      totalSpent:        totalSpent[0]?.spent ?? 0,
      check_in_streak:   streak,        // snake_case → matches Android @SerializedName("check_in_streak")
      checked_in_today:  checkedInToday,// snake_case → matches Android @SerializedName("checked_in_today")
      checkInDays,
    });
  }

  // ── GET /coins/tasks ─────────────────────────────────────────
  // Coin amounts, daily caps and active-state all come live from
  // coin_rules — an admin edit on the Coins page is reflected the
  // next time this loads, no app update or code change needed.
  // isCompleted = the per-action daily cap has been reached today.
  async getEarnTasks(userId: string) {
    const actions = WALLET_TASKS.map(t => t.action);

    const rules = await this.db.query(
      `SELECT action, coins_awarded, max_per_day, is_active FROM coin_rules WHERE action = ANY($1)`,
      [actions]
    );
    const ruleMap = new Map(rules.map((r: any) => [r.action, r]));

    const counts = await this.db.query(`
      SELECT action, COUNT(*)::int AS cnt FROM coin_transactions
      WHERE user_id = $1 AND action = ANY($2) AND created_at::date = CURRENT_DATE
      GROUP BY action
    `, [userId, actions]);
    const countMap = new Map<string, number>(counts.map((c: any) => [c.action, Number(c.cnt)]));

    const tasks = WALLET_TASKS
      .map(t => {
        const rule = ruleMap.get(t.action) as any;
        if (!rule || !rule.is_active) return null; // admin turned this action off
        const maxPerDay = Number(rule.max_per_day) || 1;
        const done      = countMap.get(t.action) ?? 0;
        return {
          id:                 t.action,
          title:              t.title,
          subtitle:           t.subtitle,
          coinsReward:        Number(rule.coins_awarded),
          icon:               t.icon,
          actionLabel:        t.actionLabel,
          isCompleted:        done >= maxPerDay,
          isAd:               t.isAd,
          action:             t.action,
          actionBgHex:        t.actionBgHex,
          iconBgHex:          t.iconBgHex,
          iconTintHex:        t.iconTintHex,
          actionTextColorHex: '#FFFFFF',
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    return successResponse({ tasks });
  }

  // ── GET /coins/transactions ──────────────────────────────────
  async getTransactions(userId: string, limit = 20, page = 1) {
    const offset = (page - 1) * limit;
    const txns = await this.db.query(`
      SELECT
        id,
        description          AS title,
        CASE action
          WHEN 'daily_checkin'       THEN 'Daily streak bonus'
          WHEN 'daily_quiz'          THEN 'Daily quiz completed'
          WHEN 'mock_quiz'           THEN 'Mock test completed'
          WHEN 'topic_quiz'          THEN 'Topic quiz completed'
          WHEN 'quiz_attempt'        THEN 'Quiz completed'
          WHEN 'study_session'       THEN 'Study session reward'
          WHEN 'study_room'          THEN 'Study room session'
          WHEN 'active_recall'       THEN 'Active recall session'
          WHEN 'material_upload'     THEN 'Study material uploaded'
          WHEN 'referral_signup'     THEN 'Friend signed up — referral bonus'
          WHEN 'referral_joined'     THEN 'Welcome bonus — joined via referral'
          WHEN 'referral_engagement' THEN 'Referral milestone — friend engaged'
          WHEN 'referral_active'     THEN 'Referral milestone — friend active'
          WHEN 'ad_watch'            THEN 'Ad watched'
          WHEN 'watch_ad'            THEN 'Ad watched'
          WHEN 'target_complete'     THEN 'Daily target completed'
          WHEN 'daily_login'         THEN 'Daily login bonus'
          WHEN 'profile_complete'    THEN 'Profile completed'
          WHEN 'achievement'         THEN 'Achievement unlocked'
          WHEN 'leaderboard_reward'  THEN 'Leaderboard reward'
          WHEN 'tier_promotion'      THEN 'Tier promotion bonus'
          WHEN 'weekly_challenge'    THEN 'Challenge completed'
          WHEN 'streak_7'            THEN '7-day streak bonus'
          WHEN 'streak_30'           THEN '30-day streak bonus'
          WHEN 'mock_top10'          THEN 'Top 10 in mock test'
          WHEN 'subscription_bonus'  THEN 'Subscription bonus'
          ELSE description
        END                  AS subtitle,
        amount               AS coins,
        type,
        action               AS icon,
        created_at           AS date
      FROM coin_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    return successResponse({ transactions: txns });
  }

  // ── POST /coins/check-in ─────────────────────────────────────
  // Idempotent — safe to call multiple times per day. Reward ladder
  // (days 1-7) is admin-editable via app_settings.checkin_streak_rewards
  // (Coins page → Economy).
  async checkIn(userId: string) {
    const todayUTC = new Date().toISOString().slice(0, 10);

    // Check if already checked in today
    const existing = await this.db.query(`
      SELECT 1 FROM coin_transactions
      WHERE user_id = $1 AND action = 'daily_checkin'
        AND DATE(created_at AT TIME ZONE 'UTC') = $2
    `, [userId, todayUTC]);

    if (existing.length > 0) {
      const [user] = await this.db.query(`
        SELECT coins, total_coins_earned, streak FROM users WHERE id=$1
      `, [userId]);
      return successResponse({
        balance:           user.coins,
        totalEarned:       user.total_coins_earned,
        check_in_streak:   user.streak,
        checked_in_today:  true,
        alreadyCheckedIn:  true,
      }, 'Already checked in today! Come back tomorrow.');
    }

    // Determine streak
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const [user] = await this.db.query(
      `SELECT coins, total_coins_earned, streak, COALESCE(last_check_in_date, NULL) AS lci FROM users WHERE id=$1`,
      [userId]
    );
    const lastDate = user.lci ? new Date(user.lci).toISOString().slice(0, 10) : null;
    const newStreak = lastDate === yesterdayStr ? (user.streak ?? 0) + 1 : 1;

    // Day 7 bonus or normal reward — ladder is admin-editable
    const economy   = await readEconomySettings(this.db, this.cache);
    const dayIndex  = Math.min(newStreak - 1, 6);
    const coinsEarned = economy.checkInRewards[dayIndex] ?? DEFAULT_CHECKIN_REWARDS[dayIndex];

    // Award coins + update streak atomically
    // FIX: separate UPDATE then SELECT — RETURNING COALESCE returns NULL
    // when the coins column was NULL before update (Postgres returns pre-update value).
    await this.db.query(`
      UPDATE users
      SET coins              = COALESCE(coins, 0) + $1,
          total_coins_earned = COALESCE(total_coins_earned, 0) + $1,
          streak             = $2,
          last_check_in_date = NOW()
      WHERE id = $3
    `, [coinsEarned, newStreak, userId]);

    const [updated] = await this.db.query(
      `SELECT coins, total_coins_earned, streak FROM users WHERE id = $1`,
      [userId]
    );
    const balance = updated.coins ?? 0;

    // Record transaction (balance is now guaranteed non-null)
    await this.db.query(`
      INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
      VALUES ($1, 'earned', $2, $3, 'daily_checkin', $4)
    `, [userId, coinsEarned, `Daily Check-in — Day ${newStreak}`, balance]);

    const message = newStreak === 7
      ? `🎉 7-day streak! Bonus +${coinsEarned} coins!`
      : `✅ Day ${newStreak} check-in! +${coinsEarned} coins`;

    return successResponse({
      balance,
      totalEarned:       updated.total_coins_earned,
      check_in_streak:   newStreak,   // snake_case → Android @SerializedName("check_in_streak")
      checked_in_today:  true,        // snake_case → Android @SerializedName("checked_in_today")
      coinsEarned,
    }, message);
  }

  // ── POST /coins/ad-reward ─────────────────────────────────────
  // Credits coins for watching a rewarded ad via the shared awardCoins
  // helper (action='ad_watch') — respects the master switch, the
  // admin-configured amount (coin_rules.ad_watch.coins_awarded) and
  // its daily cap, and records a coin_transaction so it shows in history.
  async recordAdReward(userId: string, source: string = 'wallet') {
    const coinsEarned = await this.authService.awardCoins(userId, 'ad_watch');

    const [updated] = await this.db.query(
      `SELECT coins, total_coins_earned FROM users WHERE id = $1`, [userId]
    );
    const balance = updated?.coins ?? 0;

    if (coinsEarned <= 0) {
      return successResponse({
        balance, coinsEarned: 0, totalEarned: updated?.total_coins_earned ?? 0,
      }, "Thanks for watching! You've reached today's ad-reward limit.");
    }

    return successResponse({
      balance,
      coinsEarned,
      totalEarned: updated?.total_coins_earned ?? 0,
    }, `+${coinsEarned} coins earned! 🪙`);
  }

  // ── GET /coins/ad-config ──────────────────────────────────────
  // coinsPerAd now comes from coin_rules.ad_watch (the same number the
  // admin edits on the Coins page); minAdsPerSession is a session-config
  // setting in app_settings.
  async getAdConfig() {
    const economy = await readEconomySettings(this.db, this.cache);
    const [rule] = await this.db.query(
      `SELECT coins_awarded FROM coin_rules WHERE action='ad_watch'`
    ).catch(() => []);
    return successResponse({
      coinsPerAd:       Number(rule?.coins_awarded ?? 5),
      minAdsPerSession: economy.adMinPerSession,
    });
  }

  // ── GET /coins/config ─────────────────────────────────────────
  // Single feed the Android app reads on startup (and refreshes from
  // the Wallet screen): every coin_rules row + economy settings +
  // the check-in ladder. Cached 5 min, invalidated on any admin write.
  async getConfig() {
    const cacheKey = 'coins:config';
    const cached = await this.cache.get<Record<string, any>>(cacheKey);
    if (cached) return successResponse(cached);

    const rules = await this.db.query(`
      SELECT action, coins_awarded, max_per_day, is_active, category, icon, unit_label
      FROM coin_rules ORDER BY action
    `);
    const ruleMap: Record<string, any> = {};
    for (const r of rules) {
      ruleMap[r.action] = {
        coins:     Number(r.coins_awarded),
        maxPerDay: Number(r.max_per_day),
        active:    r.is_active,
        category:  r.category,
        icon:      r.icon,
        unitLabel: r.unit_label,
      };
    }

    const economy = await readEconomySettings(this.db, this.cache);
    const payload = {
      enabled: economy.enabled,
      rules:   ruleMap,
      economy: {
        coinToInrRate:                  economy.coinToInrRate,
        maxCoinsPerPurchase:            economy.maxCoinsPerPurchase,
        maxCoinDiscountPctSubscription: economy.maxCoinDiscountPctSubscription,
      },
      checkInRewards: economy.checkInRewards,
    };

    await this.cache.set(cacheKey, payload, 300);
    return successResponse(payload);
  }

  // ── POST /coins/tasks/:id/claim ───────────────────────────────
  // ad_watch and study_session are the only actions genuinely
  // "claimed" by tapping — the other three cards are awarded
  // automatically by their real flows (quiz completion, material
  // approval, referral signup), so claiming them never double-pays;
  // it just reports today's status. This also closes a real exploit
  // where tapping "Invite" used to grant a referral bonus with no
  // friend ever having signed up.
  async claimTask(taskId: string, userId: string) {
    const task = WALLET_TASKS.find(t => t.action === taskId);
    if (!task) throw new NotFoundException(`Task '${taskId}' not found`);

    const [u] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
    const balance = u?.coins ?? 0;

    if (taskId === 'ad_watch') {
      const coinsEarned = await this.authService.awardCoins(userId, 'ad_watch');
      if (coinsEarned <= 0) {
        return successResponse({ balance, alreadyClaimed: true },
          "You've reached today's ad-reward limit. Come back tomorrow!");
      }
      return successResponse({ balance: balance + coinsEarned, coinsEarned }, `+${coinsEarned} coins earned! 🪙`);
    }

    if (taskId === 'referral_signup') {
      return successResponse({ balance, alreadyClaimed: true },
        'Referral bonuses are credited automatically when your friend joins! 🤝');
    }

    if (taskId === 'study_session') {
      const studied = await this.db.query(`
        SELECT 1 FROM study_sessions
        WHERE user_id=$1 AND started_at::date = CURRENT_DATE AND active_minutes >= 30 LIMIT 1
      `, [userId]).catch(() => []);
      if (!studied.length) {
        return successResponse({ balance, alreadyClaimed: false },
          'Study for 30+ minutes today to unlock this reward!');
      }
      const coinsEarned = await this.authService.awardCoins(userId, 'study_session');
      if (coinsEarned <= 0) {
        return successResponse({ balance, alreadyClaimed: true }, 'Already claimed today!');
      }
      return successResponse({ balance: balance + coinsEarned, coinsEarned }, `+${coinsEarned} coins earned!`);
    }

    // daily_quiz / material_upload — credited automatically the moment
    // the real activity happens; never double-award from a tap here.
    const [done] = await this.db.query(`
      SELECT 1 FROM coin_transactions WHERE user_id=$1 AND action=$2 AND created_at::date = CURRENT_DATE LIMIT 1
    `, [userId, taskId]);
    return done
      ? successResponse({ balance, alreadyClaimed: true }, 'Already earned today — nice work! 🎉')
      : successResponse({ balance, alreadyClaimed: false }, 'This is awarded automatically once you complete it!');
  }

  // ── Coin Store ───────────────────────────────────────────────

  async getStoreItems(userId: string) {
    const items = await this.db.query(`
      SELECT id, title, description, coin_cost, item_type, item_value, icon_url, stock, sort_order
      FROM coin_store_items WHERE is_active = TRUE ORDER BY sort_order ASC
    `);
    const [{ balance }] = await this.db.query(`SELECT COALESCE(SUM(amount),0)::int AS balance FROM coin_transactions WHERE user_id=$1`, [userId]);
    return successResponse({ items, balance: +balance });
  }

  async redeemStoreItem(userId: string, itemId: string) {
    const [item] = await this.db.query(
      `SELECT * FROM coin_store_items WHERE id=$1 AND is_active=TRUE LIMIT 1`, [itemId]
    );
    if (!item) throw new (await import('@nestjs/common')).NotFoundException('Item not found');

    const [{ balance }] = await this.db.query(
      `SELECT COALESCE(SUM(amount),0)::int AS balance FROM coin_transactions WHERE user_id=$1`, [userId]
    );
    if (+balance < item.coin_cost)
      throw new (await import('@nestjs/common')).BadRequestException('Insufficient coins');

    if (item.stock !== null && item.stock <= 0)
      throw new (await import('@nestjs/common')).BadRequestException('Item out of stock');

    await this.db.query(
      `INSERT INTO coin_transactions(user_id,amount,action,description) VALUES($1,$2,'store_redeem',$3)`,
      [userId, -item.coin_cost, `Redeemed: ${item.title}`]
    );
    await this.db.query(
      `INSERT INTO coin_redemptions(user_id,item_id,coins_spent) VALUES($1,$2,$3)`,
      [userId, itemId, item.coin_cost]
    );
    if (item.stock !== null) {
      await this.db.query(`UPDATE coin_store_items SET stock=stock-1 WHERE id=$1`, [itemId]);
    }
    const [{ newBalance }] = await this.db.query(
      `SELECT COALESCE(SUM(amount),0)::int AS "newBalance" FROM coin_transactions WHERE user_id=$1`, [userId]
    );
    return successResponse({ balance: +newBalance, item: { id: item.id, title: item.title, itemType: item.item_type, itemValue: item.item_value } }, 'Redeemed successfully! 🎉');
  }
}

// ════════════════════════════════════════════════════════════
// CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Coins Wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('coins')
export class CoinsController {
  constructor(private readonly svc: CoinsService) {}

  /** GET /coins/balance */
  @Get('balance')
  getBalance(@Req() r: any) { return this.svc.getBalance(r.user.id); }

  /** GET /coins/tasks */
  @Get('tasks')
  getTasks(@Req() r: any) { return this.svc.getEarnTasks(r.user.id); }

  /** GET /coins/transactions?page=1&limit=20 */
  @Get('transactions')
  getTransactions(
    @Req() r: any,
    @Query('limit') limit = 20,
    @Query('page')  page  = 1
  ) { return this.svc.getTransactions(r.user.id, +limit, +page); }

  /** GET /coins/config — full rules + economy config for the app */
  @Get('config')
  getConfig() { return this.svc.getConfig(); }

  /** POST /coins/check-in */
  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  checkIn(@Req() r: any) { return this.svc.checkIn(r.user.id); }

  /** POST /coins/tasks/:id/claim */
  @Post('tasks/:id/claim')
  @HttpCode(HttpStatus.OK)
  claimTask(@Param('id') id: string, @Req() r: any) {
    return this.svc.claimTask(id, r.user.id);
  }

  /** POST /coins/ad-reward — credit coins after watching a rewarded ad */
  @Post('ad-reward')
  @HttpCode(HttpStatus.OK)
  recordAdReward(@Req() r: any, @Body() body: { source?: string }) {
    return this.svc.recordAdReward(r.user.id, body?.source || 'wallet');
  }

  /** GET /coins/ad-config — fetch admin-configured coins per ad */
  @Get('ad-config')
  getAdConfig() {
    return this.svc.getAdConfig();
  }

  // ── Coin Store ───────────────────────────────────────────────

  /** GET /coins/store — list active store items */
  @Get('store')
  getStoreItems(@Req() r: any) {
    return this.svc.getStoreItems(r.user.id);
  }

  /** POST /coins/store/:itemId/redeem — spend coins on an item */
  @Post('store/:itemId/redeem')
  @HttpCode(HttpStatus.OK)
  redeemStoreItem(@Param('itemId') itemId: string, @Req() r: any) {
    return this.svc.redeemStoreItem(r.user.id, itemId);
  }
}

// ════════════════════════════════════════════════════════════
// ADMIN COINS — powers admin.bpscnotes.in/coins, the ONE page for
// every coin-related setting in the app.
// ════════════════════════════════════════════════════════════
@Injectable()
export class AdminCoinsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** GET /admin/coins/ad-config — legacy alias of the ad fields in economy */
  async getAdConfig() {
    const economy = await readEconomySettings(this.db, this.cache);
    const [rule] = await this.db.query(
      `SELECT coins_awarded FROM coin_rules WHERE action='ad_watch'`
    ).catch(() => []);
    return successResponse({
      coinsPerAd:       Number(rule?.coins_awarded ?? 5),
      minAdsPerSession: economy.adMinPerSession,
    });
  }

  /** PUT /admin/coins/ad-config — legacy alias; writes the same fields
   *  the unified Economy panel does (coin_rules.ad_watch + app_settings) */
  async updateAdConfig(dto: { coinsPerAd?: number; minAdsPerSession?: number }) {
    if (dto.coinsPerAd !== undefined) {
      await this.db.query(`UPDATE coin_rules SET coins_awarded=$1, updated_at=NOW() WHERE action='ad_watch'`, [dto.coinsPerAd]);
    }
    if (dto.minAdsPerSession !== undefined) {
      await this.db.query(`
        INSERT INTO app_settings (key, value, updated_at) VALUES ('ad_min_per_session',$1,NOW())
        ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()
      `, [String(dto.minAdsPerSession)]);
    }
    await invalidateCoinsCache(this.cache);
    return this.getAdConfig();
  }

  /** GET /admin/coins/economy — the master switch + every economy-wide
   *  number that isn't a per-action rule */
  async getEconomy() {
    const economy = await readEconomySettings(this.db, this.cache);
    return successResponse({ economy });
  }

  /** PUT /admin/coins/economy */
  async updateEconomy(dto: {
    enabled?: boolean;
    coinToInrRate?: number;
    maxCoinsPerPurchase?: number;
    maxCoinDiscountPctSubscription?: number;
    adMinPerSession?: number;
    checkInRewards?: number[];
  }) {
    const upsert = async (key: string, value: string) => {
      await this.db.query(`
        INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
      `, [key, value]);
    };

    if (dto.enabled !== undefined) {
      await upsert('coin_system_enabled', dto.enabled ? 'true' : 'false');
    }
    if (dto.coinToInrRate !== undefined) {
      const v = Number(dto.coinToInrRate);
      if (!isFinite(v) || v < 0) throw new BadRequestException('coinToInrRate must be a non-negative number');
      await upsert('coin_to_inr_rate', String(v));
    }
    if (dto.maxCoinDiscountPctCourse !== undefined) {
      const v = Math.round(Number(dto.maxCoinDiscountPctCourse));
      if (!isFinite(v) || v < 0 || v > 100) throw new BadRequestException('maxCoinDiscountPctCourse must be between 0 and 100');
      await upsert('max_coin_discount_pct_course', String(v));
    }
    if (dto.maxCoinDiscountPctSubscription !== undefined) {
      const v = Math.round(Number(dto.maxCoinDiscountPctSubscription));
      if (!isFinite(v) || v < 0 || v > 100) throw new BadRequestException('maxCoinDiscountPctSubscription must be between 0 and 100');
      await upsert('max_coin_discount_pct_subscription', String(v));
    }
    if (dto.adMinPerSession !== undefined) {
      const v = Math.round(Number(dto.adMinPerSession));
      if (!isFinite(v) || v < 0) throw new BadRequestException('adMinPerSession must be a non-negative number');
      await upsert('ad_min_per_session', String(v));
    }
    if (dto.checkInRewards !== undefined) {
      const arr = dto.checkInRewards;
      if (!Array.isArray(arr) || arr.length !== 7 || arr.some(n => typeof n !== 'number' || !isFinite(n) || n < 0)) {
        throw new BadRequestException('checkInRewards must be an array of 7 non-negative numbers (days 1-7)');
      }
      await upsert('checkin_streak_rewards', arr.map(n => Math.round(n)).join(','));
    }

    await invalidateCoinsCache(this.cache);
    return this.getEconomy();
  }

  async getStats() {
    const [row] = await this.db.query(`
      SELECT
        COALESCE(SUM(coins), 0)::int               AS total_circulating,
        COALESCE(SUM(total_coins_earned), 0)::int  AS total_ever_earned,
        COUNT(*)::int                              AS wallets_with_coins,
        (SELECT COUNT(*)::int FROM coin_transactions
          WHERE created_at >= NOW() - INTERVAL '24 hours')  AS txns_today,
        (SELECT COALESCE(SUM(amount), 0)::int FROM coin_transactions
          WHERE type='earned' AND created_at >= NOW() - INTERVAL '24 hours') AS earned_today,
        (SELECT COALESCE(SUM(amount), 0)::int FROM coin_transactions
          WHERE type='earned' AND created_at >= NOW() - INTERVAL '7 days')   AS earned_this_week
      FROM users
      WHERE coins > 0
    `);
    const economy = await readEconomySettings(this.db, this.cache);
    return successResponse({ stats: { ...row, coin_system_enabled: economy.enabled } });
  }

  async getAdminStoreItems() {
    const items = await this.db.query(`
      SELECT id, title, description, coin_cost, item_type, item_value, icon_url,
             stock, sort_order, is_active, created_at,
             (SELECT COUNT(*)::int FROM coin_redemptions WHERE item_id = csi.id) AS redemption_count
      FROM coin_store_items csi ORDER BY sort_order ASC, created_at DESC
    `);
    return successResponse({ items });
  }

  async createStoreItem(dto: any) {
    const { title, coinCost, description, itemType, itemValue, iconUrl, stock, sortOrder, isActive } = dto;
    if (!title || coinCost === undefined) throw new BadRequestException('title and coinCost are required');
    await this.db.query(`
      INSERT INTO coin_store_items (title, description, coin_cost, item_type, item_value, icon_url, stock, sort_order, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [title, description ?? null, +coinCost, itemType ?? 'badge', itemValue ?? null, iconUrl ?? null,
        stock !== undefined && stock !== null ? +stock : null, +(sortOrder ?? 0), isActive !== false]);
    return successResponse(null, 'Store item created ✅');
  }

  async updateStoreItem(id: string, dto: any) {
    const fields: string[] = []; const vals: any[] = []; let i = 1;
    if (dto.title       !== undefined) { fields.push(`title=$${i++}`);       vals.push(dto.title); }
    if (dto.description !== undefined) { fields.push(`description=$${i++}`); vals.push(dto.description ?? null); }
    if (dto.coinCost    !== undefined) { fields.push(`coin_cost=$${i++}`);   vals.push(+dto.coinCost); }
    if (dto.itemType    !== undefined) { fields.push(`item_type=$${i++}`);   vals.push(dto.itemType); }
    if (dto.itemValue   !== undefined) { fields.push(`item_value=$${i++}`);  vals.push(dto.itemValue ?? null); }
    if (dto.iconUrl     !== undefined) { fields.push(`icon_url=$${i++}`);    vals.push(dto.iconUrl ?? null); }
    if (dto.stock       !== undefined) { fields.push(`stock=$${i++}`);       vals.push(dto.stock === null ? null : +dto.stock); }
    if (dto.sortOrder   !== undefined) { fields.push(`sort_order=$${i++}`);  vals.push(+dto.sortOrder); }
    if (dto.isActive    !== undefined) { fields.push(`is_active=$${i++}`);   vals.push(dto.isActive); }
    if (!fields.length) return successResponse(null, 'Nothing to update');
    await this.db.query(`UPDATE coin_store_items SET ${fields.join(',')} WHERE id=$${i}`, [...vals, id]);
    return successResponse(null, 'Store item updated ✅');
  }

  async deleteStoreItem(id: string) {
    const [item] = await this.db.query(`SELECT id FROM coin_store_items WHERE id=$1`, [id]);
    if (!item) throw new NotFoundException('Item not found');
    await this.db.query(`DELETE FROM coin_store_items WHERE id=$1`, [id]);
    return successResponse(null, 'Item deleted');
  }

  async getRedemptions(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const rows = await this.db.query(`
      SELECT cr.id, cr.coins_spent, cr.created_at,
             u.name AS user_name, u.id AS user_id,
             si.title AS item_title, si.item_type
      FROM coin_redemptions cr
      JOIN users u ON u.id = cr.user_id
      JOIN coin_store_items si ON si.id = cr.item_id
      ORDER BY cr.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const [{ total }] = await this.db.query(`SELECT COUNT(*)::int AS total FROM coin_redemptions`);
    return successResponse({ redemptions: rows, total, page, limit });
  }

  async getTopEarners(limit = 20) {
    const rows = await this.db.query(`
      SELECT
        u.id,
        u.name,
        u.avatar_url,
        u.coins              AS "currentBalance",
        u.total_coins_earned AS "totalEarned",
        COUNT(ct.id)::int    AS "transactionCount",
        u.streak,
        u.primary_exam,
        u.district
      FROM users u
      LEFT JOIN coin_transactions ct
        ON ct.user_id = u.id
       AND ct.type = 'earned'
      WHERE u.total_coins_earned > 0
      GROUP BY u.id
      ORDER BY u.total_coins_earned DESC
      LIMIT $1
    `, [limit]);
    return successResponse({ earners: rows });
  }

  /** GET /admin/coins/rules — every coin-earning action, with category/
   *  icon/unit metadata so the admin UI needs no separate dictionary. */
  async getRules() {
    const dbRules = await this.db.query(`
      SELECT cr.*,
             (SELECT COALESCE(SUM(amount),0)::int FROM coin_transactions WHERE action=cr.action AND type='earned' AND created_at>=NOW()-INTERVAL '7 days') AS coins_7d,
             (SELECT COUNT(*)::int FROM coin_transactions WHERE action=cr.action AND created_at>=NOW()-INTERVAL '7 days') AS claims_7d
      FROM coin_rules cr
      ORDER BY cr.is_core DESC, cr.category ASC, cr.action ASC
    `);
    return successResponse({ rules: dbRules });
  }

  async createRule(data: any) {
    const { action, description, coinsAwarded, maxPerDay, isActive, category, icon, unitLabel } = data;
    if (!action || !description) throw new BadRequestException('action and description are required');
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(action)) {
      throw new BadRequestException('Action key must be lowercase snake_case, 2-50 characters (letters, numbers, underscores)');
    }
    const [existing] = await this.db.query(`SELECT id, is_core FROM coin_rules WHERE action=$1`, [action]);
    if (existing) {
      if (existing.is_core) {
        throw new BadRequestException(`'${action}' is a built-in action — edit it in the list instead of recreating it.`);
      }
      await this.db.query(
        `UPDATE coin_rules SET description=$1, coins_awarded=$2, max_per_day=$3, is_active=$4,
           category=COALESCE($5,category), icon=COALESCE($6,icon), unit_label=COALESCE($7,unit_label), updated_at=NOW()
         WHERE action=$8`,
        [description, coinsAwarded ?? 5, maxPerDay ?? 1, isActive !== false, category || null, icon || null, unitLabel || null, action]
      );
    } else {
      await this.db.query(
        `INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active, category, icon, unit_label, is_core)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)`,
        [action, description, coinsAwarded ?? 5, maxPerDay ?? 1, isActive !== false, category || 'custom', icon || '⚡', unitLabel || 'Custom rule']
      );
    }
    await invalidateCoinsCache(this.cache);
    return successResponse(null, 'Rule saved ✅');
  }

  async updateRule(ruleId: string, data: any) {
    const fields: string[] = []; const vals: any[] = []; let i = 1;
    if (data.description  !== undefined) { fields.push(`description=$${i++}`);   vals.push(data.description); }
    if (data.coinsAwarded !== undefined) { fields.push(`coins_awarded=$${i++}`); vals.push(data.coinsAwarded); }
    if (data.maxPerDay    !== undefined) { fields.push(`max_per_day=$${i++}`);   vals.push(data.maxPerDay); }
    if (data.isActive     !== undefined) { fields.push(`is_active=$${i++}`);     vals.push(data.isActive); }
    if (data.category     !== undefined) { fields.push(`category=$${i++}`);     vals.push(data.category); }
    if (data.icon         !== undefined) { fields.push(`icon=$${i++}`);         vals.push(data.icon); }
    if (data.unitLabel    !== undefined) { fields.push(`unit_label=$${i++}`);   vals.push(data.unitLabel); }
    if (fields.length) {
      fields.push('updated_at=NOW()');
      await this.db.query(`UPDATE coin_rules SET ${fields.join(',')} WHERE id=$${i}`, [...vals, ruleId]);
      await invalidateCoinsCache(this.cache);
    }
    return successResponse(null, 'Rule updated ✅');
  }

  async deleteRule(ruleId: string) {
    const [row] = await this.db.query(`SELECT action, is_core FROM coin_rules WHERE id=$1`, [ruleId]);
    if (!row) throw new NotFoundException('Rule not found');
    if (row.is_core) {
      throw new BadRequestException(`'${row.action}' is a built-in action and can't be deleted — turn off its toggle to deactivate it instead.`);
    }
    await this.db.query(`DELETE FROM coin_rules WHERE id=$1`, [ruleId]);
    await invalidateCoinsCache(this.cache);
    return successResponse(null, 'Rule deleted');
  }
}

@UseGuards(AdminJwtGuard)
@Controller('admin/coins')
export class AdminCoinsController {
  constructor(private readonly svc: AdminCoinsService) {}

  @Get('stats')
  getStats() { return this.svc.getStats(); }

  @Get('top-earners')
  getTopEarners(@Query('limit') limit = 20) { return this.svc.getTopEarners(+limit); }

  @Get('rules')
  getRules() { return this.svc.getRules(); }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  createRule(@Body() dto: any) { return this.svc.createRule(dto); }

  @Put('rules/:id')
  updateRule(@Param('id') id: string, @Body() dto: any) { return this.svc.updateRule(id, dto); }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.OK)
  deleteRule(@Param('id') id: string) { return this.svc.deleteRule(id); }

  /** GET/PUT /admin/coins/economy — master switch, coin↔₹ rate,
   *  redemption caps, check-in ladder, ad settings — everything that
   *  isn't a per-action rule, in one place. */
  @Get('economy')
  getEconomy() { return this.svc.getEconomy(); }

  @Put('economy')
  updateEconomy(@Body() dto: any) { return this.svc.updateEconomy(dto); }

  @Get('ad-config')
  getAdConfig() { return this.svc.getAdConfig(); }

  @Put('ad-config')
  updateAdConfig(@Body() dto: any) { return this.svc.updateAdConfig(dto); }

  @Get('store-items')
  getStoreItems() { return this.svc.getAdminStoreItems(); }

  @Post('store-items')
  @HttpCode(HttpStatus.CREATED)
  createStoreItem(@Body() dto: any) { return this.svc.createStoreItem(dto); }

  @Put('store-items/:id')
  updateStoreItem(@Param('id') id: string, @Body() dto: any) { return this.svc.updateStoreItem(id, dto); }

  @Delete('store-items/:id')
  @HttpCode(HttpStatus.OK)
  deleteStoreItem(@Param('id') id: string) { return this.svc.deleteStoreItem(id); }

  @Get('redemptions')
  getRedemptions(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.svc.getRedemptions(+page, +limit);
  }
}

@Module({
  imports:     [AuthModule],
  controllers: [CoinsController, AdminCoinsController],
  providers:   [CoinsService, AdminCoinsService],
  exports:     [CoinsService],
})
export class CoinsModule {}
