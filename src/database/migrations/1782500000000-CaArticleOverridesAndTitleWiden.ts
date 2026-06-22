import { MigrationInterface, QueryRunner } from 'typeorm';

// Two unrelated but small changes bundled together since both touch
// `current_affairs` and came from the same admin-panel conversation:
//
// 1. title VARCHAR(500) -> TEXT. Headline is becoming a rich-text field
//    (inline marks: bold/color/highlight/link) — the HTML markup overhead
//    (style attributes etc.) can push a genuinely short headline well past
//    500 raw characters even though the visible text is unchanged.
//
// 2. Per-article MCQ marking override, sitting ALONGSIDE the existing
//    global config in app_settings (both coexist, per product decision —
//    most articles inherit the global setting; an admin can override an
//    individual article when needed). NULL on the boolean column is the
//    sentinel for "no override, inherit global" — this is why it isn't
//    NOT NULL DEFAULT FALSE like a normal toggle.
export class CaArticleOverridesAndTitleWiden1782500000000 implements MigrationInterface {
  name = 'CaArticleOverridesAndTitleWiden1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE current_affairs ALTER COLUMN title TYPE TEXT`);

    await queryRunner.query(`
      ALTER TABLE current_affairs
        ADD COLUMN IF NOT EXISTS mcq_negative_marking_override BOOLEAN DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS mcq_marks_per_correct_override NUMERIC(6,2) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS mcq_marks_per_wrong_override   NUMERIC(6,2) DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE current_affairs
        DROP COLUMN IF EXISTS mcq_negative_marking_override,
        DROP COLUMN IF EXISTS mcq_marks_per_correct_override,
        DROP COLUMN IF EXISTS mcq_marks_per_wrong_override
    `);
    // title stays TEXT on rollback — narrowing back to VARCHAR(500) risks
    // truncating real data if anything was saved past that length in the
    // meantime, which a down-migration should never silently do.
  }
}
