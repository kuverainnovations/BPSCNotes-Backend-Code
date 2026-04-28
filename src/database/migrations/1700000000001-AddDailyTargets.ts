import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDailyTargets1700000000001 implements MigrationInterface {
  name = 'AddDailyTargets1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enum for time slot ─────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE target_time_slot AS ENUM ('morning', 'afternoon', 'night');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── Daily targets table ────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS daily_targets (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title               VARCHAR(300) NOT NULL,
        subject             VARCHAR(100) NOT NULL DEFAULT 'General',
        difficulty          difficulty NOT NULL DEFAULT 'medium',
        time_slot           target_time_slot NOT NULL DEFAULT 'morning',
        estimated_minutes   INTEGER NOT NULL DEFAULT 25,
        total_questions     INTEGER NOT NULL DEFAULT 10,
        attempted_questions INTEGER NOT NULL DEFAULT 0,
        is_completed        BOOLEAN NOT NULL DEFAULT FALSE,
        is_carried_forward  BOOLEAN NOT NULL DEFAULT FALSE,
        target_date         DATE NOT NULL DEFAULT CURRENT_DATE,
        completed_at        TIMESTAMPTZ,
        source_quiz_id      UUID REFERENCES quizzes(id) ON DELETE SET NULL,
        source_note_id      UUID REFERENCES library_notes(id) ON DELETE SET NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Indexes ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_targets_user_date
        ON daily_targets(user_id, target_date DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_targets_date
        ON daily_targets(target_date)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS daily_targets CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS target_time_slot`);
  }
}
