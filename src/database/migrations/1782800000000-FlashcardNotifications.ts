import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Flashcard Notifications
 * ═══════════════════════
 * Adds a flashcard_notification_prefs table for subject-wise
 * notification subscriptions. Users opt in per subject (or globally).
 * When admin publishes flashcards for that subject, only subscribed
 * users receive a push.
 *
 * topic_key values:
 *   'all'       → global: every new flashcard batch
 *   'Polity'    → only Polity flashcards
 *   'History'   → etc.
 */
export class FlashcardNotifications1782800000000 implements MigrationInterface {
  name = 'FlashcardNotifications1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS flashcard_notif_prefs (
        user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic_key VARCHAR(100) NOT NULL DEFAULT 'all',
        PRIMARY KEY (user_id, topic_key)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_fnp_topic ON flashcard_notif_prefs(topic_key)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS flashcard_notif_prefs`);
  }
}
