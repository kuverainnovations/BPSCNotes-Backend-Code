import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fills in the real social URLs. 1785600000000 created these keys empty; this
 * sets the ones the brand actually has.
 *
 * Only overwrites a key that is still blank (`WHERE app_settings.value = ''`).
 * If an admin has already typed something into Admin → Settings → Social Links,
 * theirs wins — a migration must never clobber a live edit.
 *
 * Two URLs are normalised from what was supplied:
 *   - Instagram had a trailing '?' from a copy-paste; harmless in a browser but
 *     it is not part of the address.
 *   - Facebook was given as m.facebook.com, the mobile *web* site. www.facebook.com
 *     is what the Facebook Android app registers an intent filter for, so the
 *     www form opens the app when installed and still falls back to the browser.
 *
 * social_whatsapp is intentionally left blank — no WhatsApp link was supplied,
 * and the app hides any channel whose value is empty.
 */
export class SocialLinkValues1785700000000 implements MigrationInterface {
  name = 'SocialLinkValues1785700000000';

  private static readonly LINKS: Array<[string, string]> = [
    ['social_telegram',  'https://t.me/BPSCnotes'],
    ['social_instagram', 'https://www.instagram.com/bpscnotes'],
    ['social_facebook',  'https://www.facebook.com/BPSCnotes'],
  ];

  async up(qr: QueryRunner): Promise<void> {
    for (const [key, value] of SocialLinkValues1785700000000.LINKS) {
      await qr.query(
        `INSERT INTO app_settings (key, value, description)
         VALUES ($1, $2, 'Social channel URL — blank hides the icon in the app')
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value
           WHERE app_settings.value = '' OR app_settings.value IS NULL`,
        [key, value]
      );
    }
  }

  async down(qr: QueryRunner): Promise<void> {
    // Back to blank, which is the "not configured" state the app hides.
    await qr.query(
      `UPDATE app_settings SET value = ''
       WHERE key IN ('social_telegram','social_instagram','social_facebook')`
    );
  }
}
