
import { MigrationInterface, QueryRunner } from 'typeorm';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/database/migrations/1747400000000-CourseDetailFields.ts
//
// Adds missing columns that the CourseDetail static screen uses
// but the DB/API does not yet provide:
//
//   what_you_learn      TEXT[]   — bullet list of learning outcomes
//   has_certificate     BOOLEAN  — whether course gives a certificate
//   instructor_students VARCHAR  — display string e.g. "18K+" for instructor profile
//   instructor_courses  INTEGER  — number of courses the instructor teaches
//
// NOTE: instructor_bio, description, language, rating, review_count
//       already exist in the courses table. ✅
// ════════════════════════════════════════════════════════════
export class CourseDetailFields1747400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE courses
        ADD COLUMN IF NOT EXISTS what_you_learn      TEXT[]        DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS has_certificate     BOOLEAN       NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS instructor_students VARCHAR(20)   DEFAULT '0',
        ADD COLUMN IF NOT EXISTS instructor_courses  INTEGER       NOT NULL DEFAULT 1
    `);

    // Backfill instructor_courses from existing data
    // Count how many published courses share the same instructor name
    await queryRunner.query(`
      UPDATE courses c
      SET instructor_courses = sub.cnt
      FROM (
        SELECT instructor, COUNT(*)::int AS cnt
        FROM courses
        WHERE status = 'published' AND instructor IS NOT NULL
        GROUP BY instructor
      ) sub
      WHERE c.instructor = sub.instructor
        AND c.instructor IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE courses
        DROP COLUMN IF EXISTS what_you_learn,
        DROP COLUMN IF EXISTS has_certificate,
        DROP COLUMN IF EXISTS instructor_students,
        DROP COLUMN IF EXISTS instructor_courses
    `);
  }
}
