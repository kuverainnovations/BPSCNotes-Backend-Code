import { MigrationInterface, QueryRunner } from 'typeorm';

export class CaMcqMatchType1783300000001 implements MigrationInterface {
  name = 'CaMcqMatchType1783300000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ca_mcqs
        ADD COLUMN IF NOT EXISTS question_subtype VARCHAR(20) NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS match_data JSONB DEFAULT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ca_mcqs DROP COLUMN IF EXISTS question_subtype`);
    await queryRunner.query(`ALTER TABLE ca_mcqs DROP COLUMN IF EXISTS match_data`);
  }
}
