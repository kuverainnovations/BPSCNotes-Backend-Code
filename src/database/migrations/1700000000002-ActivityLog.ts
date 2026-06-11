import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActivityLog1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── 1. Add missing timestamps to existing tables ──────────
    const addTimestamps = [
      // Missing created_at entirely
      `ALTER TABLE user_enrollments        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE user_enrollments        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE lesson_progress         ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE lesson_progress         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE note_downloads          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE quiz_attempts           ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE quiz_attempts           ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE room_members            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE live_class_registrations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE certificates            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE certificates            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      // Has created_at but missing updated_at
      `ALTER TABLE course_chapters         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE course_lessons          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE course_reviews          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE quiz_questions          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE coin_transactions       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE notifications           ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE user_notifications      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE flashcards              ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ];

    for (const sql of addTimestamps) {
      await queryRunner.query(sql).catch(() => {});
    }

    // ── 2. Create user_activity_log table ─────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_activity_log (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
        action      VARCHAR(60) NOT NULL,
        description TEXT,
        metadata    JSONB       DEFAULT '{}',
        ip_address  VARCHAR(45),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_user    ON user_activity_log(user_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_action  ON user_activity_log(action)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_created ON user_activity_log(created_at DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_activity_log`);
  }
}
