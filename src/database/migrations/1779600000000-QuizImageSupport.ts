import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds image-based MCQ support to quiz_questions table.
 *
 * question_type:        'text' | 'image'  — whether the question has an image
 * question_image_url:   URL of the main question image (shown above text)
 * option_a_image:       URL of image for option A (when options are images)
 * option_b_image:       URL for option B
 * option_c_image:       URL for option C
 * option_d_image:       URL for option D
 * option_type:          'text' | 'image' | 'mixed'
 *                       text  = all 4 options are text (classic MCQ)
 *                       image = all 4 options are images (shown as 2×2 grid)
 *                       mixed = options have both text and image (text shown with image below)
 */
export class QuizImageSupport1779600000000 implements MigrationInterface {
  name = 'QuizImageSupport1779600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Add question_type enum column
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE quiz_question_type AS ENUM ('text', 'image');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE quiz_option_type AS ENUM ('text', 'image', 'mixed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // Add image columns to quiz_questions (safe — won't fail if column already exists)
    const cols = [
      `question_type     quiz_question_type NOT NULL DEFAULT 'text'`,
      `question_image_url TEXT`,
      `option_type        quiz_option_type  NOT NULL DEFAULT 'text'`,
      `option_a_image     TEXT`,
      `option_b_image     TEXT`,
      `option_c_image     TEXT`,
      `option_d_image     TEXT`,
    ];

    for (const col of cols) {
      const colName = col.split(' ')[0].trim();
      await queryRunner.query(`
        DO $$ BEGIN
          ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS ${col};
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `);
    }

    // Index for filtering by question type
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_quiz_questions_type ON quiz_questions(question_type);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS question_type`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS question_image_url`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS option_type`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS option_a_image`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS option_b_image`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS option_c_image`);
    await queryRunner.query(`ALTER TABLE quiz_questions DROP COLUMN IF EXISTS option_d_image`);
    await queryRunner.query(`DROP TYPE IF EXISTS quiz_question_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS quiz_option_type`);
  }
}
