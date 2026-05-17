
import { MigrationInterface, QueryRunner } from 'typeorm';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/database/migrations/1747300000000-EnrollmentMissingFields.ts
//
// MISSING FIELDS:
//   description     — courses table already has it, just not in list query
//   completedLessons — user_enrollments.completed_lessons EXISTS ✅
//   totalMinutes    — user_enrollments missing total_minutes column
//   studiedMinutes  — user_enrollments missing studied_minutes column
//   lastStudied     — user_enrollments missing last_studied_at column
//
// This migration adds the 3 missing columns to user_enrollments.
// The getCourses query is fixed in courses.module.ts (separate file).
// ════════════════════════════════════════════════════════════

export class EnrollmentMissingFields1747300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {

    // ── Add missing columns to user_enrollments ───────────────
    await queryRunner.query(`
      ALTER TABLE user_enrollments
        ADD COLUMN IF NOT EXISTS total_minutes    INTEGER      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS studied_minutes  INTEGER      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_studied_at  TIMESTAMPTZ
    `);

    // ── Backfill studied_minutes from lesson_progress.watch_time_secs ─
    // lesson_progress.watch_time_secs is per-lesson in seconds → sum and convert to minutes
    await queryRunner.query(`
      UPDATE user_enrollments ue
      SET
        studied_minutes = COALESCE((
          SELECT ROUND(SUM(lp.watch_time_secs) / 60.0)::int
          FROM lesson_progress lp
          JOIN course_lessons cl ON lp.lesson_id = cl.id
          WHERE cl.course_id = ue.course_id AND lp.user_id = ue.user_id
        ), 0),
        last_studied_at = (
          SELECT MAX(lp.completed_at)
          FROM lesson_progress lp
          JOIN course_lessons cl ON lp.lesson_id = cl.id
          WHERE cl.course_id = ue.course_id AND lp.user_id = ue.user_id
          AND lp.completed_at IS NOT NULL
        )
      WHERE 1=1
    `);

    // ── Backfill total_minutes from course total_hours ────────
    await queryRunner.query(`
      UPDATE user_enrollments ue
      SET total_minutes = COALESCE(
        (SELECT (c.total_hours * 60)::int FROM courses c WHERE c.id = ue.course_id),
        0
      )
      WHERE total_minutes = 0
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE user_enrollments
        DROP COLUMN IF EXISTS total_minutes,
        DROP COLUMN IF EXISTS studied_minutes,
        DROP COLUMN IF EXISTS last_studied_at
    `);
  }
}
