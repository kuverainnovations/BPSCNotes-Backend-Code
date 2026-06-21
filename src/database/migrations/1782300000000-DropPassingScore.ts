import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the Passing Score concept from the system entirely.
 *
 * quizzes.passing_score — the admin-set pass threshold (%) is no longer
 * a business requirement; quizzes are no longer gated by a score
 * threshold anywhere in Admin, API, or Android.
 *
 * quiz_attempts.is_passed — was purely derived from
 * `score >= quizzes.passing_score`. With the threshold gone this column
 * can no longer be computed and is removed alongside it. Coin-reward
 * gating (previously "first PASSING attempt") now uses "first COMPLETED
 * attempt" instead — see QuizzesService.submit() — so no replacement
 * column is needed.
 *
 * SAFE TO RUN: idempotent IF EXISTS / IF NOT EXISTS on both directions.
 */
export class DropPassingScore1782300000000 implements MigrationInterface {
  name = 'DropPassingScore1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        DROP COLUMN IF EXISTS passing_score
    `);
    await queryRunner.query(`
      ALTER TABLE quiz_attempts
        DROP COLUMN IF EXISTS is_passed
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS passing_score INTEGER NOT NULL DEFAULT 60
    `);
    await queryRunner.query(`
      ALTER TABLE quiz_attempts
        ADD COLUMN IF NOT EXISTS is_passed BOOLEAN NOT NULL DEFAULT FALSE
    `);
  }
}
