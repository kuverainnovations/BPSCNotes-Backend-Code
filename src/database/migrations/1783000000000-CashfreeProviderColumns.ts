import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cashfree Migration — Generic Provider Columns
 * ══════════════════════════════════════════════
 *
 * Strategy: NON-DESTRUCTIVE
 *   - Old razorpay_* columns are kept (historical data preserved).
 *   - New provider_* columns added alongside them.
 *   - All new payments write to provider_* columns.
 *   - payment_provider column flags which gateway created each row.
 *   - payment_settings gets Cashfree keys; Razorpay keys remain as
 *     tombstone rows with empty values.
 *
 * Tables affected:
 *   subscriptions            — razorpay_order_id / razorpay_payment_id
 *   course_purchases         — razorpay_order_id / razorpay_payment_id
 *   material_purchase_orders — razorpay_order_id / razorpay_payment_id
 *   payment_settings         — new cashfree_* keys
 */
export class CashfreeProviderColumns1783000000000 implements MigrationInterface {
  name = 'CashfreeProviderColumns1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── subscriptions ─────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS payment_provider   VARCHAR(30) DEFAULT 'cashfree',
        ADD COLUMN IF NOT EXISTS provider_order_id  VARCHAR(200),
        ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(200)
    `);
    // Back-fill existing Razorpay rows
    await queryRunner.query(`
      UPDATE subscriptions
        SET payment_provider    = 'razorpay',
            provider_order_id   = razorpay_order_id,
            provider_payment_id = razorpay_payment_id
      WHERE razorpay_order_id IS NOT NULL
        AND provider_order_id  IS NULL
    `);

    // ── course_purchases ──────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE course_purchases
        ADD COLUMN IF NOT EXISTS payment_provider    VARCHAR(30) DEFAULT 'cashfree',
        ADD COLUMN IF NOT EXISTS provider_order_id   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(200)
    `);
    await queryRunner.query(`
      UPDATE course_purchases
        SET payment_provider    = 'razorpay',
            provider_order_id   = razorpay_order_id,
            provider_payment_id = razorpay_payment_id
      WHERE razorpay_order_id IS NOT NULL
        AND provider_order_id  IS NULL
    `);

    // ── material_purchase_orders ──────────────────────────────
    await queryRunner.query(`
      ALTER TABLE material_purchase_orders
        ADD COLUMN IF NOT EXISTS payment_provider    VARCHAR(30) DEFAULT 'cashfree',
        ADD COLUMN IF NOT EXISTS provider_order_id   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(200)
    `);
    await queryRunner.query(`
      UPDATE material_purchase_orders
        SET payment_provider    = 'razorpay',
            provider_order_id   = razorpay_order_id,
            provider_payment_id = razorpay_payment_id
      WHERE razorpay_order_id IS NOT NULL
        AND provider_order_id  IS NULL
    `);

    // ── payment_settings: Cashfree keys ──────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        key        VARCHAR(100) PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      INSERT INTO payment_settings (key, value) VALUES
        ('cashfree_app_id',        ''),
        ('cashfree_secret_key',    ''),
        ('cashfree_webhook_secret',''),
        ('payment_mode',           'sandbox')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE subscriptions
        DROP COLUMN IF EXISTS payment_provider,
        DROP COLUMN IF EXISTS provider_order_id,
        DROP COLUMN IF EXISTS provider_payment_id
    `);
    await queryRunner.query(`
      ALTER TABLE course_purchases
        DROP COLUMN IF EXISTS payment_provider,
        DROP COLUMN IF EXISTS provider_order_id,
        DROP COLUMN IF EXISTS provider_payment_id
    `);
    await queryRunner.query(`
      ALTER TABLE material_purchase_orders
        DROP COLUMN IF EXISTS payment_provider,
        DROP COLUMN IF EXISTS provider_order_id,
        DROP COLUMN IF EXISTS provider_payment_id
    `);
    await queryRunner.query(`
      DELETE FROM payment_settings
      WHERE key IN ('cashfree_app_id','cashfree_secret_key','cashfree_webhook_secret','payment_mode')
    `);
  }
}
