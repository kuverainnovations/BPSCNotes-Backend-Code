import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notebook v2 — subject tag on notes
 * ═══════════════════════════════════
 * Free-text subject label ('Polity', 'History', …) chosen from the app's
 * chip set; also auto-filled when a note is created from a mock-test
 * solution ("Add to Notebook"). Filtering happens client-side, so no
 * index needed at current note volumes (list is capped at 500/user).
 */
export class NotebookSubject1784600000000 implements MigrationInterface {
  name = 'NotebookSubject1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notebook_notes ADD COLUMN IF NOT EXISTS subject VARCHAR(100)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notebook_notes DROP COLUMN IF EXISTS subject
    `);
  }
}
