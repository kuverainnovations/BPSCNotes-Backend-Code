import { MigrationInterface, QueryRunner } from 'typeorm';

export class UsersOnboarding1783000000007 implements MigrationInterface {
  name = 'UsersOnboarding1783000000007';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS daily_goal_mins       INT     DEFAULT 120
    `);
    // primary_exam, prep_level, target_year already exist in users table.
    // onboarding_completed = NULL for existing users → skip wizard.
    // Only newly registered users get onboarding_completed = false set
    // explicitly during the registration INSERT.
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS onboarding_completed,
        DROP COLUMN IF EXISTS daily_goal_mins
    `);
  }
}
