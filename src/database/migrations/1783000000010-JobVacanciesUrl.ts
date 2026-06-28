import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobVacanciesUrl1783000000010 implements MigrationInterface {
  name = 'JobVacanciesUrl1783000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS notification_url TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE job_vacancies
        DROP COLUMN IF EXISTS notification_url
    `);
  }
}
