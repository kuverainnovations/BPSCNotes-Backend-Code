import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Districts lookup table — powers the District dropdown shown during
 * profile creation (and anywhere else a district list is needed).
 *
 * Previously this was a hardcoded list of 38 Bihar districts baked
 * into the Android app (BIHAR_DISTRICTS in RegisterScreen.kt). Moving
 * it to the database lets admins add/rename/reorder/deactivate
 * districts (e.g. when covering additional states) without an app
 * release.
 */
export class CreateDistricts1780800000000 implements MigrationInterface {
  name = 'CreateDistricts1780800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS districts (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        VARCHAR(100) NOT NULL,
        state       VARCHAR(100) NOT NULL DEFAULT 'Bihar',
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order  INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (name, state)
      );

      CREATE INDEX IF NOT EXISTS idx_districts_active ON districts(is_active);
    `);

    // Seed with the existing 38 Bihar districts (alphabetical, matching
    // the previous hardcoded Android list) so behaviour is unchanged
    // until an admin edits the list.
    const districts = [
      'Araria', 'Arwal', 'Aurangabad', 'Banka', 'Begusarai',
      'Bhabua', 'Bhagalpur', 'Buxar', 'Darbhanga', 'East Champaran',
      'Gaya', 'Gopalganj', 'Jamui', 'Jehanabad', 'Kaimur',
      'Katihar', 'Khagaria', 'Kishanganj', 'Lakhisarai', 'Madhepura',
      'Madhubani', 'Munger', 'Muzaffarpur', 'Nalanda', 'Nawada',
      'Patna', 'Purnia', 'Rohtas', 'Saharsa', 'Samastipur',
      'Saran', 'Sheikhpura', 'Sheohar', 'Sitamarhi', 'Siwan',
      'Supaul', 'Vaishali', 'West Champaran',
    ];

    for (let i = 0; i < districts.length; i++) {
      await queryRunner.query(
        `INSERT INTO districts (name, state, sort_order) VALUES ($1, 'Bihar', $2)
         ON CONFLICT (name, state) DO NOTHING`,
        [districts[i], i],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS districts`);
  }
}
