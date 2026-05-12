import { MigrationInterface, QueryRunner } from 'typeorm';

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION: Tier-Based Study Room System — Phase 1
// Adds: room_tiers, tier_progression_rules, user_room_tier,
//       study_sessions, xp_levels, room_leaderboard,
//       achievement_types, user_achievements,
//       weekly_challenges, user_challenge_progress
// Also: ALTER users to add xp, xp_level, room_tier_id
// ─────────────────────────────────────────────────────────────────────────────
export class TierRoomSystem1746700000000 implements MigrationInterface {
  name = 'TierRoomSystem1746700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── New enums ──────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE session_mode AS ENUM ('study', 'pomodoro', 'silent');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE leaderboard_period AS ENUM ('weekly', 'monthly', 'alltime');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE achievement_category AS ENUM ('study', 'streak', 'quiz', 'social', 'tier', 'challenge');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── room_tiers ─────────────────────────────────────────────
    // Four permanent tiers. Admin can edit metadata, multipliers, perks.
    // sort_order determines unlock sequence: 1=Silver → 4=Diamond.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS room_tiers (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tier_key         VARCHAR(20) UNIQUE NOT NULL,
        name             VARCHAR(50) NOT NULL,
        description      TEXT,
        color_hex        VARCHAR(7) NOT NULL DEFAULT '#C0C0C0',
        icon_emoji       VARCHAR(10) NOT NULL DEFAULT '🎯',
        sort_order       INTEGER NOT NULL DEFAULT 1,
        max_members      INTEGER NOT NULL DEFAULT 500,
        -- Coin multiplier applied to study-time coin awards
        coin_multiplier  DECIMAL(4,2) NOT NULL DEFAULT 1.00,
        -- XP multiplier applied to all XP awards in this tier
        xp_multiplier    DECIMAL(4,2) NOT NULL DEFAULT 1.00,
        -- JSON array of perk strings shown in UI
        -- e.g. ["1.5x coins per hour", "Exclusive Gold-only notes"]
        perks            JSONB NOT NULL DEFAULT '[]',
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── tier_progression_rules ─────────────────────────────────
    // Admin configures when a user moves from tier A to tier B.
    // ALL non-zero conditions must be satisfied (AND logic).
    // evaluation_window_days: stats measured over this rolling window.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tier_progression_rules (
        id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        from_tier_id             UUID NOT NULL REFERENCES room_tiers(id) ON DELETE CASCADE,
        to_tier_id               UUID NOT NULL REFERENCES room_tiers(id) ON DELETE CASCADE,
        -- Promotion conditions (0 = ignored)
        min_total_study_hours    DECIMAL(8,2) NOT NULL DEFAULT 0,
        min_streak_days          INTEGER NOT NULL DEFAULT 0,
        min_weekly_study_hours   DECIMAL(6,2) NOT NULL DEFAULT 0,
        min_quizzes_completed    INTEGER NOT NULL DEFAULT 0,
        min_goals_completed      INTEGER NOT NULL DEFAULT 0,
        min_coins_earned_total   INTEGER NOT NULL DEFAULT 0,
        min_accuracy_pct         DECIMAL(5,2) NOT NULL DEFAULT 0,
        -- Rolling window for weekly conditions
        evaluation_window_days   INTEGER NOT NULL DEFAULT 7,
        -- Demotion: if user scores below this % of requirements for grace_days
        demotion_threshold_pct   DECIMAL(5,2) NOT NULL DEFAULT 50.00,
        demotion_grace_days      INTEGER NOT NULL DEFAULT 3,
        is_active                BOOLEAN NOT NULL DEFAULT TRUE,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(from_tier_id, to_tier_id)
      )
    `);

    // ── user_room_tier ─────────────────────────────────────────
    // One row per user. Tracks current tier + progression toward next.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_room_tier (
        user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        current_tier_id       UUID NOT NULL REFERENCES room_tiers(id),
        previous_tier_id      UUID REFERENCES room_tiers(id),
        promoted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tier_joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- Progress 0.0000–1.0000 toward next tier (computed by cron)
        next_tier_progress    DECIMAL(5,4) NOT NULL DEFAULT 0.0000,
        -- Demotion grace: user cannot be demoted until this date
        demotion_grace_until  TIMESTAMPTZ,
        -- Snapshot timestamp of last cron evaluation
        last_evaluated_at     TIMESTAMPTZ,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── study_sessions ─────────────────────────────────────────
    // One row per study session. Heartbeat updates last_heartbeat.
    // AFK detected when gap > 7 minutes between heartbeats.
    // Coins awarded per verified active heartbeat interval.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS study_sessions (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- room_id: NULL means solo study (not in a tier room)
        room_id          UUID REFERENCES study_rooms(id) ON DELETE SET NULL,
        tier_id          UUID REFERENCES room_tiers(id) ON DELETE SET NULL,
        started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at         TIMESTAMPTZ,
        -- Set on session end from (ended_at - started_at) minus AFK periods
        duration_minutes INTEGER,
        -- Verified active minutes (excludes AFK gaps)
        active_minutes   INTEGER NOT NULL DEFAULT 0,
        last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- Consecutive AFK detections in this session
        afk_count        INTEGER NOT NULL DEFAULT 0,
        is_focus_mode    BOOLEAN NOT NULL DEFAULT FALSE,
        mode             session_mode NOT NULL DEFAULT 'study',
        coins_earned     INTEGER NOT NULL DEFAULT 0,
        xp_earned        INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── xp_levels ──────────────────────────────────────────────
    // Defines XP thresholds for each level. Admin can adjust via seed/migration.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS xp_levels (
        level        INTEGER PRIMARY KEY,
        xp_required  INTEGER NOT NULL,
        title        VARCHAR(50) NOT NULL,
        badge_emoji  VARCHAR(10) NOT NULL DEFAULT '⭐',
        -- Bonus coins awarded when user reaches this level
        coin_bonus   INTEGER NOT NULL DEFAULT 0
      )
    `);

    // ── room_leaderboard ───────────────────────────────────────
    // Cron-computed snapshots. Never queried ad-hoc across raw sessions.
    // period_key examples: '2026-W19' (weekly), '2026-05' (monthly)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS room_leaderboard (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tier_id          UUID NOT NULL REFERENCES room_tiers(id) ON DELETE CASCADE,
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_type      leaderboard_period NOT NULL,
        period_key       VARCHAR(20) NOT NULL,
        study_minutes    INTEGER NOT NULL DEFAULT 0,
        coins_earned     INTEGER NOT NULL DEFAULT 0,
        xp_earned        INTEGER NOT NULL DEFAULT 0,
        goals_completed  INTEGER NOT NULL DEFAULT 0,
        streak_days      INTEGER NOT NULL DEFAULT 0,
        -- Rank within this tier+period (1 = top)
        rank_position    INTEGER,
        computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tier_id, user_id, period_type, period_key)
      )
    `);

    // ── achievement_types ──────────────────────────────────────
    // Catalog of all achievements. Admin manages via admin panel.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS achievement_types (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key           VARCHAR(50) UNIQUE NOT NULL,
        title         VARCHAR(100) NOT NULL,
        description   TEXT NOT NULL,
        emoji         VARCHAR(10) NOT NULL DEFAULT '🏅',
        category      achievement_category NOT NULL DEFAULT 'study',
        -- JSON condition: { "type": "study_hours", "threshold": 10 }
        -- Supported types: study_hours | streak_days | quizzes | goals | tier_reach | coins
        condition     JSONB NOT NULL,
        coins_reward  INTEGER NOT NULL DEFAULT 0,
        xp_reward     INTEGER NOT NULL DEFAULT 0,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── user_achievements ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement_type_id   UUID NOT NULL REFERENCES achievement_types(id) ON DELETE CASCADE,
        earned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, achievement_type_id)
      )
    `);

    // ── weekly_challenges ──────────────────────────────────────
    // Admin creates challenges each week. System tracks progress.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS weekly_challenges (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(200) NOT NULL,
        description     TEXT,
        emoji           VARCHAR(10) NOT NULL DEFAULT '🎯',
        -- ISO week key: '2026-W19'
        period_key      VARCHAR(20) NOT NULL,
        -- NULL = visible to all tiers; set a tier_id to restrict
        target_tier_id  UUID REFERENCES room_tiers(id) ON DELETE SET NULL,
        -- JSON goal: { "type": "study_hours", "target": 10 }
        -- Supported types: study_hours | quizzes | goals | streak_days | sessions
        goal            JSONB NOT NULL,
        coins_reward    INTEGER NOT NULL DEFAULT 0,
        xp_reward       INTEGER NOT NULL DEFAULT 0,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── user_challenge_progress ────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_challenge_progress (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        challenge_id    UUID NOT NULL REFERENCES weekly_challenges(id) ON DELETE CASCADE,
        current_value   DECIMAL(10,2) NOT NULL DEFAULT 0,
        is_completed    BOOLEAN NOT NULL DEFAULT FALSE,
        completed_at    TIMESTAMPTZ,
        reward_claimed  BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(user_id, challenge_id)
      )
    `);

    // ── ALTER users — add XP + tier reference ─────────────────
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS xp           INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS xp_level     INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS room_tier_id UUID REFERENCES room_tiers(id) ON DELETE SET NULL
    `);

    // ── Add coin_rule for study_time if missing ────────────────
    await queryRunner.query(`
      INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active)
      VALUES ('study_time', 'Coins earned per hour of active study', 6, 24, TRUE)
      ON CONFLICT (action) DO NOTHING
    `);

    // ── SEED: Four permanent tier rooms ───────────────────────
    await queryRunner.query(`
      INSERT INTO room_tiers
        (tier_key, name, description, color_hex, icon_emoji, sort_order, max_members,
         coin_multiplier, xp_multiplier, perks)
      VALUES
        ('silver', 'Silver Room', 'Entry level room. All new students start here.',
         '#9E9E9E', '🥈', 1, 1000, 1.00, 1.00,
         '["6 coins/hour study", "Daily streaks tracked", "Access to basic challenges"]'),
        ('gold', 'Gold Room', 'Earned room for consistent students.',
         '#FFC107', '🥇', 2, 500, 1.50, 1.25,
         '["9 coins/hour study", "1.25x XP multiplier", "Gold-only weekly challenges", "Priority quiz access"]'),
        ('premium', 'Premium Room', 'For dedicated daily learners.',
         '#7C4DFF', '💜', 3, 200, 2.00, 1.50,
         '["12 coins/hour study", "1.5x XP multiplier", "Premium study notes", "Bonus streak rewards"]'),
        ('diamond', 'Diamond Room', 'Elite room for the top aspirants.',
         '#00BCD4', '💎', 4, 50, 3.00, 2.00,
         '["18 coins/hour study", "2x XP multiplier", "Diamond leaderboard visibility", "Exclusive badges", "Early feature access"]')
      ON CONFLICT (tier_key) DO NOTHING
    `);

    // ── SEED: Progression rules ───────────────────────────────
    // Silver → Gold: 8 total study hours + 3 day streak + 5 quizzes
    // Gold   → Premium: 30 hours + 7 day streak + 20 quizzes + 70% accuracy
    // Premium→ Diamond: 80 hours + 14 day streak + 50 quizzes + 75% accuracy
    await queryRunner.query(`
      INSERT INTO tier_progression_rules
        (from_tier_id, to_tier_id, min_total_study_hours, min_streak_days,
         min_quizzes_completed, min_accuracy_pct, evaluation_window_days,
         demotion_threshold_pct, demotion_grace_days)
      SELECT
        f.id, t.id,
        req.study_hours, req.streak, req.quizzes, req.accuracy, 7, 50.00, 3
      FROM (VALUES
        ('silver', 'gold',    8.0,  3,  5,  0.00),
        ('gold',   'premium', 30.0, 7,  20, 70.00),
        ('premium','diamond', 80.0, 14, 50, 75.00)
      ) AS req(from_k, to_k, study_hours, streak, quizzes, accuracy)
      JOIN room_tiers f ON f.tier_key = req.from_k
      JOIN room_tiers t ON t.tier_key = req.to_k
      ON CONFLICT (from_tier_id, to_tier_id) DO NOTHING
    `);

    // ── SEED: XP levels (10 to start) ────────────────────────
    await queryRunner.query(`
      INSERT INTO xp_levels (level, xp_required, title, badge_emoji, coin_bonus)
      VALUES
        (1,    0,    'Beginner',    '🌱', 0),
        (2,    100,  'Student',     '📖', 5),
        (3,    300,  'Learner',     '✏️',  5),
        (4,    600,  'Scholar',     '📚', 10),
        (5,    1000, 'Achiever',    '🎯', 10),
        (6,    1500, 'Dedicated',   '💪', 20),
        (7,    2200, 'Expert',      '🧠', 20),
        (8,    3000, 'Master',      '⭐', 30),
        (9,    4000, 'Elite',       '🏆', 30),
        (10,   5500, 'Legend',      '💎', 50)
      ON CONFLICT (level) DO NOTHING
    `);

    // ── SEED: Launch achievements ──────────────────────────────
    await queryRunner.query(`
      INSERT INTO achievement_types
        (key, title, description, emoji, category, condition, coins_reward, xp_reward, sort_order)
      VALUES
        ('first_hour',    'First Hour',        'Complete your first hour of study', '⏰', 'study',
         '{"type":"study_hours","threshold":1}',   10, 50,  1),
        ('ten_hours',     '10 Hour Club',       'Accumulate 10 hours of study',     '📚', 'study',
         '{"type":"study_hours","threshold":10}',  25, 150, 2),
        ('fifty_hours',   '50 Hour Scholar',   'Accumulate 50 hours of study',     '🎓', 'study',
         '{"type":"study_hours","threshold":50}',  75, 500, 3),
        ('streak_3',      '3-Day Streak',       'Study 3 days in a row',            '🔥', 'streak',
         '{"type":"streak_days","threshold":3}',   10, 50,  4),
        ('streak_7',      'Week Warrior',       'Study 7 days in a row',            '⚡', 'streak',
         '{"type":"streak_days","threshold":7}',   25, 150, 5),
        ('streak_30',     'Iron Will',          'Study 30 days in a row',           '💎', 'streak',
         '{"type":"streak_days","threshold":30}',  100, 600, 6),
        ('quiz_10',       'Quiz Taker',         'Complete 10 quizzes',              '📝', 'quiz',
         '{"type":"quizzes","threshold":10}',      15, 75,  7),
        ('quiz_50',       'Quiz Champion',      'Complete 50 quizzes',              '🏆', 'quiz',
         '{"type":"quizzes","threshold":50}',      50, 300, 8),
        ('gold_reach',    'Gold Achiever',      'Reach the Gold Room',              '🥇', 'tier',
         '{"type":"tier_reach","tier_key":"gold"}', 50, 250, 9),
        ('diamond_reach', 'Diamond Elite',      'Reach the Diamond Room',           '💎', 'tier',
         '{"type":"tier_reach","tier_key":"diamond"}', 200, 1000, 10)
      ON CONFLICT (key) DO NOTHING
    `);

    // ── Assign Silver tier to all existing users ───────────────
    await queryRunner.query(`
      INSERT INTO user_room_tier (user_id, current_tier_id)
      SELECT u.id, t.id
      FROM users u
      CROSS JOIN room_tiers t
      WHERE t.tier_key = 'silver'
        AND u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM user_room_tier urt WHERE urt.user_id = u.id
        )
    `);

    // Also sync room_tier_id on users table
    await queryRunner.query(`
      UPDATE users u
      SET room_tier_id = (SELECT id FROM room_tiers WHERE tier_key = 'silver')
      WHERE u.room_tier_id IS NULL
        AND u.status = 'active'
    `);

    // ── INDEXES ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_study_sessions_user_date
        ON study_sessions(user_id, started_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_study_sessions_room
        ON study_sessions(room_id, started_at DESC)
    `);
    // Partial index for active sessions lookup (very hot path)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_study_sessions_active
        ON study_sessions(user_id)
        WHERE ended_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_room_tier_tier
        ON user_room_tier(current_tier_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_room_leaderboard_lookup
        ON room_leaderboard(tier_id, period_type, period_key, rank_position)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_achievements_user
        ON user_achievements(user_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_challenge_progress_user
        ON user_challenge_progress(user_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_xp_level
        ON users(xp_level)
    `);
  }

  // ── DOWN ───────────────────────────────────────────────────────
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_xp_level`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_challenge_progress_user`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_achievements_user`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_room_leaderboard_lookup`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_room_tier_tier`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_study_sessions_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_study_sessions_room`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_study_sessions_user_date`);

    await queryRunner.query(`DROP TABLE IF EXISTS user_challenge_progress CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS weekly_challenges CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_achievements CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS achievement_types CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS room_leaderboard CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS xp_levels CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS study_sessions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_room_tier CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS tier_progression_rules CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS room_tiers CASCADE`);

    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS xp,
        DROP COLUMN IF EXISTS xp_level,
        DROP COLUMN IF EXISTS room_tier_id
    `);

    await queryRunner.query(`DROP TYPE IF EXISTS achievement_category`);
    await queryRunner.query(`DROP TYPE IF EXISTS leaderboard_period`);
    await queryRunner.query(`DROP TYPE IF EXISTS session_mode`);
  }
}
