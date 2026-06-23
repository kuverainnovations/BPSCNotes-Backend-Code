import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Job Module Restructure
 * ══════════════════════
 * 1. experience_required  — new col (Freshers / 0-1 Yrs / 1-3 Yrs / 3-5 Yrs / 5+ Yrs)
 * 2. advert_pdf_key       — file key for uploaded advertisement PDF (served via /uploads/)
 * 3. advert_pdf_url       — public URL for the advertisement PDF
 * 4. Location hierarchy   — state / district / city / is_remote cols replace free-text `location`
 *    (location col kept for backward-compat, now computed as display string)
 * 5. is_featured / is_new — add real columns (currently COALESCE'd to FALSE in SELECT)
 * 6. sort index           — featured first, then newest, then last_date
 * 7. job_alert_prefs      — stores per-user category subscriptions for targeted push
 */
export class JobModuleRestructure1782700000000 implements MigrationInterface {
  name = 'JobModuleRestructure1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Experience field ───────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS experience_required VARCHAR(50) DEFAULT 'Any'
    `);

    // ── 2. Advertisement PDF ──────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS advert_pdf_key TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS advert_pdf_url TEXT DEFAULT NULL
    `);

    // ── 3. Location hierarchy ─────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS job_state    VARCHAR(100) DEFAULT 'Bihar',
        ADD COLUMN IF NOT EXISTS job_district VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS job_city     VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS is_remote    BOOLEAN      NOT NULL DEFAULT FALSE
    `);

    // ── 4. Real is_featured / is_new columns ─────────────────
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_new      BOOLEAN NOT NULL DEFAULT TRUE
    `);

    // ── 5. Ensure legacy cols exist (idempotent) ──────────────
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS location          TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS salary_range      TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS brief_description TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS pdf_url           TEXT DEFAULT ''
    `);

    // ── 6. Sort index: featured → newest ─────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_sort
        ON job_vacancies (is_featured DESC, is_new DESC, created_at DESC)
        WHERE status = 'active'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_category
        ON job_vacancies (category, status, created_at DESC)
    `);

    // ── 7. Job alert preferences per user ────────────────────
    // Stores which FCM topic categories each user subscribed to.
    // topic_key matches the category value: 'Central Govt', 'Bihar Govt', 'Private', etc.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS job_alert_prefs (
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic_key VARCHAR(100) NOT NULL,
        PRIMARY KEY (user_id, topic_key)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_jap_topic ON job_alert_prefs(topic_key)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS job_alert_prefs`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_jobs_category`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_jobs_sort`);
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        DROP COLUMN IF EXISTS is_featured,
        DROP COLUMN IF EXISTS is_new,
        DROP COLUMN IF EXISTS is_remote,
        DROP COLUMN IF EXISTS job_city,
        DROP COLUMN IF EXISTS job_district,
        DROP COLUMN IF EXISTS job_state,
        DROP COLUMN IF EXISTS advert_pdf_url,
        DROP COLUMN IF EXISTS advert_pdf_key,
        DROP COLUMN IF EXISTS experience_required
    `);
  }
}
