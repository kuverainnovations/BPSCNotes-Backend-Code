import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unify Coin Economy (Phase: Admin Coin Control Center)
 * ════════════════════════════════════════════════════════════════
 * PROBLEM
 * Coin amounts/limits for the ~20 actions that actually award coins
 * (see AuthService.COIN_DEFAULTS) lived in FOUR disconnected places:
 *
 *   1. coin_rules table        — admin-editable, but only ~7 of the
 *                                 real action keys had a row.
 *   2. AuthService.COIN_DEFAULTS — hardcoded fallback for the other
 *                                 ~15 actions (achievements, streaks,
 *                                 leaderboard, tier promotion, daily
 *                                 targets, study rooms, etc) — admin
 *                                 had ZERO visibility/control here.
 *   3. EARN_TASKS (coins.module.ts) — a third hardcoded list powering
 *                                 the Wallet's "Earn Tasks" cards and
 *                                 its claim endpoint, with its own
 *                                 action keys/amounts disconnected
 *                                 from coin_rules entirely.
 *   4. Scattered app_settings / env config for "economy" numbers
 *      (coin_value_inr, coin_to_inr_rate, business.coinValueInr,
 *      business.maxCoinDiscountSub, daily_login_coins,
 *      coin_system_enabled, ...) — overlapping keys, several of
 *      which were never read by any actual code path.
 *
 * FIX
 * coin_rules becomes the SINGLE source of truth for every coin-
 * earning action (23 canonical rows), extended with display metadata
 * (category/icon/unit_label/is_core) so the admin "Coins" page can
 * render a complete, categorised control panel without a separate
 * hardcoded dictionary. Existing admin-tuned values (coins_awarded /
 * max_per_day / is_active) are preserved — only metadata + missing
 * rows are added. A couple of rows that were seeded with a wrong
 * max_per_day by the old EARN_TASKS bootstrap (still sitting at that
 * exact buggy default) are corrected to match COIN_DEFAULTS intent.
 *
 * The economy-wide settings (coin→₹ rate, purchase redemption caps,
 * subscription discount cap, check-in reward ladder) are consolidated
 * into a small, clearly-named app_settings block. The old, dead/
 * duplicate keys (coin_value_inr, max_coin_discount_sub/course,
 * daily_login_coins, coins_per_correct/streak/study_hour,
 * ad_reward_coins) are removed — their one useful value
 * (ad_reward_coins, if customised) is migrated into
 * coin_rules.ad_watch.coins_awarded first.
 */
export class UnifyCoinEconomy1781700000000 implements MigrationInterface {
  name = 'UnifyCoinEconomy1781700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Extend coin_rules with display/control metadata ──────
    await queryRunner.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS category   VARCHAR(40)`);
    await queryRunner.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS icon       VARCHAR(10)`);
    await queryRunner.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS unit_label VARCHAR(120)`);
    await queryRunner.query(`ALTER TABLE coin_rules ADD COLUMN IF NOT EXISTS is_core    BOOLEAN NOT NULL DEFAULT FALSE`);

    // ── 2. Seed/refresh the 23 canonical actions ─────────────────
    // ON CONFLICT: refresh display metadata + mark as core, but never
    // touch coins_awarded/max_per_day/is_active on rows that already
    // exist — those reflect admin's own tuning (or the original
    // EARN_TASKS seed) and must be preserved.
    await queryRunner.query(`
      INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active, category, icon, unit_label, is_core)
      VALUES
        ('daily_quiz',          'Complete Daily Quiz',          10,  1,  TRUE, 'quizzes',      '📝', 'Per daily quiz, first time you pass it',            TRUE),
        ('mock_quiz',           'Complete Mock Test',           10,  3,  TRUE, 'quizzes',      '🎯', 'Per mock test, first time you pass it',             TRUE),
        ('topic_quiz',          'Complete Topic Quiz',          15,  5,  TRUE, 'quizzes',      '📚', 'Per topic-wise quiz, first time you pass it',       TRUE),
        ('study_room',          'Study Room Session',           5,   2,  TRUE, 'study',        '🏫', 'Per completed study/tier room session',             TRUE),
        ('study_session',       'Complete Study Session',       15,  1,  TRUE, 'study',        '⏱️', 'Wallet task: study for 30+ minutes in a day',        TRUE),
        ('active_recall',       'Active Recall Session',        5,   3,  TRUE, 'study',        '🧠', 'Reserved — not yet triggered by any flow (flashcard review)', TRUE),
        ('material_upload',     'Upload Study Material',        25,  1,  TRUE, 'content',      '📤', 'Per study note/material approved',                  TRUE),
        ('daily_login',         'Daily Login',                  5,   1,  TRUE, 'engagement',   '📅', 'Once per day, automatically on app open',           TRUE),
        ('referral_signup',     'Refer a Friend — Signup',      50,  5,  TRUE, 'social',       '🤝', 'When someone signs up with your referral code (1/3)',TRUE),
        ('referral_joined',     'Welcome Bonus (via referral)', 25,  1,  TRUE, 'social',       '🎁', 'One-time bonus for joining via someone''s referral code',TRUE),
        ('referral_engagement', 'Referral — Friend Engaged',    50,  1,  TRUE, 'social',       '🎓', 'When your referred friend enrolls or uploads (2/3)',TRUE),
        ('referral_active',     'Referral — Friend Active',     50,  1,  TRUE, 'social',       '🔥', 'When your referred friend completes 5 quizzes (3/3)',TRUE),
        ('profile_complete',    'Complete Profile',             20,  1,  TRUE, 'engagement',   '👤', 'Once, when all profile fields are filled in',       TRUE),
        ('ad_watch',            'Watch Rewarded Ad',            5,   3,  TRUE, 'ads',          '📺', 'Per rewarded ad watched to completion',             TRUE),
        ('achievement',         'Achievement Unlocked',         10,  10, TRUE, 'achievements', '🏅', 'Default reward — each achievement can override this',TRUE),
        ('leaderboard_reward',  'Leaderboard Reward',           50,  1,  TRUE, 'achievements', '🏆', 'Weekly leaderboard placement reward',               TRUE),
        ('tier_promotion',      'Tier Promotion',               20,  1,  TRUE, 'achievements', '⬆️', 'When promoted to a higher study tier',              TRUE),
        ('weekly_challenge',    'Weekly Challenge Completed',   30,  1,  TRUE, 'achievements', '🎮', 'Default reward — each challenge can override this',TRUE),
        ('streak_7',            '7-Day Streak Bonus',           15,  1,  TRUE, 'streaks',      '🔥', 'Reserved — not yet triggered by any flow (streak milestone)', TRUE),
        ('streak_30',           '30-Day Streak Bonus',          100, 1,  TRUE, 'streaks',      '🌟', 'Reserved — not yet triggered by any flow (streak milestone)', TRUE),
        ('mock_top10',          'Mock Test Top 10',             100, 1,  TRUE, 'streaks',      '🥇', 'Reserved — not yet triggered by any flow (mock leaderboard)', TRUE),
        ('target_complete',     'Daily Target Completed',       1,   20, TRUE, 'targets',      '✅', 'Per daily study target marked complete',            TRUE),
        ('subscription_bonus',  'Subscription Bonus (fallback)',0,   1,  TRUE, 'subscriptions','💎', 'Used only if a plan has no bonus coins of its own', TRUE)
      ON CONFLICT (action) DO UPDATE SET
        category   = EXCLUDED.category,
        icon       = EXCLUDED.icon,
        unit_label = EXCLUDED.unit_label,
        is_core    = TRUE,
        updated_at = NOW()
    `);

    // ── 3. Correct a row that inherited a wrong max_per_day from the
    //      old EARN_TASKS bootstrap (which hardcoded max_per_day=1 for
    //      every row it seeded). Only fires if still sitting at that
    //      exact untouched buggy value — any admin customisation is
    //      left alone.
    await queryRunner.query(`
      UPDATE coin_rules SET max_per_day = 3, updated_at = NOW()
      WHERE action = 'ad_watch' AND max_per_day = 1
    `);

    // ── 3b. The old EARN_TASKS bootstrap also seeded a row for action
    //      'referral' (75 coins) — but no code path has ever read this
    //      key; the real referral-signup bonus uses action
    //      'referral_signup' (seeded above with its own admin-editable
    //      row). Remove the dead duplicate so it doesn't confuse admins.
    await queryRunner.query(`DELETE FROM coin_rules WHERE action = 'referral'`);

    // ── 4. Migrate any admin-customised ad_reward_coins value into
    //      coin_rules.ad_watch (the new single source for "coins per
    //      rewarded ad"). No-op if ad_reward_coins was never set.
    await queryRunner.query(`
      UPDATE coin_rules cr SET coins_awarded = s.value::int, updated_at = NOW()
      FROM app_settings s
      WHERE cr.action = 'ad_watch' AND s.key = 'ad_reward_coins'
        AND s.value ~ '^[0-9]+$'
    `);

    // ── 5. Tag any other pre-existing rows (e.g. legacy
    //      'quiz_attempt') so the admin UI never renders a row with
    //      missing metadata.
    await queryRunner.query(`
      UPDATE coin_rules SET
        category   = 'legacy',
        icon       = COALESCE(icon, '🗄️'),
        unit_label = 'Not triggered by any current action — safe to deactivate',
        is_core    = FALSE,
        updated_at = NOW()
      WHERE action = 'quiz_attempt'
    `);
    await queryRunner.query(`
      UPDATE coin_rules SET
        category   = 'custom',
        icon       = COALESCE(icon, '⚡'),
        unit_label = COALESCE(unit_label, 'Custom rule'),
        updated_at = NOW()
      WHERE category IS NULL
    `);

    // ── 6. Consolidated economy settings ─────────────────────────
    await queryRunner.query(`
      INSERT INTO app_settings (key, value, description) VALUES
        ('coin_system_enabled',               'true', 'Master switch — when false, no coins are earned or spent anywhere in the app'),
        ('coin_to_inr_rate',                  '1',    'Rupee value of 1 coin when applied as a discount on a purchase'),
        ('max_coins_per_purchase',            '50',   'Default max coins a buyer can apply as a discount on a course/material (per-item override exists on courses)'),
        ('max_coin_discount_pct_subscription','30',   'Max percentage of a subscription price that can be paid with coins'),
        ('checkin_streak_rewards',            '5,5,10,10,15,15,25', 'Comma-separated coin rewards for daily check-in streak days 1-7'),
        ('ad_min_per_session',                '2',    'Minimum rewarded ads a student should watch per study session')
      ON CONFLICT (key) DO NOTHING
    `);

    // ── 7. Remove now-superseded / dead settings ─────────────────
    await queryRunner.query(`
      DELETE FROM app_settings WHERE key IN (
        'coin_value_inr', 'max_coin_discount_sub', 'max_coin_discount_course',
        'daily_login_coins', 'coins_per_correct', 'coins_per_streak_day',
        'coins_per_study_hour', 'ad_reward_coins'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Schema rollback only — the data consolidation above intentionally
    // does not attempt to reconstruct the old scattered key set.
    await queryRunner.query(`ALTER TABLE coin_rules DROP COLUMN IF EXISTS category`);
    await queryRunner.query(`ALTER TABLE coin_rules DROP COLUMN IF EXISTS icon`);
    await queryRunner.query(`ALTER TABLE coin_rules DROP COLUMN IF EXISTS unit_label`);
    await queryRunner.query(`ALTER TABLE coin_rules DROP COLUMN IF EXISTS is_core`);
    await queryRunner.query(`
      DELETE FROM app_settings WHERE key IN (
        'max_coin_discount_pct_subscription', 'checkin_streak_rewards'
      )
    `);
  }
}
