import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User Choice Billing (India) — external transaction columns
 * ═══════════════════════════════════════════════════════════
 * When a user picks the alternative billing option (Cashfree) on Google's
 * billing-choice screen, Play issues an externalTransactionToken that must
 * be reported back to the Play Developer API after the payment succeeds.
 *
 *   external_transaction_token       — token from UserChoiceDetails, stored
 *                                      when the app hands it over (order
 *                                      creation for subscriptions, confirm
 *                                      call for courses/materials)
 *   external_transaction_reported_at — stamped once Play accepts the report;
 *                                      NULL + token present = report pending
 *                                      (retry candidate / audit trail)
 *
 * Purchases made outside the choice screen (web, debug builds, Play
 * billing itself) leave both columns NULL.
 */
export class ExternalTransactionColumns1784400000000 implements MigrationInterface {
  name = 'ExternalTransactionColumns1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['subscriptions', 'course_purchases', 'material_purchase_orders']) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS external_transaction_token       TEXT,
          ADD COLUMN IF NOT EXISTS external_transaction_reported_at TIMESTAMPTZ
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['subscriptions', 'course_purchases', 'material_purchase_orders']) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          DROP COLUMN IF EXISTS external_transaction_token,
          DROP COLUMN IF EXISTS external_transaction_reported_at
      `);
    }
  }
}
