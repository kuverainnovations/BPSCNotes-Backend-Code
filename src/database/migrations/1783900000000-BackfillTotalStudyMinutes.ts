import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QA 09-Jul issues 11/13/14 — "0h Studied" tiles vs "6/4h" tier progress.
 *
 * users.total_study_minutes is maintained INCREMENTALLY by two writers
 * (study-room heartbeat/endSession credits, and course completeLesson
 * watch-time deltas). Sessions/lessons recorded before those writers
 * existed were never folded in, so long-time users show 0h in every
 * surface that reads the column (rooms hub tiles, leaderboard study
 * time) while surfaces that aggregate study_sessions directly (tier
 * progress checklist) show the real hours.
 *
 * One-time repair: recompute the column from the same two sources the
 * incremental writers use. Safe to re-run — it recomputes, not adds.
 */
export class BackfillTotalStudyMinutes1783900000000 implements MigrationInterface {
  name = 'BackfillTotalStudyMinutes1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE users u SET total_study_minutes =
        COALESCE((SELECT SUM(ss.active_minutes)::int
                    FROM study_sessions ss WHERE ss.user_id = u.id), 0)
      + COALESCE((SELECT CEIL(SUM(lp.watch_time_secs)::numeric / 60)::int
                    FROM lesson_progress lp WHERE lp.user_id = u.id), 0)
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Irreversible data repair — the previous (undercounted) values are
    // not recoverable, and there is nothing meaningful to restore.
  }
}
