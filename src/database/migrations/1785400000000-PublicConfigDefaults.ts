import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds the app-control and update-gate keys into app_settings.
 *
 * These keys were only ever defined in src/database/seeds/*, which was never
 * run against production. GET /app-config therefore returned no app_version,
 * min_app_version or force_update at all, and AppConfigRepository on Android
 * fell back to its own "1.0.0" defaults — so isVersionLower() was always false
 * and UpdateGateDialog returned early on every launch. The update prompt, the
 * force-update kill-switch, the maintenance screen and the new-registrations
 * switch were all inert for every user since launch.
 *
 * ON CONFLICT DO NOTHING: if an admin has already set a value through the
 * Settings page, theirs wins — this only fills in what is missing.
 */
export class PublicConfigDefaults1785400000000 implements MigrationInterface {
  name = 'PublicConfigDefaults1785400000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      INSERT INTO app_settings (key, value, description) VALUES
        ('maintenance_mode',   'false', 'Show the maintenance screen to all users'),
        ('new_registrations',  'true',  'Allow new user registrations'),
        ('study_rooms_enabled','true',  'Allow students to create/join study rooms'),
        ('support_email',      'admin@bpscnotes.in', 'Support address shown in the app'),
        ('force_update',       'false', 'Kill-switch: hard-block every version until users update'),
        ('app_version',        '1.0.4', 'Latest version on the Play Store — users below this get a dismissible nudge'),
        ('min_app_version',    '1.0.0', 'Hard floor — users below this are blocked until they update'),
        ('android_store_url',  'https://play.google.com/store/apps/details?id=com.bpscnotes.app', 'Play Store listing opened by the update prompt')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DELETE FROM app_settings WHERE key IN (
        'maintenance_mode','new_registrations','study_rooms_enabled','support_email',
        'force_update','app_version','min_app_version','android_store_url'
      )
    `);
  }
}
