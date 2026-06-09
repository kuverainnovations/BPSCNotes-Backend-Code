import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMpinColumns1780100000000 implements MigrationInterface {
  name = 'AddMpinColumns1780100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add MPIN columns to users table.
    // mpin_hash NULL = user has no MPIN yet (natural sentinel — no extra flag needed).
    // All columns use IF NOT EXISTS so the migration is safe to re-run.
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS mpin_hash            VARCHAR(255),
        ADD COLUMN IF NOT EXISTS mpin_failed_attempts INTEGER     NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS mpin_locked_until    TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS mpin_created_at      TIMESTAMPTZ
    `);

    // Index on mobile for check-mpin lookup (already indexed as UNIQUE, but explicit)
    // mpin_locked_until index speeds up the "is locked?" check on hot login path
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_mpin_locked
        ON users (mobile, mpin_locked_until)
        WHERE mpin_locked_until IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_mpin_locked`);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS mpin_hash,
        DROP COLUMN IF EXISTS mpin_failed_attempts,
        DROP COLUMN IF EXISTS mpin_locked_until,
        DROP COLUMN IF EXISTS mpin_created_at
    `);
  }
}
