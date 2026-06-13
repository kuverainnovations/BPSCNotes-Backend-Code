import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionRoomTier1780600000000 implements MigrationInterface {
  name = 'AddSessionRoomTier1780600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // tier_id = the user's reward tier (current_tier_id at session start) —
    // determines coin/XP multipliers. Unchanged.
    //
    // room_tier_id = the tier ROOM the user actually joined for this
    // session (may be a lower, already-unlocked tier). Drives presence
    // counts ("X studying" on tier cards) and the session's display name
    // (PIP overlay, StudyFocus header). Falls back to tier_id when NULL
    // for existing rows / sessions started without an explicit room.
    await queryRunner.query(`
      ALTER TABLE study_sessions
        ADD COLUMN IF NOT EXISTS room_tier_id UUID REFERENCES room_tiers(id) ON DELETE SET NULL
    `);

    // Backfill existing rows so active-session queries can rely on
    // COALESCE(room_tier_id, tier_id) without special-casing NULLs.
    await queryRunner.query(`
      UPDATE study_sessions SET room_tier_id = tier_id WHERE room_tier_id IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_sessions
        DROP COLUMN IF EXISTS room_tier_id
    `);
  }
}
