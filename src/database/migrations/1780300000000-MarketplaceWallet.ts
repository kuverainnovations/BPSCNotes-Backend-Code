import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace Wallet System (Phase 3)
 *
 * Implements the two-currency model agreed for the marketplace:
 *  - coins       : existing in-app gamification currency (unchanged)
 *  - ₹ wallet    : new, real-money seller earnings ledger, separate
 *                   from coins, intended for future cash withdrawal
 *
 * Hybrid checkout (per spec):
 *  - Buyer can apply up to `max_coins_per_purchase` coins as a discount
 *    (1 coin = ₹1 by default, configurable via app_settings)
 *  - Remaining ₹ balance is paid via Razorpay
 *  - On successful payment, the full ₹ price (price field on
 *    study_materials, already ₹ after Phase 2) is split 60/40:
 *    60% credited to the uploader's seller_wallets.balance,
 *    40% retained by the platform
 *  - Every credit is logged in wallet_transactions with a status
 *    ('pending'|'disbursed'|'failed') for audit, even though
 *    disbursement currently happens automatically/instantly
 *
 * New tables:
 *  - seller_wallets       : one row per user, running ₹ balance
 *  - wallet_transactions  : full ledger of credits/withdrawals
 *  - material_purchase_orders : Razorpay order tracking for
 *    marketplace material purchases (mirrors course_purchases)
 *
 * New app_settings keys (seeded with sensible defaults):
 *  - max_coins_per_purchase  = '50'   (max coins a buyer can apply)
 *  - coin_to_inr_rate        = '1'    (₹ value of 1 coin)
 *  - seller_commission_pct   = '60'   (% of sale price credited to seller)
 */
export class MarketplaceWallet1780300000000 implements MigrationInterface {
  name = 'MarketplaceWallet1780300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── seller_wallets ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS seller_wallets (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance    INTEGER NOT NULL DEFAULT 0,  -- ₹, disbursed & withdrawable
        total_earned INTEGER NOT NULL DEFAULT 0, -- ₹, lifetime gross credits (for stats)
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── wallet_transactions ───────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type          VARCHAR(20) NOT NULL
                      CHECK (type IN ('sale_credit','withdrawal','adjustment')),
        amount        INTEGER NOT NULL,         -- ₹, always positive; type determines direction
        status        VARCHAR(20) NOT NULL DEFAULT 'disbursed'
                      CHECK (status IN ('pending','disbursed','failed')),
        material_id   UUID REFERENCES study_materials(id) ON DELETE SET NULL,
        purchase_id   UUID,                     -- references material_purchase_orders.id
        description   VARCHAR(255),
        balance_after INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disbursed_at  TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_wt_user ON wallet_transactions(user_id, created_at DESC)
    `);

    // ── material_purchase_orders — Razorpay order tracking ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_purchase_orders (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id         UUID NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        material_price      INTEGER NOT NULL,        -- ₹, full price at time of purchase
        coins_applied       INTEGER NOT NULL DEFAULT 0,
        coin_discount_inr   INTEGER NOT NULL DEFAULT 0,
        amount_due_inr      INTEGER NOT NULL,        -- price - coin_discount, paid via Razorpay (can be 0)
        razorpay_order_id   VARCHAR(100),
        razorpay_payment_id VARCHAR(100),
        payment_method      VARCHAR(50),
        status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','completed','failed')),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mpo_user ON material_purchase_orders(user_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mpo_material ON material_purchase_orders(material_id)
    `);

    // ── app_settings defaults ─────────────────────────────────
    await queryRunner.query(`
      INSERT INTO app_settings (key, value, description) VALUES
        ('max_coins_per_purchase', '50', 'Max coins a buyer can apply as discount on a marketplace purchase'),
        ('coin_to_inr_rate',       '1',  'Rupee value of 1 coin when applied as a marketplace discount'),
        ('seller_commission_pct', '60', 'Percentage of marketplace sale price credited to the uploader''s wallet')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS material_purchase_orders CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_transactions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS seller_wallets CASCADE`);
    await queryRunner.query(`
      DELETE FROM app_settings WHERE key IN
        ('max_coins_per_purchase','coin_to_inr_rate','seller_commission_pct')
    `);
  }
}
