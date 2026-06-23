import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Current Affairs — Additional Content Fields
 * ════════════════════════════════════════════
 * Adds five new TipTap-rich columns to current_affairs:
 *
 *   key_points        — bullet-form key takeaways (exam-friendly)
 *   exam_relevance    — which exam it matters for + why (free text / rich)
 *   important_facts   — specific numbers, names, dates worth memorising
 *
 * headline (title) and summary already exist.
 * full_content already exists and is the main article body.
 *
 * All three new cols are nullable TEXT (TipTap HTML).
 * The PDF generator will render them as named sections before full_content.
 * Android will display them in the WebView as labelled sections.
 */
export class CaContentFields1782900000000 implements MigrationInterface {
  name = 'CaContentFields1782900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE current_affairs
        ADD COLUMN IF NOT EXISTS key_points       TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS exam_relevance   TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS important_facts  TEXT DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE current_affairs
        DROP COLUMN IF EXISTS key_points,
        DROP COLUMN IF EXISTS exam_relevance,
        DROP COLUMN IF EXISTS important_facts
    `);
  }
}
