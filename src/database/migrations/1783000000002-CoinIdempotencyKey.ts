import { MigrationInterface, QueryRunner } from 'typeorm';

export class CoinIdempotencyKey1783000000002 implements MigrationInterface {
  name = 'CoinIdempotencyKey1783000000002';

  // TypeORM wraps migrations in a transaction by default.
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block in PostgreSQL,
  // so we opt out here. Both statements use IF NOT EXISTS / IF EXISTS guards,
  // making them safe to re-run without a wrapping transaction.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE coin_transactions
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)
    `);
    // CONCURRENTLY builds the index without holding a table lock.
    // This requires running outside any transaction block — see transaction = false above.
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_coin_tx_idempotency
        ON coin_transactions (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_coin_tx_idempotency`);
    await queryRunner.query(`
      ALTER TABLE coin_transactions DROP COLUMN IF EXISTS idempotency_key
    `);
  }
}
