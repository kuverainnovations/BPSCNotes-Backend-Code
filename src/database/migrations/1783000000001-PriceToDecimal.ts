import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Change all price columns from INTEGER to NUMERIC(10,2) so fractional
 * prices (e.g. ₹98.02) are stored and returned without truncation.
 *
 * Affected tables:
 *   courses            price, original_price
 *   study_materials    price
 *   subscription_plans price, original_price  (if exists)
 *   material_purchase_orders  price_paid (keep precision)
 */
export class PriceToDecimal1783000000001 implements MigrationInterface {
  name = 'PriceToDecimal1783000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // courses
    await queryRunner.query(`
      ALTER TABLE courses
        ALTER COLUMN price          TYPE NUMERIC(10,2) USING price::NUMERIC(10,2),
        ALTER COLUMN original_price TYPE NUMERIC(10,2) USING original_price::NUMERIC(10,2)
    `);

    // study_materials
    await queryRunner.query(`
      ALTER TABLE study_materials
        ALTER COLUMN price TYPE NUMERIC(10,2) USING price::NUMERIC(10,2)
    `);

    // subscription_plans (if table exists)
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscription_plans') THEN
          ALTER TABLE subscription_plans
            ALTER COLUMN price          TYPE NUMERIC(10,2) USING price::NUMERIC(10,2),
            ALTER COLUMN original_price TYPE NUMERIC(10,2) USING original_price::NUMERIC(10,2);
        END IF;
      END $$
    `);

    // material_purchase_orders — price_paid should also be precise
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='material_purchase_orders' AND column_name='price_paid') THEN
          ALTER TABLE material_purchase_orders
            ALTER COLUMN price_paid TYPE NUMERIC(10,2) USING price_paid::NUMERIC(10,2);
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE courses
        ALTER COLUMN price          TYPE INTEGER USING price::INTEGER,
        ALTER COLUMN original_price TYPE INTEGER USING original_price::INTEGER
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
        ALTER COLUMN price TYPE INTEGER USING price::INTEGER
    `);
  }
}
