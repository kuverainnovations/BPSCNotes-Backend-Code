import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds the Google Play Billing product-id column for study materials —
// mirrors 1783400000000-CourseGPlayBilling.ts applied to study_materials.
// No new columns needed on material_purchase_orders: it already has generic
// payment_provider / provider_order_id / provider_payment_id columns (added
// in 1783000000000-CashfreeProviderColumns.ts) which the gplay path reuses
// directly (payment_provider='gplay', provider_order_id=Play orderId,
// provider_payment_id=purchase token).
// SAFE: idempotent (IF NOT EXISTS).
export class StudyMaterialGPlayBilling1783500000000 implements MigrationInterface {
  name = 'StudyMaterialGPlayBilling1783500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_materials
        ADD COLUMN IF NOT EXISTS gplay_product_id VARCHAR(100)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_materials
        DROP COLUMN IF EXISTS gplay_product_id
    `);
  }
}
