import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCourseCoinLimit1780500000000 implements MigrationInterface {
  name = 'AddCourseCoinLimit1780500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NULL = use the global app_settings.max_coins_per_purchase default.
    // A non-null value overrides the global cap for this specific course.
    await queryRunner.query(`
      ALTER TABLE courses
        ADD COLUMN IF NOT EXISTS max_coins_redeemable INTEGER
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE courses
        DROP COLUMN IF EXISTS max_coins_redeemable
    `);
  }
}
