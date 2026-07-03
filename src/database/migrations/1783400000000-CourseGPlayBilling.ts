import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds Google Play Billing columns for one-time course purchases.
// Mirrors 1783000000011-SubscriptionGPlay.ts, applied to courses/course_purchases.
// payment_provider/provider_order_id/provider_payment_id already exist on
// course_purchases (added in 1783000000000-CashfreeProviderColumns).
// SAFE: every statement is idempotent (IF NOT EXISTS / IF EXISTS).
export class CourseGPlayBilling1783400000000 implements MigrationInterface {
  name = 'CourseGPlayBilling1783400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // courses — deterministic 1:1 mapping to a Play one-time product
    await queryRunner.query(`
      ALTER TABLE courses
        ADD COLUMN IF NOT EXISTS gplay_product_id VARCHAR(100)
    `);

    // course_purchases — same two gplay columns subscriptions already has
    await queryRunner.query(`
      ALTER TABLE course_purchases
        ADD COLUMN IF NOT EXISTS gplay_purchase_token TEXT,
        ADD COLUMN IF NOT EXISTS gplay_order_id       VARCHAR(255)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE course_purchases
        DROP COLUMN IF EXISTS gplay_purchase_token,
        DROP COLUMN IF EXISTS gplay_order_id
    `);
    await queryRunner.query(`
      ALTER TABLE courses
        DROP COLUMN IF EXISTS gplay_product_id
    `);
  }
}
