import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowNullHostId1746676800000 implements MigrationInterface {
  name = 'AllowNullHostId1746676800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the NOT NULL constraint + FK, re-add FK allowing NULL
    // (admin-created rooms have no user host)
    await queryRunner.query(`
      ALTER TABLE study_rooms
        ALTER COLUMN host_id DROP NOT NULL
    `);

    // Also change ON DELETE CASCADE → SET NULL so deleting the host user
    // doesn't cascade-delete the entire room
    await queryRunner.query(`
      ALTER TABLE study_rooms
        DROP CONSTRAINT IF EXISTS study_rooms_host_id_fkey
    `);
    await queryRunner.query(`
      ALTER TABLE study_rooms
        ADD CONSTRAINT study_rooms_host_id_fkey
        FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_rooms
        DROP CONSTRAINT IF EXISTS study_rooms_host_id_fkey
    `);
    await queryRunner.query(`
      ALTER TABLE study_rooms
        ALTER COLUMN host_id SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE study_rooms
        ADD CONSTRAINT study_rooms_host_id_fkey
        FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE
    `);
  }
}
