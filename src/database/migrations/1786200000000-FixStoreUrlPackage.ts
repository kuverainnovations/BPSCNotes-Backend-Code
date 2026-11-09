import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Actually repoint the Play Store link at the new package name.
 *
 * PackageNameEduapp1786000000000 was written to do this, but a later
 * repo-wide find-and-replace rewrote BOTH of its arguments, leaving:
 *
 *     REPLACE(value, 'com.bpscnotes.eduapp', 'com.bpscnotes.eduapp')
 *
 * — a no-op. The same sweep also rewrote the original seed in
 * PublicConfigDefaults1785400000000, which is why the repo now looks
 * correct while the database is not: that seed migration had already run,
 * so any existing database still holds the ORIGINAL value,
 * `com.bpscnotes.app` (see commit f30f73d).
 *
 * The practical effect is that the in-app update prompt sends users to a
 * Play listing that does not exist. This runs the replacement that was
 * intended, and is safe to apply whether or not 1786000000000 ever ran.
 *
 * NOTE — still not fixable from a migration: the `ANDROID_PACKAGE_NAME`
 * environment variable must be updated on the server too. Every Google Play
 * Android Publisher call reads it (purchase verification, catalog sync,
 * external transactions), and a mismatched package fails all of them.
 */
export class FixStoreUrlPackage1786200000000 implements MigrationInterface {
  name = 'FixStoreUrlPackage1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rewrites the id in place rather than assuming the whole URL, so a
    // manually edited link (extra query params, a different locale) survives.
    await queryRunner.query(`
      UPDATE app_settings
         SET value = REPLACE(value, 'com.bpscnotes.app', 'com.bpscnotes.eduapp')
       WHERE key = 'android_store_url'
         AND value LIKE '%com.bpscnotes.app%'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE app_settings
         SET value = REPLACE(value, 'com.bpscnotes.eduapp', 'com.bpscnotes.app')
       WHERE key = 'android_store_url'
         AND value LIKE '%com.bpscnotes.eduapp%'
    `);
  }
}
