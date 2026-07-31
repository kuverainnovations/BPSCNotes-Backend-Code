import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Current Affairs is restructured into the nine sections the content team
 * actually writes, in one fixed order shared by the admin panel and the app:
 *
 *   1. Summary                     summary            (existing)
 *   2. Key Points                  key_points         (existing)
 *   3. Multidimensional Analysis   full_content       (existing — was "Full Article")
 *   4. Major Issues / Challenges   major_issues       (new)
 *   5. Government Initiatives      govt_initiatives   (new)
 *   6. Bihar Specific              bihar_specific     (new)
 *   7. Value Addition              exam_relevance     (existing — was "Exam Relevance")
 *   8. Way Forward & Conclusion    way_forward        (new)
 *   9. Quotes                      quotes             (new)
 *
 * Nothing is renamed at the DB level: full_content and exam_relevance keep their
 * column names and their content, and only the label above them changes. That
 * keeps every existing article readable and this migration reversible.
 *
 * important_facts is deliberately NOT dropped. It no longer appears in the admin
 * form or the app, but live articles have content in it and DROP COLUMN cannot be
 * undone. Drop it in a later migration once the content team confirms the data is
 * either migrated into one of the new sections or genuinely unwanted.
 */
export class CaNineSections1785500000000 implements MigrationInterface {
  name = 'CaNineSections1785500000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE current_affairs
        ADD COLUMN IF NOT EXISTS major_issues     TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS govt_initiatives TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS bihar_specific   TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS way_forward      TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS quotes           TEXT DEFAULT NULL
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE current_affairs
        DROP COLUMN IF EXISTS major_issues,
        DROP COLUMN IF EXISTS govt_initiatives,
        DROP COLUMN IF EXISTS bihar_specific,
        DROP COLUMN IF EXISTS way_forward,
        DROP COLUMN IF EXISTS quotes
    `);
  }
}
