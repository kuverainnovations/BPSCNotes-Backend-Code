import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudyMaterials1747000000000 implements MigrationInterface {
  name = 'StudyMaterials1747000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS study_materials (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(300) NOT NULL,
        description     TEXT,
        subject         VARCHAR(100) NOT NULL,
        material_type   VARCHAR(20)  NOT NULL CHECK (material_type IN ('pdf','pyq','book','video')),
        author          VARCHAR(200),
        tags            TEXT[]        DEFAULT '{}',
        file_key        VARCHAR(500),
        file_url        TEXT,
        file_size_bytes BIGINT       DEFAULT 0,
        page_count      INTEGER      DEFAULT 0,
        status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected')),
        rejection_reason TEXT,
        uploader_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        is_premium      BOOLEAN      NOT NULL DEFAULT FALSE,
        is_featured     BOOLEAN      NOT NULL DEFAULT FALSE,
        is_trending     BOOLEAN      NOT NULL DEFAULT FALSE,
        is_new          BOOLEAN      NOT NULL DEFAULT TRUE,
        download_count  INTEGER      NOT NULL DEFAULT 0,
        view_count      INTEGER      NOT NULL DEFAULT 0,
        rating_sum      NUMERIC(10,2) NOT NULL DEFAULT 0,
        rating_count    INTEGER      NOT NULL DEFAULT 0,
        approved_at     TIMESTAMPTZ,
        approved_by     UUID,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_sm_status   ON study_materials(status, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_sm_type     ON study_materials(material_type, status)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_sm_subject  ON study_materials(subject, status)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_sm_uploader ON study_materials(uploader_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_sm_trending ON study_materials(download_count DESC) WHERE status='approved'`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_bookmarks (
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        material_id UUID NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, material_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_mb_user ON material_bookmarks(user_id, created_at DESC)`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_downloads (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        material_id UUID NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_md_user ON material_downloads(user_id, downloaded_at DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS material_downloads CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS material_bookmarks CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS study_materials CASCADE`);
  }
}
