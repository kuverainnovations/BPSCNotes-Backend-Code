import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuizDefaults1783000000006 implements MigrationInterface {
  name = 'QuizDefaults1783000000006';

  async up(qr: QueryRunner): Promise<void> {
    // Add shuffle columns to quizzes table
    await qr.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS shuffle_questions BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS shuffle_options   BOOLEAN NOT NULL DEFAULT true
    `);

    // App settings defaults for quiz shuffle
    await qr.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('quiz_shuffle_questions', 'true'),
        ('quiz_shuffle_options',   'true')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DELETE FROM app_settings WHERE key IN ('quiz_shuffle_questions','quiz_shuffle_options')`);
    await qr.query(`ALTER TABLE quizzes DROP COLUMN IF EXISTS shuffle_questions, DROP COLUMN IF EXISTS shuffle_options`);
  }
}
