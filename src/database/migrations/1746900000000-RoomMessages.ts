import { MigrationInterface, QueryRunner } from 'typeorm';

// ─────────────────────────────────────────────────────────────
// MIGRATION: Room Chat Messages
// Adds room_messages table for in-room chat during study sessions
// ─────────────────────────────────────────────────────────────
export class RoomMessages1746900000000 implements MigrationInterface {
  name = 'RoomMessages1746900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS room_messages (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tier_key     VARCHAR(20) NOT NULL,      -- 'silver'|'gold'|'premium'|'diamond'
        sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_name  VARCHAR(100) NOT NULL,
        message      TEXT NOT NULL,
        -- message_type for future: 'text'|'emoji'|'achievement_share'
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Fetch last N messages fast per tier
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_room_messages_tier_time
        ON room_messages(tier_key, created_at DESC)
    `);

    // Auto-delete messages older than 24 hours via pg_cron or cleanup cron
    // (keep storage lean — chat is ephemeral, not a permanent record)
    await queryRunner.query(`
      COMMENT ON TABLE room_messages IS
        'Ephemeral in-room chat. Messages older than 24h are cleaned up by cron.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_room_messages_tier_time`);
    await queryRunner.query(`DROP TABLE IF EXISTS room_messages CASCADE`);
  }
}
