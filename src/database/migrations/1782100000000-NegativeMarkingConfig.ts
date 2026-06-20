import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Negative Marking Configuration
 * ════════════════════════════════════════════════
 * Adds admin-configurable negative marking to the `quizzes` table. This
 * single table already backs every assessment module in the app —
 * Daily Quiz, Topic/Subject-wise Quiz (also used as "Practice MCQs"),
 * and Mock/Full-Length Tests (type='mock') — so one config column set
 * here covers all of them, plus any future quiz `type` the admin adds.
 *
 * quizzes:
 *   negative_marking_enabled  — on/off toggle, defaults OFF (no behaviour
 *                                change for existing quizzes)
 *   marks_per_correct         — marks awarded for a correct answer
 *   marks_per_wrong           — marks DEDUCTED for a wrong answer
 *                                (stored positive, e.g. 0.66 → subtract 0.66)
 *
 * quiz_attempts gets the matching result columns so a submitted attempt's
 * marks breakdown is persisted (not just computed on the fly), which is
 * what the result screen, review screen, and leaderboard/rank queries read:
 *   wrong_answers          — attempted but incorrect (distinct from skipped)
 *   unanswered_questions   — not attempted at all
 *   marks_obtained         — correct_answers * marks_per_correct
 *   negative_marks         — wrong_answers * marks_per_wrong (0 if disabled)
 *   final_score            — marks_obtained - negative_marks
 *
 * SAFE TO RUN: every statement uses IF NOT EXISTS / idempotent patterns.
 */
export class NegativeMarkingConfig1782100000000 implements MigrationInterface {
  name = 'NegativeMarkingConfig1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── quizzes: admin-configurable marking scheme ──────────────
    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS negative_marking_enabled BOOLEAN      NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS marks_per_correct         NUMERIC(6,2) NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS marks_per_wrong            NUMERIC(6,2) NOT NULL DEFAULT 0
    `);

    // ── quiz_attempts: persisted marks breakdown per attempt ────
    await queryRunner.query(`
      ALTER TABLE quiz_attempts
        ADD COLUMN IF NOT EXISTS wrong_answers        INTEGER      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS unanswered_questions  INTEGER      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS marks_obtained         NUMERIC(8,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS negative_marks          NUMERIC(8,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS final_score             NUMERIC(8,2) NOT NULL DEFAULT 0
    `);

    // ── Backfill existing attempts so old rows aren't all zero ──
    // No negative marking existed before this migration, so the best
    // reconstruction is: marks_obtained = correct_answers (1 mark each),
    // final_score = marks_obtained, wrong_answers = whatever wasn't correct
    // (historic rows don't distinguish skipped vs wrong — harmless, since
    // negative_marks stays 0 for all of them either way).
    await queryRunner.query(`
      UPDATE quiz_attempts SET
        marks_obtained  = correct_answers,
        final_score     = correct_answers,
        wrong_answers   = GREATEST(total_questions - correct_answers, 0)
      WHERE marks_obtained = 0 AND final_score = 0
    `);

    // Index used by leaderboard/rank queries when ordering by final_score
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_attempts_final_score ON quiz_attempts(quiz_id, final_score DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_attempts_final_score`);
    await queryRunner.query(`
      ALTER TABLE quiz_attempts
        DROP COLUMN IF EXISTS wrong_answers,
        DROP COLUMN IF EXISTS unanswered_questions,
        DROP COLUMN IF EXISTS marks_obtained,
        DROP COLUMN IF EXISTS negative_marks,
        DROP COLUMN IF EXISTS final_score
    `);
    await queryRunner.query(`
      ALTER TABLE quizzes
        DROP COLUMN IF EXISTS negative_marking_enabled,
        DROP COLUMN IF EXISTS marks_per_correct,
        DROP COLUMN IF EXISTS marks_per_wrong
    `);
  }
}
