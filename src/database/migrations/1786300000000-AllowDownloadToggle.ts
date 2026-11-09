import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-content "can this PDF be downloaded?" switch.
 *
 * Reading in-app was always allowed; the ask is to stop a given PDF from
 * leaving the app. Granularity differs by surface, matching how admins
 * actually work with each:
 *
 *   · study_materials — per item. Student Hub material is uploaded and priced
 *     one piece at a time, so the switch belongs on the piece.
 *   · courses         — per course. Lesson notes are authored in bulk under a
 *     course; a per-lesson switch would mean toggling it dozens of times to
 *     express one intent.
 *
 * Note `library_notes` (the separate e-library module) is deliberately not
 * covered — the request named Student Hub and Courses, which are these two
 * tables. Adding it later is the same one-line ALTER.
 *
 * Defaults to TRUE everywhere so existing content keeps behaving exactly as
 * it does today — this only takes downloads away where an admin says so.
 */
export class AllowDownloadToggle1786300000000 implements MigrationInterface {
  name = 'AllowDownloadToggle1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_materials
        ADD COLUMN IF NOT EXISTS allow_download BOOLEAN NOT NULL DEFAULT TRUE
    `);
    await queryRunner.query(`
      ALTER TABLE courses
        ADD COLUMN IF NOT EXISTS allow_download BOOLEAN NOT NULL DEFAULT TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE study_materials DROP COLUMN IF EXISTS allow_download`);
    await queryRunner.query(`ALTER TABLE courses         DROP COLUMN IF EXISTS allow_download`);
  }
}
