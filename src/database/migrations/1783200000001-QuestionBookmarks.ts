import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuestionBookmarks1783200000001 implements MigrationInterface {
  name = 'QuestionBookmarks1783200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bookmarked_questions (
        user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        question_id UUID        NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
        quiz_id     UUID        NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, question_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_bq_user ON bookmarked_questions(user_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS bookmarked_questions`);
  }
}
