import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notebook v3 — rich block content
 * ═════════════════════════════════
 * Notes become an ordered list of typed blocks (heading / text / bullet /
 * numbered / check / image), stored as JSONB:
 *   [{ "type":"heading", "text":"Polity" },
 *    { "type":"check", "text":"Preamble", "done":true },
 *    { "type":"image", "url":"https://api.bpscnotes.in/uploads/images/…" }]
 *
 * The existing `content` TEXT column is kept as a plain-text flattening of
 * the blocks — it still powers search (title/content ILIKE) and the
 * share-as-text export, and it's what legacy/pre-blocks notes (blocks
 * NULL) render from. New notes write BOTH: structured `blocks` + flattened
 * `content`.
 */
export class NotebookBlocks1784700000000 implements MigrationInterface {
  name = 'NotebookBlocks1784700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notebook_notes ADD COLUMN IF NOT EXISTS blocks JSONB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notebook_notes DROP COLUMN IF EXISTS blocks
    `);
  }
}
