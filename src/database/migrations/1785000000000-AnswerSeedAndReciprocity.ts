import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Answer Writing — seed answers + per-question review reciprocity.
 * ════════════════════════════════════════════════════════════════
 * Client rule (23 Jul): "The review section for your answer to a
 * particular question unlocks only after you review another user's
 * answer for that same question."
 *
 * The gate itself is pure logic (see answer-writing.module.ts) — the
 * only thing it needs from the schema is SEED ANSWERS, which solve the
 * cold start: the first student to answer a question would otherwise
 * have nobody to review, and so could never unlock their own feedback.
 *
 * A seed answer is a house-authored sample answer posted by an admin
 * against a question. It behaves like a submission in the review pool
 * and nowhere else:
 *   · exempt from PEER_REVIEWS_MAX — one seed can unlock every student,
 *     not just the first five
 *   · hidden from the mentor grading queue (nobody is waiting on it)
 *   · excluded from leaderboards, insights and the student-facing
 *     answer counts
 *
 * Seeds are owned by a reserved house user so answer_submissions.user_id
 * (NOT NULL, FK → users) stays valid without special-casing every join.
 */
export class AnswerSeedAndReciprocity1785000000000 implements MigrationInterface {
  name = 'AnswerSeedAndReciprocity1785000000000';

  /** Reserved mobile for the house account that owns every seed answer. */
  static readonly SEED_USER_MOBILE = '0000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_submissions
        ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // The review pool filters on (question_id, is_seed, peer_review_count)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_answer_submissions_pool
        ON answer_submissions(question_id, is_seed, peer_review_count)
    `);

    // Reciprocity check: "has this user reviewed anything for question Q"
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_peer_reviews_submission
        ON answer_peer_reviews(submission_id)
    `);

    // House account that owns seed answers. Named so it is obvious in any
    // admin user list — seeds are labelled "Sample answer" in the app, not
    // passed off as another student's work.
    //
    // Both occurrences of $1 are cast: in the SELECT list Postgres deduces
    // the parameter as text, in `mobile = $1` as varchar, and it refuses the
    // statement with "inconsistent types deduced for parameter $1".
    await queryRunner.query(
      `INSERT INTO users (name, mobile, mobile_verified, role, status, bio)
       SELECT 'BPSCNotes Sample', $1::varchar, TRUE, 'student', 'active',
              'House account that owns sample answers used to seed peer review.'
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE mobile = $1::varchar)`,
      [AnswerSeedAndReciprocity1785000000000.SEED_USER_MOBILE]
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM answer_submissions WHERE is_seed = TRUE
    `);
    await queryRunner.query(
      `DELETE FROM users WHERE mobile = $1`,
      [AnswerSeedAndReciprocity1785000000000.SEED_USER_MOBILE]
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_peer_reviews_submission`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_answer_submissions_pool`);
    await queryRunner.query(`
      ALTER TABLE answer_submissions DROP COLUMN IF EXISTS is_seed
    `);
  }
}
