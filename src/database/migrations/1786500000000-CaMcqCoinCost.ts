import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Coin cost for Current Affairs MCQ quizzes.
 *
 * Daily MCQs deliberately do NOT get their own mechanism: they are ordinary
 * `quizzes` rows, so the per-quiz is_paid/coin_price added by
 * PaidMockTests1786400000000 already prices them. Growing a second, parallel
 * coin gate for the same kind of content is how three slightly different
 * paywalls end up in one app.
 *
 * Current Affairs MCQs are not quizzes — they hang off an article in
 * ca_mcqs — so they need their own entitlement record. The price is one
 * global setting rather than a per-article column: articles are published
 * daily and nobody wants to price each one.
 *
 * Seeded at 0, which means free. Nothing changes until an admin sets a cost.
 */
export class CaMcqCoinCost1786500000000 implements MigrationInterface {
  name = 'CaMcqCoinCost1786500000000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      INSERT INTO app_settings (key, value, description) VALUES
        ('ca_quiz_coin_cost', '0', 'Coins charged to attempt a Current Affairs MCQ quiz (0 = free)')
      ON CONFLICT (key) DO NOTHING
    `);

    await qr.query(`
      CREATE TABLE IF NOT EXISTS ca_mcq_unlocks (
        user_id     UUID        NOT NULL REFERENCES users(id)           ON DELETE CASCADE,
        affair_id   UUID        NOT NULL REFERENCES current_affairs(id) ON DELETE CASCADE,
        coins_spent INTEGER     NOT NULL DEFAULT 0,
        unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, affair_id)
      )
    `);

    // Anyone who has already attempted an article's MCQs keeps free access to
    // them. Charging retroactively for something they have already done would
    // read as the app taking coins for nothing.
    await qr.query(`
      INSERT INTO ca_mcq_unlocks (user_id, affair_id, coins_spent)
      SELECT DISTINCT user_id, affair_id, 0 FROM ca_mcq_attempts
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS ca_mcq_unlocks`);
    await qr.query(`DELETE FROM app_settings WHERE key = 'ca_quiz_coin_cost'`);
  }
}
