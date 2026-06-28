import { MigrationInterface, QueryRunner } from 'typeorm';

export class AppSettingsDefaults1783000000004 implements MigrationInterface {
  name = 'AppSettingsDefaults1783000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO app_settings (key, value, description)
      VALUES ('screen_capture_protection', 'true', 'Prevent screenshots and screen recording in the app')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM app_settings WHERE key = 'screen_capture_protection'
    `);
  }
}
