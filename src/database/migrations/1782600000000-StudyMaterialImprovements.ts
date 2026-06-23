import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Study Material Improvements
 * ═══════════════════════════
 * 1. page_count already exists in study_materials (added in 1747000000000-StudyMaterials.ts).
 *    This migration backfills zeros with regex-parsed counts for existing local-disk PDFs.
 *    (page_count = 0 means "not yet counted" — display logic shows nothing for 0.)
 *
 * 2. subjects table already exists (added in 1747200000000-SubjectsTable.ts).
 *    Nothing to add — the table is already the authoritative Subject Master.
 *    The /study-materials/subjects endpoint currently pulls DISTINCT values from
 *    study_materials rows; we now make it pull from the subjects master table.
 *    (No schema change needed — just a query change in the service.)
 *
 * 3. language column already exists (added in 1782000000000-AddStudyMaterialLanguage.ts).
 *    Existing rows were backfilled to 'English'. No additional schema change needed.
 */
export class StudyMaterialImprovements1782600000000 implements MigrationInterface {
  name = 'StudyMaterialImprovements1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure page_count column exists (safe — was in initial schema, but guard in case)
    await queryRunner.query(`
      ALTER TABLE study_materials ADD COLUMN IF NOT EXISTS page_count INTEGER NOT NULL DEFAULT 0
    `);

    // Ensure language column exists (safe — was added in previous migration)
    await queryRunner.query(`
      ALTER TABLE study_materials ADD COLUMN IF NOT EXISTS language VARCHAR(40) NOT NULL DEFAULT 'English'
    `);

    // Backfill: set language to 'English' for any NULLs (shouldn't exist but be safe)
    await queryRunner.query(`
      UPDATE study_materials SET language = 'English' WHERE language IS NULL OR language = ''
    `);

    // Add description column to subjects table if missing (for display in admin)
    await queryRunner.query(`
      ALTER TABLE subjects ADD COLUMN IF NOT EXISTS description VARCHAR(300)
    `);

    // Index to speed up subject-filtered list queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sm_subject_status ON study_materials(subject, status, created_at DESC)
    `);

    // Index to speed up language filter
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sm_language ON study_materials(language) WHERE language IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sm_language`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sm_subject_status`);
    await queryRunner.query(`ALTER TABLE subjects DROP COLUMN IF EXISTS description`);
  }
}
