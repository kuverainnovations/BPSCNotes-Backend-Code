import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Community Marketplace — Creator Economy
 *
 * Adds:
 *  - study_materials.price         INT  — 0 = free, >0 = coins required
 *  - study_materials.free_pages    INT  — pages shown before paywall (default 3)
 *  - study_materials.is_marketplace BOOLEAN — user-uploaded for sale
 *  - material_purchases table      — tracks who bought what (for coin commission)
 *  - material_downloads table      — tracks download history (for Downloads tab)
 *
 * Commission model: BPSCNotes 30% / Creator 70%
 * Enforced in code (study-materials.module.ts purchaseMaterial method).
 */
export class MarketplaceCreatorEconomy1779700000000 implements MigrationInterface {
  name = 'MarketplaceCreatorEconomy1779700000000';

  async up(queryRunner: QueryRunner): Promise<void> {

    // ── 1. study_materials: add price + marketplace columns ──
    await queryRunner.query(`
      ALTER TABLE study_materials
        ADD COLUMN IF NOT EXISTS price          INT     NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS free_pages     INT     NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS is_marketplace BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // ── 2. material_purchases — tracks paid unlocks ──────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_purchases (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id   UUID        NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        price_paid    INT         NOT NULL DEFAULT 0,
        coins_paid    INT         NOT NULL DEFAULT 0,
        platform_fee  INT         NOT NULL DEFAULT 0,  -- BPSCNotes 30% share
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (material_id, user_id)  -- one purchase record per user per material
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mp_user_id     ON material_purchases(user_id);
      CREATE INDEX IF NOT EXISTS idx_mp_material_id ON material_purchases(material_id);
    `);

    // ── 3. material_downloads — download history ─────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_downloads (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id UUID        NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (material_id, user_id)  -- upserted on re-download (updates timestamp)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_md_user_id     ON material_downloads(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_md_material_id ON material_downloads(material_id);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS material_downloads CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS material_purchases CASCADE`);
    await queryRunner.query(`
      ALTER TABLE study_materials
        DROP COLUMN IF EXISTS price,
        DROP COLUMN IF EXISTS free_pages,
        DROP COLUMN IF EXISTS is_marketplace;
    `);
  }
}
