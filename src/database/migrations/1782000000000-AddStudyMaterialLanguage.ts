import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `language` column to study_materials
 * ═════════════════════════════════════════
 * PROBLEM
 * Study materials uploaded by users have no way to specify the language
 * of the content (Hindi / English / Hindi+English etc). Admin has no way
 * to filter or display the language in the review queue or material list.
 *
 * FIX
 * Adds a `language` text column, defaulting to 'English' for existing rows
 * (safe default — most existing uploads were in English).
 */
export class AddStudyMaterialLanguage1782000000000 implements MigrationInterface {
  name = 'AddStudyMaterialLanguage1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_materials ADD COLUMN IF NOT EXISTS language VARCHAR(40) DEFAULT 'English'
    `);
    await queryRunner.query(`
      UPDATE study_materials SET language = 'English' WHERE language IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_materials DROP COLUMN IF EXISTS language
    `);
  }
}
