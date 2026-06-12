import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace Material Chat + Support Escalation (Phase 5)
 *
 * Implements the buyer <-> uploader chat described in the spec:
 *  - Chat is only available AFTER a buyer purchases a material
 *  - Chat is scoped to that single material — not a global DM
 *  - One thread per (material, buyer) pair — the uploader can have
 *    many threads (one per buyer) for the same material
 *  - "Report / Escalate to Support" creates a support_escalations
 *    row visible to admins (refunds, disputes, content issues,
 *    seller misconduct — NOT academic doubts)
 *
 * New tables:
 *  - material_chats          — one row per (material_id, buyer_id)
 *  - material_chat_messages   — messages within a thread
 *  - support_escalations      — escalation tickets raised from a chat
 */
export class MarketplaceChatEscalation1780400000000 implements MigrationInterface {
  name = 'MarketplaceChatEscalation1780400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── material_chats ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_chats (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id  UUID NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        buyer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploader_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status       VARCHAR(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','escalated','closed')),
        last_message_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(material_id, buyer_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mc_buyer ON material_chats(buyer_id, last_message_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mc_uploader ON material_chats(uploader_id, last_message_at DESC)
    `);

    // ── material_chat_messages ──────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS material_chat_messages (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id     UUID NOT NULL REFERENCES material_chats(id) ON DELETE CASCADE,
        sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message     TEXT NOT NULL,
        is_read     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_mcm_chat ON material_chat_messages(chat_id, created_at ASC)
    `);

    // ── support_escalations ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS support_escalations (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id      UUID NOT NULL REFERENCES material_chats(id) ON DELETE CASCADE,
        material_id  UUID NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        buyer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploader_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category     VARCHAR(30) NOT NULL DEFAULT 'other'
                     CHECK (category IN ('refund','dispute','content','seller_misconduct','other')),
        reason       TEXT NOT NULL,
        status       VARCHAR(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','resolved')),
        resolution_note TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at  TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_se_status ON support_escalations(status, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS support_escalations CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS material_chat_messages CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS material_chats CASCADE`);
  }
}
