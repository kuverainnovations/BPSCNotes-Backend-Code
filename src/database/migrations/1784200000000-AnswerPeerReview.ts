import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Answer Writing — Peer Review upgrade.
 *
 * 1. Handwritten answers: students photograph their notebook answer and
 *    upload images instead of (or as well as) typing — answer_images[].
 * 2. Peer review pool: structured reviews by fellow aspirants
 *    (answer_peer_reviews). Anonymous both ways.
 * 3. Review credits: users.review_credits — +1 per review given.
 *
 * Eligibility (enforced in code, documented here):
 *   Gate A — you may only review answers to questions you also submitted.
 *   Gate B — your own answer must have received ≥1 review (peer or
 *            mentor) before you can review others. Mentor/admin reviews
 *            bootstrap the flywheel.
 *
 * Submission status lifecycle:
 *   'submitted' → 'peer_reviewed' (≥2 peer reviews) → 'reviewed' (mentor
 *   grade with score; can happen at any point and is terminal).
 */
export class AnswerPeerReview1784200000000 implements MigrationInterface {
  name = 'AnswerPeerReview1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Photo answers — answer_text becomes optional (text OR images)
    await queryRunner.query(`
      ALTER TABLE answer_submissions
        ADD COLUMN IF NOT EXISTS answer_images     TEXT[],
        ADD COLUMN IF NOT EXISTS peer_review_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS avg_peer_rating   NUMERIC(3,2)
    `);
    await queryRunner.query(`
      ALTER TABLE answer_submissions ALTER COLUMN answer_text DROP NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS answer_peer_reviews (
        id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id    UUID        NOT NULL REFERENCES answer_submissions(id) ON DELETE CASCADE,
        reviewer_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        verdict          VARCHAR(10) NOT NULL,             -- yes | partly | no
        rating           INTEGER     NOT NULL,             -- 1..5 stars
        improvement_area VARCHAR(30),                      -- content|structure|analysis|bihar_angle|presentation|conclusion
        suggestion       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (submission_id, reviewer_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_peer_reviews_reviewer
        ON answer_peer_reviews(reviewer_id, created_at DESC)
    `);

    await queryRunner.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS review_credits INTEGER NOT NULL DEFAULT 0
    `);

    // Coin rule — giving a peer review also earns coins (admin-editable)
    await queryRunner.query(`
      INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active, category, icon, unit_label, is_core)
      SELECT 'peer_review', 'Peer review given', 5, 5, TRUE, 'social', '🤝', 'Per answer reviewed', FALSE
      WHERE NOT EXISTS (SELECT 1 FROM coin_rules WHERE action = 'peer_review')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM coin_rules WHERE action = 'peer_review'`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS review_credits`);
    await queryRunner.query(`DROP TABLE IF EXISTS answer_peer_reviews`);
    await queryRunner.query(`
      ALTER TABLE answer_submissions
        DROP COLUMN IF EXISTS answer_images,
        DROP COLUMN IF EXISTS peer_review_count,
        DROP COLUMN IF EXISTS avg_peer_rating
    `);
  }
}
