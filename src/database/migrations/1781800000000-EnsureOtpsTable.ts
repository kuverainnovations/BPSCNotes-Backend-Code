import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `otps` table if it doesn't already exist.
 *
 * `otps` was added to 1700000000000-InitialSchema.ts (CREATE TABLE otps +
 * idx_otps_mobile), but on databases where that migration had already run
 * *before* `otps` was added to the file, TypeORM marks it complete and
 * never re-runs it - so `otps` never got created there. This surfaces as
 * `relation "otps" does not exist` (500) on POST /auth/send-otp, blocking
 * the entire OTP-based login/verification flow.
 *
 * IF NOT EXISTS makes this a no-op on any database where InitialSchema's
 * current content (with `otps` included) already ran successfully.
 *
 * Schema matches InitialSchema.ts's `otps` definition exactly, since
 * OtpService (auth.module.ts) queries: id, mobile, otp_hash, expires_at,
 * is_used, attempts, created_at.
 */
export class EnsureOtpsTable1781800000000 implements MigrationInterface {
  name = 'EnsureOtpsTable1781800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS otps (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        mobile      VARCHAR(15) NOT NULL,
        otp_hash    VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        is_used     BOOLEAN NOT NULL DEFAULT FALSE,
        attempts    INTEGER NOT NULL DEFAULT 0,
        ip_address  INET,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_otps_mobile ON otps(mobile, is_used);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS otps`);
  }
}
