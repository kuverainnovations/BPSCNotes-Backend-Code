import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Flashcard Image Support + Topic column
 *
 * Adds:
 *   flashcards.image_url     — optional Cloudinary URL for image-type cards
 *   flashcards.card_type     — 'text' (default) | 'image' — drives Android rendering
 *   flashcards.topic         — more specific topic within subject (was derived from subject)
 *   flashcards.hint          — optional hint text shown on front
 *   flashcards.example       — optional example shown on back
 *
 * Also fixes coin_rules unique constraint so action column can be used as key.
 */
export class FlashcardImageSupport1747500000000 implements MigrationInterface {
  name = 'FlashcardImageSupport1747500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── Flashcard new columns ────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE flashcards
        ADD COLUMN IF NOT EXISTS card_type  VARCHAR(10) NOT NULL DEFAULT 'text'
          CHECK (card_type IN ('text','image')),
        ADD COLUMN IF NOT EXISTS image_url  TEXT,
        ADD COLUMN IF NOT EXISTS topic      VARCHAR(200),
        ADD COLUMN IF NOT EXISTS hint       TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS example    TEXT DEFAULT '';
    `);

    // Back-fill topic from subject for existing rows
    await queryRunner.query(`
      UPDATE flashcards SET topic = subject WHERE topic IS NULL OR topic = '';
    `);

    // Add index on subject for fast filtering
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_flashcards_subject ON flashcards(subject);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_flashcards_card_type ON flashcards(card_type);
    `);

    // ── Ensure coin_rules has unique constraint on action ────
    // (Needed so ON CONFLICT(action) works in seeds)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'coin_rules_action_key'
        ) THEN
          ALTER TABLE coin_rules ADD CONSTRAINT coin_rules_action_key UNIQUE (action);
        END IF;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE flashcards
        DROP COLUMN IF EXISTS card_type,
        DROP COLUMN IF EXISTS image_url,
        DROP COLUMN IF EXISTS topic,
        DROP COLUMN IF EXISTS hint,
        DROP COLUMN IF EXISTS example;
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_flashcards_subject;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_flashcards_card_type;`);
  }
}
