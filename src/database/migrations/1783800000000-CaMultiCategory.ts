import { MigrationInterface, QueryRunner } from 'typeorm';

// QA 05-Jul issue 19 — a current-affairs article often belongs to more than
// one category (e.g. "Technology" + "Polity"). Adds a categories TEXT[]
// alongside the legacy single `category` column; `category` stays populated
// (first element) so old app builds and existing filters keep working.
// SAFE: idempotent, backfills from the legacy column.
export class CaMultiCategory1783800000000 implements MigrationInterface {
  name = 'CaMultiCategory1783800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE current_affairs
        ADD COLUMN IF NOT EXISTS categories TEXT[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      UPDATE current_affairs
         SET categories = ARRAY[category]
       WHERE (categories IS NULL OR categories = '{}')
         AND category IS NOT NULL AND category <> ''
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ca_categories
        ON current_affairs USING GIN (categories)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_ca_categories`);
    await queryRunner.query(`
      ALTER TABLE current_affairs
        DROP COLUMN IF EXISTS categories
    `);
  }
}
