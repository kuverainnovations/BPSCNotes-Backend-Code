import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Social channel links, surfaced in the app next to Logout.
 *
 * Seeded empty on purpose. The app hides any channel whose value is blank, so
 * shipping this migration cannot put a dead link in front of a user — the icons
 * appear only once an admin fills them in under Admin → Settings → Social Links.
 *
 * Email is not here: the app reuses the existing support_email key.
 *
 * ON CONFLICT DO NOTHING so re-running never clobbers what an admin has set.
 */
export class SocialLinks1785600000000 implements MigrationInterface {
  name = 'SocialLinks1785600000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      INSERT INTO app_settings (key, value, description) VALUES
        ('social_instagram', '', 'Instagram profile URL — blank hides the icon in the app'),
        ('social_telegram',  '', 'Telegram channel URL — blank hides the icon in the app'),
        ('social_facebook',  '', 'Facebook page URL — blank hides the icon in the app'),
        ('social_whatsapp',  '', 'WhatsApp channel or wa.me URL — blank hides the icon in the app')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DELETE FROM app_settings
      WHERE key IN ('social_instagram','social_telegram','social_facebook','social_whatsapp')
    `);
  }
}
