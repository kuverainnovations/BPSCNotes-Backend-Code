import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuizExamMode1783200000000 implements MigrationInterface {
  name = 'QuizExamMode1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS is_exam_mode BOOLEAN DEFAULT FALSE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        DROP COLUMN IF EXISTS is_exam_mode
    `);
  }
}
