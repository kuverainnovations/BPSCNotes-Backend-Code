import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Custom (user-generated) practice tests.
 *
 * The app's "Create Custom Test" sheet let a user pick subjects, question
 * count, duration and negative marking — then fabricated a client-side id
 * (`custom_<timestamp>`) and handed it to GET /quizzes/:id/start. That id is
 * not a UUID, so the request never had a chance of working: the feature was
 * UI-only. This adds the storage the generator needs.
 *
 * A generated test is a real `quizzes` row so the entire existing pipeline —
 * start, resume, submit, negative marking, review, leaderboard — works
 * unchanged. Two columns keep it out of everyone else's way:
 *
 *   is_custom          — excluded from every public/admin listing and search,
 *                        so a user's private practice test never appears as
 *                        catalogue content.
 *   created_by_user_id — the owner. Also gives a cheap cleanup handle, since
 *                        these accumulate one row per generated test.
 *
 * quiz_type is an enum ('daily','topic','mock') and generated tests reuse
 * 'topic' rather than widening it — the flag is what distinguishes them.
 */
export class CustomQuiz1785300000000 implements MigrationInterface {
  name = 'CustomQuiz1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS is_custom          BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE
    `);

    // Listings filter on is_custom=FALSE; partial index keeps that free.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_quizzes_custom_owner
        ON quizzes (created_by_user_id, created_at DESC)
        WHERE is_custom = TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the generated rows too — without the flag they'd become
    // indistinguishable from real catalogue quizzes and start showing up
    // in listings.
    await queryRunner.query(`DELETE FROM quizzes WHERE is_custom = TRUE`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_quizzes_custom_owner`);
    await queryRunner.query(`
      ALTER TABLE quizzes
        DROP COLUMN IF EXISTS is_custom,
        DROP COLUMN IF EXISTS created_by_user_id
    `);
  }
}
