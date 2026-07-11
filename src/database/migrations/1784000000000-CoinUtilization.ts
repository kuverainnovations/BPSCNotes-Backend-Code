import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Coin Utilization — spend earned coins inside the app.
 *
 * 1. Premium quiz/mock-test unlock:
 *    - quizzes.unlock_cost_coins (0 = free, >0 = locked until unlocked)
 *    - coin_unlocks — one row per user per unlocked content item
 *      (content_type kept generic so materials/notes can reuse it later)
 *
 * 2. Streak Freeze (bought in the Coin Store, item_type='streak_freeze'):
 *    - users.streak_freezes — how many freezes the user is holding
 *    - auto-consumed by POST /coins/check-in when a day was missed
 *
 * Also seeds a default "Streak Freeze" coin-store item so the store has
 * a functional item out of the box (admin-editable like any other item).
 */
export class CoinUtilization1784000000000 implements MigrationInterface {
  name = 'CoinUtilization1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS unlock_cost_coins INTEGER NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS coin_unlocks (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_type VARCHAR(30) NOT NULL DEFAULT 'quiz',
        content_id   UUID        NOT NULL,
        coins_spent  INTEGER     NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, content_type, content_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_coin_unlocks_user ON coin_unlocks(user_id)
    `);

    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS streak_freezes INTEGER NOT NULL DEFAULT 0
    `);

    // Default store item — only if no streak_freeze item exists yet.
    await queryRunner.query(`
      INSERT INTO coin_store_items (title, description, coin_cost, item_type, item_value, sort_order)
      SELECT 'Streak Freeze 🧊',
             'Miss a day without losing your check-in streak. Applied automatically on your next check-in.',
             50, 'streak_freeze', '1', 0
      WHERE NOT EXISTS (SELECT 1 FROM coin_store_items WHERE item_type = 'streak_freeze')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM coin_store_items WHERE item_type = 'streak_freeze'`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS streak_freezes`);
    await queryRunner.query(`DROP TABLE IF EXISTS coin_unlocks`);
    await queryRunner.query(`ALTER TABLE quizzes DROP COLUMN IF EXISTS unlock_cost_coins`);
  }
}
