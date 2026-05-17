
import { MigrationInterface, QueryRunner } from 'typeorm';

export class SubjectsTable1747200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {

    // subjects table — drives filter categories on Android + admin dropdowns
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS subjects (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name       VARCHAR(100) NOT NULL UNIQUE,
        emoji      VARCHAR(10)  NOT NULL DEFAULT '📚',
        color_hex  VARCHAR(7)   NOT NULL DEFAULT '#1565C0',
        type       VARCHAR(50)  NOT NULL DEFAULT 'all',
        sort_order INT          NOT NULL DEFAULT 0,
        is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // affair_categories table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS affair_categories (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name       VARCHAR(100) NOT NULL UNIQUE,
        emoji      VARCHAR(10)  NOT NULL DEFAULT '📰',
        sort_order INT          NOT NULL DEFAULT 0,
        is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    const subjects: [string, string, string, string, number][] = [
      ['Polity',          '⚖️',  '#1565C0', 'all', 1],
      ['History',         '📜',  '#6D4C41', 'all', 2],
      ['Geography',       '🌍',  '#2E7D32', 'all', 3],
      ['Economy',         '📈',  '#E65100', 'all', 4],
      ['Bihar GK',        '🏔️',  '#6A1B9A', 'all', 5],
      ['Science & Tech',  '🔬',  '#00838F', 'all', 6],
      ['General Studies', '📚',  '#37474F', 'all', 7],
      ['Environment',     '🌿',  '#558B2F', 'all', 8],
      ['Maths',           '🔢',  '#AD1457', 'all', 9],
      ['English',         '🔤',  '#1A237E', 'all', 10],
    ];

    for (const [name, emoji, color_hex, type, sort_order] of subjects) {
      await queryRunner.query(
        `INSERT INTO subjects (name, emoji, color_hex, type, sort_order)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [name, emoji, color_hex, type, sort_order]
      );
    }

    const cats: [string, string, number][] = [
      ['General','📰',1],['Economy','📈',2],['Polity','⚖️',3],
      ['Science & Tech','🔬',4],['Environment','🌿',5],['International','🌐',6],
      ['Bihar','🏔️',7],['Sports','🏆',8],['Defence','🛡️',9],['Awards','🏅',10],
    ];
    for (const [name, emoji, sort_order] of cats) {
      await queryRunner.query(
        `INSERT INTO affair_categories (name, emoji, sort_order)
         VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
        [name, emoji, sort_order]
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS subjects');
    await queryRunner.query('DROP TABLE IF EXISTS affair_categories');
  }
}
