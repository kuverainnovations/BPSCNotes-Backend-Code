import { MigrationInterface, QueryRunner } from 'typeorm';

export class MatchTypeQuestion1783300000000 implements MigrationInterface {
  name = 'MatchTypeQuestion1783300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quiz_questions
        ADD COLUMN IF NOT EXISTS question_subtype VARCHAR(20) NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS match_data JSONB DEFAULT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_quiz_questions_subtype ON quiz_questions(question_subtype);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS question_subtype`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS match_data`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_quiz_questions_subtype`);
  }
}
