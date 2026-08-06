import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User-generated content moderation — reports, blocks, and hiding.
 * ═══════════════════════════════════════════════════════════════
 * Google Play's User Generated Content policy requires any app where users
 * can see each other's content to ship BOTH an in-app way to report
 * objectionable content/users AND an in-app way to block a user. The app has
 * three such surfaces and had neither:
 *
 *   - tier room chat        (room_messages, via the websocket gateway)
 *   - answer peer review    (answer_peer_reviews — users read each other's
 *                            written answers and the reviews left on them)
 *   - marketplace materials (study_materials — users upload PDFs others buy)
 *
 * `content_reports` is deliberately polymorphic rather than one table per
 * surface: the admin moderation queue wants a single chronological list, and
 * the report payload is identical whatever was reported. `content_id` is NOT
 * NULL even for whole-user reports — those store the reported user's id in it
 * — so a single UNIQUE key can stop one reporter spamming the same target.
 *
 * `hidden_at` on the two in-house content tables is what makes the queue
 * actionable. Hiding is reversible and keeps the row, because a report can be
 * wrong and because the evidence has to survive the moderation decision.
 * study_materials already has its own is_active flag, so it needs no column.
 */
export class UgcModeration1785900000000 implements MigrationInterface {
  name = 'UgcModeration1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Reports ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS content_reports (
        id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- room_message | peer_review | answer | study_material | user
        content_type     VARCHAR(32)  NOT NULL,
        -- the reported row's id; for content_type='user' this is the user's id
        content_id       UUID         NOT NULL,
        -- author of the reported content, so the queue can act on a person
        -- without re-resolving it per content type. SET NULL keeps the report
        -- readable after an account is hard-deleted.
        reported_user_id UUID         REFERENCES users(id) ON DELETE SET NULL,
        reason           VARCHAR(40)  NOT NULL,
        details          TEXT,
        -- pending | actioned | dismissed
        status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
        action_taken     VARCHAR(40),
        reviewed_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        -- one report per person per item; re-reporting updates instead
        UNIQUE (reporter_id, content_type, content_id)
      )
    `);
    // The moderation queue's only read pattern: oldest pending first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_content_reports_queue
        ON content_reports(status, created_at DESC)
    `);
    // "How many open reports against this user?" — drives repeat-offender
    // triage in the admin list.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_content_reports_target
        ON content_reports(reported_user_id, status)
    `);

    // ── Blocks ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (blocker_id, blocked_id),
        CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id)
      )
    `);
    // Every UGC read filters "…AND author NOT IN (my blocks)", so the lookup
    // is always by blocker.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker
        ON user_blocks(blocker_id)
    `);

    // ── Moderator hide ───────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE room_messages
        ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE answer_peer_reviews
        ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE answer_peer_reviews DROP COLUMN IF EXISTS hidden_at`);
    await queryRunner.query(`ALTER TABLE room_messages      DROP COLUMN IF EXISTS hidden_at`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_user_blocks_blocker`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_blocks`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_content_reports_target`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_content_reports_queue`);
    await queryRunner.query(`DROP TABLE IF EXISTS content_reports`);
  }
}
