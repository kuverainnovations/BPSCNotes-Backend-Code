import { MigrationInterface, QueryRunner } from 'typeorm';

// QA 04-Jul issues 6 & 7 — daily-target carry-forward had no lineage link:
// the copy inserted for "today" was matched back to its source only by TITLE.
// Editing the copy's title made the source unmatchable, so getTargets()
// re-carried the source → duplicate target. Completing the copy also never
// completed the source, so completed targets re-appeared the next morning.
// carried_from_id ties every carried copy to its original row so
// edit/complete/delete can act on the whole chain by id, not by title.
// SAFE: idempotent (IF NOT EXISTS), nullable column — legacy rows keep NULL
// and the code falls back to the old title match for them.
export class TargetCarryLineage1783600000000 implements MigrationInterface {
  name = 'TargetCarryLineage1783600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE daily_targets
        ADD COLUMN IF NOT EXISTS carried_from_id UUID
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_targets_carried_from
        ON daily_targets(carried_from_id)
        WHERE carried_from_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_daily_targets_carried_from`);
    await queryRunner.query(`
      ALTER TABLE daily_targets
        DROP COLUMN IF EXISTS carried_from_id
    `);
  }
}
