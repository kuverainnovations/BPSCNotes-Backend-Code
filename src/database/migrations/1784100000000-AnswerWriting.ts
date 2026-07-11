import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Answer Writing — daily Mains descriptive-answer practice.
 *
 * - answer_questions:   admin-posted questions (marks, word limit, model
 *   answer revealed to a user only after they submit their own attempt).
 * - answer_submissions: one attempt per user per question; graded later by
 *   an admin/mentor with a score + written feedback.
 *
 * Also seeds the `answer_writing` coin rule so submitting an answer earns
 * coins (amount/cap/off-switch editable from the admin Coins page like
 * every other rule).
 */
export class AnswerWriting1784100000000 implements MigrationInterface {
  name = 'AnswerWriting1784100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS answer_questions (
        id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        question_text TEXT         NOT NULL,
        subject       VARCHAR(100),
        marks         INTEGER      NOT NULL DEFAULT 10,
        word_limit    INTEGER      NOT NULL DEFAULT 250,
        model_answer  TEXT,
        tips          TEXT,
        scheduled_for DATE,
        status        VARCHAR(20)  NOT NULL DEFAULT 'draft',
        created_by    UUID         REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_answer_questions_status
        ON answer_questions(status, scheduled_for)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS answer_submissions (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        question_id     UUID         NOT NULL REFERENCES answer_questions(id) ON DELETE CASCADE,
        user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        answer_text     TEXT         NOT NULL,
        word_count      INTEGER      NOT NULL DEFAULT 0,
        time_taken_secs INTEGER,
        status          VARCHAR(20)  NOT NULL DEFAULT 'submitted',
        score           NUMERIC(5,2),
        feedback        TEXT,
        reviewed_by     UUID         REFERENCES admin_users(id) ON DELETE SET NULL,
        reviewed_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (question_id, user_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_answer_submissions_user
        ON answer_submissions(user_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_answer_submissions_review
        ON answer_submissions(status, created_at DESC)
    `);

    // Coin rule — submitting a daily answer earns coins (admin-editable)
    await queryRunner.query(`
      INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active, category, icon, unit_label, is_core)
      SELECT 'answer_writing', 'Answer writing submission', 15, 1, TRUE, 'study', '✍️', 'Per answer submitted', FALSE
      WHERE NOT EXISTS (SELECT 1 FROM coin_rules WHERE action = 'answer_writing')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM coin_rules WHERE action = 'answer_writing'`);
    await queryRunner.query(`DROP TABLE IF EXISTS answer_submissions`);
    await queryRunner.query(`DROP TABLE IF EXISTS answer_questions`);
  }
}
