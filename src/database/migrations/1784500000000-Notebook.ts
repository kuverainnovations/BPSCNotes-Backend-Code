import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notebook — personal study notes
 * ════════════════════════════════
 * Free-form notes a user writes for themselves (dashboard → Notebook).
 * Purely personal data: no admin surface, no sharing — every query is
 * scoped to user_id.
 *
 *   color     — UI accent chip chosen by the user ('yellow', 'blue', …);
 *               stored as a name, not hex, so the app controls the palette
 *   is_pinned — pinned notes sort above the rest
 */
export class Notebook1784500000000 implements MigrationInterface {
  name = 'Notebook1784500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notebook_notes (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      VARCHAR(200) NOT NULL DEFAULT '',
        content    TEXT NOT NULL DEFAULT '',
        color      VARCHAR(20),
        is_pinned  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_notebook_notes_user
        ON notebook_notes (user_id, is_pinned DESC, updated_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS notebook_notes`);
  }
}
