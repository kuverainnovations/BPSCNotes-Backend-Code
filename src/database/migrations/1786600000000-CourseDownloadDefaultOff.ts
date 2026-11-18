import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Course PDFs default to NOT downloadable.
 *
 * 1786300000000 added courses.allow_download with DEFAULT TRUE, matching
 * study_materials. That was harmless while the app offered no way to
 * download a lesson PDF — the flag controlled nothing.
 *
 * The app now has that download, so the default decides whether every paid
 * course in the catalogue becomes saveable (and forwardable) the moment the
 * build ships. It should not. Courses are sold individually; the admin opts
 * a course in when they want it shared, which is what the client asked for
 * when they promised a student the feature for one free compilation.
 *
 * Existing rows are reset rather than preserved: the toggle has never had
 * any effect, so no value in the table reflects a real decision.
 *
 * study_materials is deliberately untouched — its download has always
 * existed and users rely on it.
 */
export class CourseDownloadDefaultOff1786600000000 implements MigrationInterface {
  name = 'CourseDownloadDefaultOff1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE courses ALTER COLUMN allow_download SET DEFAULT FALSE`);
    await queryRunner.query(`UPDATE courses SET allow_download = FALSE WHERE allow_download IS DISTINCT FROM FALSE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE courses ALTER COLUMN allow_download SET DEFAULT TRUE`);
    // Intentionally not restoring per-row values: the previous state was a
    // blanket TRUE that never meant anything, and re-enabling downloads for
    // the whole catalogue on a rollback would be worse than leaving them off.
  }
}
