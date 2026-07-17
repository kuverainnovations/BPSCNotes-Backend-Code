import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Answer Writing v2 — client feedback round (16 Jul notes):
 *
 * 1. PYQ badge: answer_questions.is_pyq + pyq_year — Previous Year
 *    Questions are marked on the card in the app.
 * 2. "Top three weaknesses": a peer review can now flag up to 3
 *    improvement areas (improvement_areas[]); the old single
 *    improvement_area column stays for back-compat.
 *
 * (Model-answer next-day reveal and the give-to-get queue priority are
 * pure logic changes in the module — no schema needed.)
 */
export class AnswerWritingV21784300000000 implements MigrationInterface {
  name = 'AnswerWritingV21784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_questions
        ADD COLUMN IF NOT EXISTS is_pyq   BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS pyq_year INTEGER
    `);
    await queryRunner.query(`
      ALTER TABLE answer_peer_reviews
        ADD COLUMN IF NOT EXISTS improvement_areas TEXT[]
    `);
    // Backfill: single-area reviews become one-element arrays
    await queryRunner.query(`
      UPDATE answer_peer_reviews
      SET improvement_areas = ARRAY[improvement_area]
      WHERE improvement_areas IS NULL AND improvement_area IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE answer_peer_reviews DROP COLUMN IF EXISTS improvement_areas`);
    await queryRunner.query(`
      ALTER TABLE answer_questions
        DROP COLUMN IF EXISTS is_pyq,
        DROP COLUMN IF EXISTS pyq_year
    `);
  }
}
