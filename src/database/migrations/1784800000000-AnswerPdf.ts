import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Answer Writing — PDF answer submission
 * ═══════════════════════════════════════
 * A third way to submit a Mains answer (alongside typed text and photos):
 * a single PDF. Stored like the answer photos — on disk under
 * uploads/answers/<year>/<month>/ — with just the public URL kept here.
 * Peer/expert reviewers open it in the review screen.
 */
export class AnswerPdf1784800000000 implements MigrationInterface {
  name = 'AnswerPdf1784800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_submissions ADD COLUMN IF NOT EXISTS answer_pdf TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_submissions DROP COLUMN IF EXISTS answer_pdf
    `);
  }
}
