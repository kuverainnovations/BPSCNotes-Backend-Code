import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Community Marketplace — Creator Economy
 *
 * Adds:
 *  - study_materials.price
 *  - study_materials.free_pages
 *  - study_materials.is_marketplace
 *  - material_purchases table
 *  - material_downloads table
 */

export class MarketplaceCreatorEconomy1779700000000
  implements MigrationInterface
{
  name = 'MarketplaceCreatorEconomy1779700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ─────────────────────────────────────────────
    // study_materials columns
    // ─────────────────────────────────────────────

    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS price INT NOT NULL DEFAULT 0;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS free_pages INT NOT NULL DEFAULT 3;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS is_marketplace BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Optional future-safe fields
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) NOT NULL DEFAULT 0;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS rating_count INT NOT NULL DEFAULT 0;
    `);

    // ─────────────────────────────────────────────
    // material_purchases
    // ─────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        material_id UUID NOT NULL
          REFERENCES study_materials(id)
          ON DELETE CASCADE,

        user_id UUID NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        price_paid INT NOT NULL DEFAULT 0,
        coins_paid INT NOT NULL DEFAULT 0,
        platform_fee INT NOT NULL DEFAULT 0,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(material_id, user_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mp_user_id
      ON material_purchases(user_id);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mp_material_id
      ON material_purchases(material_id);
    `);

    // ─────────────────────────────────────────────
    // material_downloads
    // ─────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_downloads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        material_id UUID NOT NULL
          REFERENCES study_materials(id)
          ON DELETE CASCADE,

        user_id UUID NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(material_id, user_id)
      );
    `);

    // IMPORTANT:
    // Removed DESC to avoid created_at startup crash
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_md_user_id
      ON material_downloads(user_id, created_at);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_md_material_id
      ON material_downloads(material_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {

    await queryRunner.query(`
      DROP TABLE IF EXISTS material_downloads CASCADE;
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS material_purchases CASCADE;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      DROP COLUMN IF EXISTS rating_count;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      DROP COLUMN IF EXISTS rating;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      DROP COLUMN IF EXISTS is_marketplace;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      DROP COLUMN IF EXISTS free_pages;
    `);

    await queryRunner.query(`
      ALTER TABLE study_materials
      DROP COLUMN IF EXISTS price;
    `);
  }
}