import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the `otps` table.
 *
 * It stored hashed OTPs for the MSG91 SMS OTP flow (send-otp /
 * verify-otp / forgot-mpin / reset-mpin). That flow has been replaced
 * by Firebase Phone Authentication — the Android app verifies the
 * phone number directly with Firebase (which sends/checks the SMS
 * OTP itself), and the backend only verifies the resulting Firebase
 * ID token. No server-side OTP storage is needed anymore.
 */
export class DropOtpsTable1781500000000 implements MigrationInterface {
  name = 'DropOtpsTable1781500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS otps`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS otps (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        mobile      VARCHAR(15) NOT NULL,
        otp_hash    VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        is_used     BOOLEAN NOT NULL DEFAULT FALSE,
        attempts    INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
}
