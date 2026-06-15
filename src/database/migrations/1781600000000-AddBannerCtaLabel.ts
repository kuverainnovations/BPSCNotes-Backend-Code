import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FIX: the admin "Banners & Offers" form has a "CTA Label" field (e.g.
 * "Enroll Now"), and reads/writes `cta_label` on every save — but the
 * `banners` table (see 1700000000000-InitialSchema.ts) never had a
 * cta_label column at all. So every save silently dropped this field,
 * the admin list's CTA-label badge never rendered, and Android had no
 * way to receive a custom CTA label per banner (it hardcoded "Open →"/
 * "View →").
 *
 * Adds `cta_label VARCHAR(50)`, nullable — banners without a custom
 * label fall back to the existing hardcoded Android default.
 */
export class AddBannerCtaLabel1781600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE banners ADD COLUMN cta_label VARCHAR(50)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE banners DROP COLUMN cta_label`);
  }
}
//Test