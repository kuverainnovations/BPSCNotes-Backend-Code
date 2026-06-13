import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes flashcards.example — the "Example (on back)" field shown in
 * the admin flashcard form was not meaningful in practice and has been
 * removed from the UI. No client (Android) ever consumed this field.
 */
export class DropFlashcardExample1780700000000 implements MigrationInterface {
  name = 'DropFlashcardExample1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE flashcards
        DROP COLUMN IF EXISTS example
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE flashcards
        ADD COLUMN IF NOT EXISTS example TEXT DEFAULT ''
    `);
  }
}
