import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuizSessions1783000000005 implements MigrationInterface {
  name = 'QuizSessions1783000000005';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS quiz_sessions (
        id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quiz_id           UUID        NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_order    JSONB       NOT NULL DEFAULT '[]',
        option_order      JSONB       NOT NULL DEFAULT '{}',
        answers_so_far    JSONB       NOT NULL DEFAULT '{}',
        background_secs   INT         NOT NULL DEFAULT 0,
        status            VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                                      CHECK (status IN ('in_progress','submitted','abandoned')),
        started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        submitted_at      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Only one in_progress session per user per quiz at a time
    await qr.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_quiz_sessions_active
        ON quiz_sessions(user_id, quiz_id)
        WHERE status = 'in_progress'
    `);

    await qr.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quiz_sessions_user
        ON quiz_sessions(user_id, created_at DESC)
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP INDEX IF EXISTS idx_quiz_sessions_user`);
    await qr.query(`DROP INDEX IF EXISTS idx_quiz_sessions_active`);
    await qr.query(`DROP TABLE IF EXISTS quiz_sessions`);
  }
}
