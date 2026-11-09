import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Paid mock tests.
 *
 * Mock tests have always existed as `quizzes.type='mock'`, but the table had
 * no notion of price, so every one of them was free. This adds the pricing
 * columns and the entitlement table that records who may sit which test.
 *
 * Pricing is deliberately dual: a test can be unlocked with money, with
 * coins, or either, matching how courses and study materials already work.
 *   · price      — rupees. 0 means "not for sale for money".
 *   · coin_price — coins.  0 means "not for sale for coins".
 *   · is_paid    — the master switch. FALSE keeps a test free regardless of
 *                  whatever numbers happen to be sitting in the two columns,
 *                  so an admin can take a test off sale without losing its
 *                  pricing.
 *
 * Also retires the dead 'Mock Test Unlock' coin-store item. It was seeded by
 * CoinStore1783200000002 and sold for 200 coins, but the string 'mock_unlock'
 * appears nowhere in the application — redeeming it debited the coins and
 * granted nothing. Mock tests are now unlocked per test, so the generic item
 * has no meaning; it is deactivated rather than deleted because
 * coin_redemptions references it with ON DELETE RESTRICT and real users may
 * already have (uselessly) bought it.
 */
export class PaidMockTests1786400000000 implements MigrationInterface {
  name = 'PaidMockTests1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS is_paid    BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS price      INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS coin_price INTEGER NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS quiz_purchases (
        id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        quiz_id      UUID        NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        user_id      UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
        price_paid   INTEGER     NOT NULL DEFAULT 0,
        coins_spent  INTEGER     NOT NULL DEFAULT 0,
        purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (quiz_id, user_id)
      )
    `);

    // The entitlement check runs on every mock-test card render, so it wants
    // to be an index hit rather than a scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_quiz_purchases_user ON quiz_purchases(user_id, quiz_id)
    `);

    await queryRunner.query(`
      UPDATE coin_store_items
         SET is_active = FALSE,
             description = 'Retired — mock tests are now unlocked individually'
       WHERE item_type = 'mock_unlock'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE coin_store_items
         SET is_active = TRUE,
             description = 'Unlock any 1 paid mock test'
       WHERE item_type = 'mock_unlock'
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS quiz_purchases`);
    await queryRunner.query(`
      ALTER TABLE quizzes
        DROP COLUMN IF EXISTS is_paid,
        DROP COLUMN IF EXISTS price,
        DROP COLUMN IF EXISTS coin_price
    `);
  }
}
