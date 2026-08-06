import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Point the Play Store link at the new package name.
 *
 * The app's applicationId changed from `com.bpscnotes.app` to
 * `com.bpscnotes.eduapp` before the first Play release. `android_store_url`
 * was seeded with the old id by PublicConfigDefaults1785400000000, and that
 * migration has already run — so editing the seed there would fix nothing on
 * an existing database. This updates the stored value instead.
 *
 * That URL is what the in-app update prompt opens, so leaving it stale would
 * send every user who taps "Update" to a Play page that does not exist.
 *
 * NOTE — not fixable from a migration: the `ANDROID_PACKAGE_NAME` environment
 * variable must be changed on the server too. Every Google Play Android
 * Publisher call reads it (purchase verification, catalog sync, external
 * transactions), and a mismatched package makes all of them fail.
 */
export class PackageNameEduapp1786000000000 implements MigrationInterface {
  name = 'PackageNameEduapp1786000000000';

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
