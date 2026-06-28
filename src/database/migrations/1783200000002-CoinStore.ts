import { MigrationInterface, QueryRunner } from 'typeorm';

export class CoinStore1783200000002 implements MigrationInterface {
  name = 'CoinStore1783200000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS coin_store_items (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        title       TEXT        NOT NULL,
        description TEXT,
        coin_cost   INTEGER     NOT NULL DEFAULT 0,
        item_type   TEXT        NOT NULL DEFAULT 'badge',
        item_value  TEXT,
        icon_url    TEXT,
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
        stock       INTEGER,
        sort_order  INTEGER     NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS coin_redemptions (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id        UUID        NOT NULL REFERENCES coin_store_items(id) ON DELETE RESTRICT,
        coins_spent    INTEGER     NOT NULL,
        status         TEXT        NOT NULL DEFAULT 'pending',
        redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_redemptions_user ON coin_redemptions(user_id, redeemed_at DESC)
    `);

    // Seed some default store items
    await queryRunner.query(`
      INSERT INTO coin_store_items (title, description, coin_cost, item_type, item_value, sort_order) VALUES
        ('Subscription Discount', '₹50 off on next subscription renewal', 500,  'discount',     '50',  1),
        ('Study Booster Pack',    '3 days of premium flashcard access',   300,  'flashcard_pack','3d',  2),
        ('Mock Test Unlock',      'Unlock any 1 paid mock test',          200,  'mock_unlock',   '1',   3),
        ('Gold Badge',            'Show off your dedication!',            100,  'badge',         'gold',4)
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS coin_redemptions`);
    await queryRunner.query(`DROP TABLE IF EXISTS coin_store_items`);
  }
}
