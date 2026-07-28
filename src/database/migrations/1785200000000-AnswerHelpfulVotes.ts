import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Peer review — "Helpful? 👍👎" on an ANSWER (not on a review).
 * ═══════════════════════════════════════════════════════════════
 * Client (28 Jul, Screen 3): while reviewing an answer, a quick thumbs
 * up / down on the answer itself, above the structured review form.
 *
 * This is distinct from answer_review_votes (which rates a REVIEW). Here
 * a reviewer reacts to the ANSWER. One vote per (answer, voter); voting
 * again flips it. Counts are denormalised onto answer_submissions so the
 * review list can show them without an extra aggregate per row.
 */
export class AnswerHelpfulVotes1785200000000 implements MigrationInterface {
  name = 'AnswerHelpfulVotes1785200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS answer_helpful_votes (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id UUID        NOT NULL REFERENCES answer_submissions(id) ON DELETE CASCADE,
        voter_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        helpful       BOOLEAN     NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (submission_id, voter_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_answer_helpful_votes_submission
        ON answer_helpful_votes(submission_id)
    `);
    await queryRunner.query(`
      ALTER TABLE answer_submissions
        ADD COLUMN IF NOT EXISTS helpful_count     INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS not_helpful_count INTEGER NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_submissions
        DROP COLUMN IF EXISTS helpful_count,
        DROP COLUMN IF EXISTS not_helpful_count
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_answer_helpful_votes_submission`);
    await queryRunner.query(`DROP TABLE IF EXISTS answer_helpful_votes`);
  }
}
