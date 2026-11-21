import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buy a mock test with money, through Google Play.
 *
 * Paid mock tests shipped with coins as the only unlock path, so a test
 * priced in rupees could not be bought at all — the app showed "Coin unlock
 * isn't available for it yet" and the student had no way in.
 *
 * This mirrors what courses and study materials already do: a one-time
 * product is upserted into the Play catalogue per paid quiz, the app buys
 * it through Play Billing, and the backend verifies the token with Google
 * before granting the entitlement. Play Billing rather than Cashfree
 * because this is digital content inside the app, which Play policy
 * requires to go through their billing.
 *
 * quiz_purchases already carries price_paid; this adds the provider columns
 * the verification writes, matching course_purchases.
 */
export class QuizGplayPurchase1786800000000 implements MigrationInterface {
  name = 'QuizGplayPurchase1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS gplay_product_id TEXT`);

    await queryRunner.query(`ALTER TABLE quiz_purchases ADD COLUMN IF NOT EXISTS payment_provider      TEXT NOT NULL DEFAULT 'coins'`);
    await queryRunner.query(`ALTER TABLE quiz_purchases ADD COLUMN IF NOT EXISTS gplay_purchase_token  TEXT`);
    await queryRunner.query(`ALTER TABLE quiz_purchases ADD COLUMN IF NOT EXISTS gplay_order_id        TEXT`);

    // One Play purchase token can only ever entitle one row. Without this a
    // replayed token could be inserted twice if the duplicate check and the
    // insert interleaved. Partial so the coin rows, which have no token,
    // are not all competing for a single NULL slot.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_purchases_gplay_token
        ON quiz_purchases(gplay_purchase_token)
        WHERE gplay_purchase_token IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_quiz_purchases_gplay_token`);
    await queryRunner.query(`ALTER TABLE quiz_purchases DROP COLUMN IF EXISTS gplay_order_id`);
    await queryRunner.query(`ALTER TABLE quiz_purchases DROP COLUMN IF EXISTS gplay_purchase_token`);
    await queryRunner.query(`ALTER TABLE quiz_purchases DROP COLUMN IF EXISTS payment_provider`);
    await queryRunner.query(`ALTER TABLE quizzes DROP COLUMN IF EXISTS gplay_product_id`);
  }
}
