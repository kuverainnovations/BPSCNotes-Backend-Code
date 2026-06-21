import { MigrationInterface, QueryRunner } from 'typeorm';

// Persists CA MCQ practice results so the article list/detail screens can
// show "attempted" + last score, matching how `quiz_attempts` backs the
// same UI pattern for Daily Quiz / Mock Tests.
//
// negative_marking_enabled / marks_per_correct / marks_per_wrong are
// snapshotted onto the attempt row (not re-read from the live config table)
// because CA's negative marking is one global admin-controlled setting —
// if the admin changes it next week, a user's attempt from last week should
// still show the marks breakdown that was actually in effect when they took
// it, not get silently recomputed under today's rule.
export class CaMcqAttempts1782400000000 implements MigrationInterface {
  name = 'CaMcqAttempts1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ca_mcq_attempts (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        affair_id                 UUID NOT NULL REFERENCES current_affairs(id) ON DELETE CASCADE,
        total_questions           INTEGER NOT NULL DEFAULT 0,
        correct_answers           INTEGER NOT NULL DEFAULT 0,
        wrong_answers             INTEGER NOT NULL DEFAULT 0,
        not_attempted_count       INTEGER NOT NULL DEFAULT 0,
        blank_count               INTEGER NOT NULL DEFAULT 0,
        negative_marking_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
        marks_per_correct         NUMERIC(6,2) NOT NULL DEFAULT 1,
        marks_per_wrong           NUMERIC(6,2) NOT NULL DEFAULT 0,
        marks_obtained            NUMERIC(8,2) NOT NULL DEFAULT 0,
        negative_marks            NUMERIC(8,2) NOT NULL DEFAULT 0,
        final_score               NUMERIC(8,2) NOT NULL DEFAULT 0,
        total_marks                NUMERIC(8,2) NOT NULL DEFAULT 0,
        answers                   JSONB NOT NULL DEFAULT '[]'::jsonb,
        attempted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Two access patterns: "all of this user's attempts on this article"
    // (list/detail badge — most recent one) and "all attempts on this
    // article" (future admin-side analytics, not built yet but cheap to
    // index for now).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ca_mcq_attempts_user_affair
        ON ca_mcq_attempts (user_id, affair_id, attempted_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ca_mcq_attempts_affair
        ON ca_mcq_attempts (affair_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ca_mcq_attempts`);
  }
}
