import { MigrationInterface, QueryRunner } from 'typeorm';

// Backs Rooms spec section 9 (Room Activity Feed). Deliberately denormalizes
// user_name onto each row instead of joining users on every read — this is
// read constantly (every room view) and a feed entry is a point-in-time
// fact ("Rahul joined the room at 10:03") that shouldn't change retroactively
// if the user later renames themselves, so the denormalization is correct
// here, not just a perf shortcut.
//
// event_type is intentionally a free-text column, not a Postgres ENUM —
// new feed event types (e.g. a future "goal_completed") shouldn't need a
// migration to add. Validity is enforced in the service layer.
export class RoomActivityFeed1782200000000 implements MigrationInterface {
  name = 'RoomActivityFeed1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS room_activity_feed (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        room_tier_id  UUID NOT NULL REFERENCES room_tiers(id) ON DELETE CASCADE,
        user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
        user_name     TEXT NOT NULL,
        event_type    TEXT NOT NULL,   -- 'joined' | 'streak_milestone' | 'promoted' | 'demoted'
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Feed reads are always "latest N for this room" — this is the only
    // access pattern, so a single composite index covers it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_room_activity_feed_room_created
        ON room_activity_feed (room_tier_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS room_activity_feed`);
  }
}
