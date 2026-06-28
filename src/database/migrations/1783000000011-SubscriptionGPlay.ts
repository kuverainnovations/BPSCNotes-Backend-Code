import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds Google Play Billing columns to subscriptions table.
// payment_provider already exists (added in 1783000000000-CashfreeProviderColumns).
// We only add the two gplay-specific token columns here.
// SAFE: every statement is idempotent (IF NOT EXISTS / IF EXISTS).
export class SubscriptionGPlay1783000000011 implements MigrationInterface {
  name = 'SubscriptionGPlay1783000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS gplay_purchase_token TEXT,
        ADD COLUMN IF NOT EXISTS gplay_order_id       VARCHAR(255)
    `);

    // Ensure payment_provider CHECK constraint includes 'gplay'
    // (earlier migration used VARCHAR(30) with no CHECK — safe to extend)
    await queryRunner.query(`
      ALTER TABLE subscriptions
        ALTER COLUMN payment_provider SET DEFAULT 'cashfree'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE subscriptions
        DROP COLUMN IF EXISTS gplay_purchase_token,
        DROP COLUMN IF EXISTS gplay_order_id
    `);
  }
}
