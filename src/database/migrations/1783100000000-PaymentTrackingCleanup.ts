import { MigrationInterface, QueryRunner } from 'typeorm';

// ════════════════════════════════════════════════════════════
// Migration: 1783100000000-PaymentTrackingCleanup
//
// 1. Ensure course_purchases has the Cashfree provider columns
//    that the updated enroll() flow now writes.
// 2. Remove coin-related confusion — coins_applied and
//    coin_discount_inr stay for historical audit but are
//    zeroed going forward (coins cannot be used for purchases).
// 3. Add index for fast admin payment queries.
// ════════════════════════════════════════════════════════════
export class PaymentTrackingCleanup1783100000000 implements MigrationInterface {
  name = 'PaymentTrackingCleanup1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── course_purchases: add Cashfree provider columns ──────
    await queryRunner.query(`
      ALTER TABLE course_purchases
        ADD COLUMN IF NOT EXISTS provider_order_id   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(200),
        ADD COLUMN IF NOT EXISTS payment_provider    VARCHAR(50)
    `);

    // ── course_purchases: index for admin dashboard queries ──
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_course_purchases_status_created
        ON course_purchases (status, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_material_purchases_created
        ON material_purchases (created_at DESC)
    `);

    // ── material_purchase_orders: index for join in admin ────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_material_purchase_orders_status
        ON material_purchase_orders (material_id, user_id, status)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_course_purchases_status_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_material_purchases_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_material_purchase_orders_status`);
    // Columns intentionally not dropped on rollback to preserve data
  }
}
