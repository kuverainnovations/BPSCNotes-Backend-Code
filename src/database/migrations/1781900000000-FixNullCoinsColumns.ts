import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fix NULL coins / numeric columns in users table
 * ════════════════════════════════════════════════
 * PROBLEM
 * Some users were created before the coins column had a DEFAULT 0 constraint,
 * or were inserted via direct SQL that omitted the column. These rows have
 * coins = NULL, which causes:
 *
 *   UPDATE users SET coins = coins + $1 → NULL + 20 = NULL
 *   INSERT INTO coin_transactions (balance) VALUES (NULL) → NOT NULL violation
 *   ERROR: null value in column "coins" of relation "users"
 *
 * FIX
 * 1. Backfill all NULL numeric columns to 0
 * 2. Set DEFAULT 0 on each column (so new inserts that omit the column are safe)
 * 3. Set NOT NULL constraint (matches the original schema intent)
 *
 * SAFE TO RUN
 * All steps use IF NOT EXISTS / conditionals so re-running is harmless.
 * The UPDATE only touches rows where the column IS NULL — a no-op if all
 * rows are already clean.
 */
export class FixNullCoinsColumns1781900000000 implements MigrationInterface {
  name = 'FixNullCoinsColumns1781900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── Step 1: Backfill NULL values to 0 ────────────────────
    // Only touches rows that actually have NULL — safe on clean DBs
    await queryRunner.query(`
      UPDATE users SET
        coins                = COALESCE(coins, 0),
        total_coins_earned   = COALESCE(total_coins_earned, 0),
        streak               = COALESCE(streak, 0),
        longest_streak       = COALESCE(longest_streak, 0),
        total_study_minutes  = COALESCE(total_study_minutes, 0),
        accuracy             = COALESCE(accuracy, 0),
        quizzes_attempted    = COALESCE(quizzes_attempted, 0),
        xp                   = COALESCE(xp, 0)
      WHERE
        coins               IS NULL OR
        total_coins_earned  IS NULL OR
        streak              IS NULL OR
        longest_streak      IS NULL OR
        total_study_minutes IS NULL OR
        accuracy            IS NULL OR
        quizzes_attempted   IS NULL
    `);

    // ── Step 2: Add xp column if it doesn't exist ────────────
    // (some DB instances may not have it yet)
    await queryRunner.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0
    `);

    // Backfill xp separately after column may have just been added
    await queryRunner.query(`
      UPDATE users SET xp = 0 WHERE xp IS NULL
    `);

    // ── Step 3: Set NOT NULL + DEFAULT on each column ─────────
    // ALTER COLUMN SET NOT NULL fails if any NULL still exists,
    // but Step 1 handles that. These are idempotent on already-correct columns.

    await queryRunner.query(`
      ALTER TABLE users
        ALTER COLUMN coins              SET DEFAULT 0,
        ALTER COLUMN total_coins_earned SET DEFAULT 0,
        ALTER COLUMN streak             SET DEFAULT 0,
        ALTER COLUMN longest_streak     SET DEFAULT 0,
        ALTER COLUMN total_study_minutes SET DEFAULT 0,
        ALTER COLUMN accuracy           SET DEFAULT 0,
        ALTER COLUMN quizzes_attempted  SET DEFAULT 0,
        ALTER COLUMN xp                 SET DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE users
        ALTER COLUMN coins               SET NOT NULL,
        ALTER COLUMN total_coins_earned  SET NOT NULL,
        ALTER COLUMN streak              SET NOT NULL,
        ALTER COLUMN longest_streak      SET NOT NULL,
        ALTER COLUMN total_study_minutes SET NOT NULL,
        ALTER COLUMN accuracy            SET NOT NULL,
        ALTER COLUMN quizzes_attempted   SET NOT NULL,
        ALTER COLUMN xp                  SET NOT NULL
    `);

    // ── Step 4: Fix coin_transactions.balance column ──────────
    // If balance has any NULLs from the failed award-coins calls, clean those too
    await queryRunner.query(`
      UPDATE coin_transactions SET balance = 0 WHERE balance IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE coin_transactions
        ALTER COLUMN balance SET DEFAULT 0
    `).catch(() => {}); // ignore if column already has default

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove NOT NULL constraints (restore to nullable)
    await queryRunner.query(`
      ALTER TABLE users
        ALTER COLUMN coins               DROP NOT NULL,
        ALTER COLUMN total_coins_earned  DROP NOT NULL,
        ALTER COLUMN streak              DROP NOT NULL,
        ALTER COLUMN longest_streak      DROP NOT NULL,
        ALTER COLUMN total_study_minutes DROP NOT NULL,
        ALTER COLUMN accuracy            DROP NOT NULL,
        ALTER COLUMN quizzes_attempted   DROP NOT NULL,
        ALTER COLUMN xp                  DROP NOT NULL
    `);
  }
}
