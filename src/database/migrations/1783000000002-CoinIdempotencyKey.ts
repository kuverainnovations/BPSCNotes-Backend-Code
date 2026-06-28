import { MigrationInterface, QueryRunner } from 'typeorm';

export class CoinIdempotencyKey1783000000002 implements MigrationInterface {
  name = 'CoinIdempotencyKey1783000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE coin_transactions
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)
    `);
    // Partial unique index — only enforces uniqueness when the key is set.
    // CONCURRENTLY avoids locking the table on a live deployment.
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_coin_tx_idempotency
        ON coin_transactions (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_coin_tx_idempotency`);
    await queryRunner.query(`
      ALTER TABLE coin_transactions DROP COLUMN IF EXISTS idempotency_key
    `);
  }
}
