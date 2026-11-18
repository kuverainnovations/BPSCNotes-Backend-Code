import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A free read quota for peer answers.
 *
 * The reciprocity gate (23 July) only lets a student read other answers to
 * a question once they have reviewed one themselves. That is what produces
 * peer reviews at all — but it lands hardest on exactly the student who has
 * just written their first answer and wants to see how others approached
 * it, which is the moment they are most motivated.
 *
 * Rather than remove the gate and lose the review supply, the first N
 * questions a student opens are free. After that the gate applies as
 * before. N is a setting so it can be tuned without a deploy; 0 restores
 * the old all-or-nothing behaviour.
 *
 * A row is written the first time a question is opened on the quota, and
 * that question stays open afterwards without consuming another slot —
 * otherwise re-reading an answer you already paid a slot for would cost
 * another, and the count would depend on how often someone navigated back.
 */
export class AnswerFreeReads1786700000000 implements MigrationInterface {
  name = 'AnswerFreeReads1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS answer_free_reads (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id)            ON DELETE CASCADE,
        question_id UUID NOT NULL REFERENCES answer_questions(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, question_id)
      )
    `);

    // The lookup is always "how many has this user spent" and "has this
    // user spent one here", both user-first.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_answer_free_reads_user ON answer_free_reads(user_id)`
    );

    await queryRunner.query(`
      INSERT INTO app_settings (key, value)
      VALUES ('answer_free_reads', '3')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS answer_free_reads`);
    await queryRunner.query(`DELETE FROM app_settings WHERE key = 'answer_free_reads'`);
  }
}
