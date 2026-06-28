import { MigrationInterface, QueryRunner } from 'typeorm';

export class UsersDeviceId1783000000003 implements MigrationInterface {
  name = 'UsersDeviceId1783000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS device_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS device_id_registered_at TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS device_id,
        DROP COLUMN IF EXISTS device_id_registered_at
    `);
  }
}
