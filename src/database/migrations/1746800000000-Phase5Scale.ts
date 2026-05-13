import { MigrationInterface, QueryRunner } from 'typeorm';

// ─────────────────────────────────────────────────────────────
// MIGRATION: Phase 5 — Scale
// Adds: user_flags table (for anti-cheat review)
//       study_sessions_archive (for old session data)
//       Additional indexes for high-traffic queries
// ─────────────────────────────────────────────────────────────
export class Phase5Scale1746800000000 implements MigrationInterface {
  name = 'Phase5Scale1746800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── user_flags — anti-cheat audit trail ───────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_flags (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason     VARCHAR(50) NOT NULL,   -- 'heartbeat_velocity' | 'afk_ratio' | 'coin_velocity' | 'short_session'
        details    TEXT,
        reviewed   BOOLEAN NOT NULL DEFAULT FALSE,
        reviewed_by UUID,                  -- admin_user.id who cleared it
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_flags_user ON user_flags(user_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_user_flags_unreviewed ON user_flags(created_at DESC) WHERE reviewed=FALSE`);

    // ── Additional performance indexes ────────────────────────

    // Leaderboard: fast rank lookup by user
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_room_leaderboard_user
        ON room_leaderboard(user_id, period_type, period_key)
    `);

    // study_sessions: fast daily coin cap check
    await queryRunner.query(`
     CREATE INDEX IF NOT EXISTS idx_coin_transactions_user_action_created
ON coin_transactions(user_id, action, created_at)
    `);

    // Weekly challenges: fast period+user lookup
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_weekly_challenges_period
        ON weekly_challenges(period_key, is_active)
    `);

    // User achievements: fast "not yet earned" check
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_achievements_type
        ON user_achievements(achievement_type_id, user_id)
    `);

    // ── Add coin rule for achievement reward if missing ────────
    await queryRunner.query(`
      INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active)
      VALUES ('achievement', 'Achievement unlocked reward', 10, 20, TRUE)
      ON CONFLICT (action) DO NOTHING
    `);

    // Add weekly_challenge rule
    await queryRunner.query(`
      INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active)
      VALUES ('weekly_challenge', 'Weekly challenge completion', 20, 5, TRUE)
      ON CONFLICT (action) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_achievements_type`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_weekly_challenges_period`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_coin_transactions_user_action_date`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_room_leaderboard_user`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_flags_unreviewed`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_flags_user`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_flags CASCADE`);
  }
}
