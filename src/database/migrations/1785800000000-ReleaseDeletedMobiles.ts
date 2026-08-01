import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a deleted account's mobile number be registered again.
 *
 * users.mobile is VARCHAR(15) UNIQUE. Account deletion is a soft delete, and the
 * admin path tries to free the number by renaming it to
 * `<mobile>_deleted_<epoch>` — roughly 39 characters. That does not fit in
 * VARCHAR(15), so the UPDATE fails and admin account deletion has never worked.
 *
 * Meanwhile the self-serve path soft-deletes without touching the number, so the
 * row keeps its mobile and the UNIQUE constraint keeps it reserved forever.
 * verify-otp filters on deleted_at and reports such a user as new; register did
 * not filter and rejected them as already registered. The account could neither
 * log in nor sign up again.
 *
 * Widening the column makes the rename fit. The backfill then releases numbers
 * still held by already-deleted rows, so people who were stuck in that state can
 * register again without support intervention.
 */
export class ReleaseDeletedMobiles1785800000000 implements MigrationInterface {
  name = 'ReleaseDeletedMobiles1785800000000';

  async up(qr: QueryRunner): Promise<void> {
    // 15 was only ever enough for the number itself.
    await qr.query(`ALTER TABLE users ALTER COLUMN mobile TYPE VARCHAR(64)`);

    // Release numbers still reserved by soft-deleted accounts. Restricted to
    // rows not already renamed, so re-running is harmless.
    await qr.query(`
      UPDATE users
         SET mobile = CONCAT(mobile, '_deleted_', EXTRACT(EPOCH FROM COALESCE(deleted_at, NOW()))::bigint::text)
       WHERE deleted_at IS NOT NULL
         AND mobile NOT LIKE '%\\_deleted\\_%'
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    // Restore the released numbers so the column can shrink back. Rows whose
    // original number was since taken by a live account are left renamed —
    // reverting those would violate the UNIQUE constraint.
    await qr.query(`
      UPDATE users u
         SET mobile = split_part(u.mobile, '_deleted_', 1)
       WHERE u.deleted_at IS NOT NULL
         AND u.mobile LIKE '%\\_deleted\\_%'
         AND NOT EXISTS (
           SELECT 1 FROM users o
            WHERE o.mobile = split_part(u.mobile, '_deleted_', 1)
              AND o.id <> u.id
         )
    `);
    await qr.query(`ALTER TABLE users ALTER COLUMN mobile TYPE VARCHAR(15)`);
  }
}
