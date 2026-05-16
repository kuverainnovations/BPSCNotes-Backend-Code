import { MigrationInterface, QueryRunner } from 'typeorm';

// ─────────────────────────────────────────────────────────────
// MIGRATION: Add last_check_in_date to users table
// Required by CoinsService.checkIn() for streak tracking
// ─────────────────────────────────────────────────────────────
export class AddLastCheckInDate1747100000000 implements MigrationInterface {
  name = 'AddLastCheckInDate1747100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add column if it doesn't exist (safe to run multiple times)
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_check_in_date TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users DROP COLUMN IF EXISTS last_check_in_date
    `);
  }
}
