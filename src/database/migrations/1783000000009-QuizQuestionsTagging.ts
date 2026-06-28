import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuizQuestionsTagging1783000000009 implements MigrationInterface {
  name = 'QuizQuestionsTagging1783000000009';

  // CONCURRENTLY index builds cannot run inside a transaction.
  // All statements are guarded with IF NOT EXISTS / IF EXISTS.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quiz_questions
        ADD COLUMN IF NOT EXISTS difficulty VARCHAR(10) DEFAULT 'medium'
          CHECK (difficulty IN ('easy', 'medium', 'hard')),
        ADD COLUMN IF NOT EXISTS topic_tag  VARCHAR(100)
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quiz_questions_difficulty
        ON quiz_questions (difficulty)
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quiz_questions_topic
        ON quiz_questions (topic_tag)
        WHERE topic_tag IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_quiz_questions_topic`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_quiz_questions_difficulty`);
    await queryRunner.query(`
      ALTER TABLE quiz_questions
        DROP COLUMN IF EXISTS difficulty,
        DROP COLUMN IF EXISTS topic_tag
    `);
  }
}
