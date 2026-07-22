import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notebook v2 — source_ref for dedup (QA 21-07 Issue 10)
 * ══════════════════════════════════════════════════════
 * When a note is created from a mock-test / quiz solution ("Add to Notebook"),
 * the source question id is stored in `source_ref`. A partial unique index on
 * (user_id, source_ref) makes re-adding the same question idempotent instead of
 * piling up duplicate note cards. NULL source_ref (manually created notes) is
 * unconstrained, so users can still make as many free-form notes as they like.
 */
export class NotebookSourceRef1784900000000 implements MigrationInterface {
  name = 'NotebookSourceRef1784900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notebook_notes ADD COLUMN IF NOT EXISTS source_ref VARCHAR(100)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_notebook_notes_user_source
        ON notebook_notes (user_id, source_ref)
        WHERE source_ref IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS ux_notebook_notes_user_source`);
    await queryRunner.query(`ALTER TABLE notebook_notes DROP COLUMN IF EXISTS source_ref`);
  }
}
