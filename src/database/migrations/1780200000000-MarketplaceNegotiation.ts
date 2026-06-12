import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace Negotiation System (Phase 2)
 *
 * Implements the admin <-> uploader price negotiation flow from the
 * Study Materials marketplace spec:
 *
 *  - Admin can reject a pending material WITH a counter-offer price
 *    instead of an outright rejection.
 *  - The uploader can then Accept the counter-offer, or send their
 *    own counter-offer back.
 *  - Maximum 3 negotiation rounds total. If still unresolved after
 *    round 3, the admin makes a final call (approve at the last
 *    proposed price, or reject permanently).
 *
 * New columns on study_materials:
 *  - negotiation_round    INT  — 0 = no negotiation yet, increments
 *                                 on each counter-offer (admin or user)
 *  - current_offer_price  INT  — the price currently "on the table"
 *  - proposed_by          TEXT — 'admin' | 'user' — who made the
 *                                 most recent offer
 *  - negotiation_status   TEXT — 'none' | 'awaiting_user' |
 *                                 'awaiting_admin' | 'resolved'
 *
 * New table material_negotiations — full audit trail of every offer
 * made during a negotiation (round number, who made it, price,
 * optional message, timestamp).
 *
 * status enum is extended with 'negotiating' — a material in this
 * state is NOT visible to students (same as 'pending') but is
 * distinguished in the admin queue and the uploader's My Uploads tab
 * so the negotiation banner can be shown.
 */
export class MarketplaceNegotiation1780200000000 implements MigrationInterface {
  name = 'MarketplaceNegotiation1780200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Extend status CHECK constraint to allow 'negotiating' ────
    // Drop and recreate the constraint (Postgres has no
    // ADD COLUMN IF NOT EXISTS for CHECK constraints / no easy
    // ALTER CONSTRAINT, so we drop by the auto-generated name first).
    await queryRunner.query(`
      ALTER TABLE study_materials DROP CONSTRAINT IF EXISTS study_materials_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD CONSTRAINT study_materials_status_check
      CHECK (status IN ('pending','approved','rejected','negotiating'));
    `);

    // ── Negotiation columns on study_materials ───────────────────
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS negotiation_round INT NOT NULL DEFAULT 0;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS current_offer_price INT;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS proposed_by VARCHAR(10);
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD COLUMN IF NOT EXISTS negotiation_status VARCHAR(20) NOT NULL DEFAULT 'none'
      CHECK (negotiation_status IN ('none','awaiting_user','awaiting_admin','resolved'));
    `);

    // ── material_negotiations — full offer history ───────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_negotiations (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id UUID NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        round       INT NOT NULL,
        offered_by  VARCHAR(10) NOT NULL CHECK (offered_by IN ('admin','user')),
        offer_price INT NOT NULL,
        message     TEXT,
        action      VARCHAR(20) NOT NULL DEFAULT 'counter'
                    CHECK (action IN ('counter','accept','final_approve','final_reject')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mn_material ON material_negotiations(material_id, round ASC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS material_negotiations CASCADE`);
    await queryRunner.query(`
      ALTER TABLE study_materials DROP COLUMN IF EXISTS negotiation_status;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials DROP COLUMN IF EXISTS proposed_by;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials DROP COLUMN IF EXISTS current_offer_price;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials DROP COLUMN IF EXISTS negotiation_round;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials DROP CONSTRAINT IF EXISTS study_materials_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
      ADD CONSTRAINT study_materials_status_check
      CHECK (status IN ('pending','approved','rejected'));
    `);
  }
}
