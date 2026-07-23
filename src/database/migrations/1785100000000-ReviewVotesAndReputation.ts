import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Peer review — "Was this review useful?" votes + reviewer reputation.
 * ═══════════════════════════════════════════════════════════════════
 * Client: "After submitting review show: Was this review useful? 👍 👎.
 *          Bad reviewers lose reputation. Good reviewers gain reputation."
 *
 * Who votes: the AUTHOR of the reviewed answer, and only them. They are
 * the one person who can judge whether the review helped, and restricting
 * it there keeps the vote un-brigadeable — reviews are anonymous, so a
 * public vote would be a popularity contest between strangers.
 *
 * Counts are denormalised onto answer_peer_reviews because every place
 * that renders a review also renders its votes (the received-reviews list
 * sorts by them, so the most useful review surfaces first — the client's
 * "Top Review Highlights").
 *
 * Reviewer rating is derived, not stored: of the reviews you gave that
 * were voted on, the share judged helpful, mapped onto 1–5 stars. Storing
 * it would mean recomputing a column on every vote for no gain.
 */
export class ReviewVotesAndReputation1785100000000 implements MigrationInterface {
  name = 'ReviewVotesAndReputation1785100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS answer_review_votes (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        review_id  UUID        NOT NULL REFERENCES answer_peer_reviews(id) ON DELETE CASCADE,
        voter_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        helpful    BOOLEAN     NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (review_id, voter_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_review_votes_review
        ON answer_review_votes(review_id)
    `);

    await queryRunner.query(`
      ALTER TABLE answer_peer_reviews
        ADD COLUMN IF NOT EXISTS helpful_votes   INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS unhelpful_votes INTEGER NOT NULL DEFAULT 0
    `);

    // Reviewer leaderboard sorts on "reviews given by this reviewer"
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_peer_reviews_reviewer_helpful
        ON answer_peer_reviews(reviewer_id, helpful_votes)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_peer_reviews_reviewer_helpful`);
    await queryRunner.query(`
      ALTER TABLE answer_peer_reviews
        DROP COLUMN IF EXISTS helpful_votes,
        DROP COLUMN IF EXISTS unhelpful_votes
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_review_votes_review`);
    await queryRunner.query(`DROP TABLE IF EXISTS answer_review_votes`);
  }
}
