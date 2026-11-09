import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give Answer Writing its own admin permission.
 *
 * Every endpoint on AdminAnswerWritingController used to require 'quizzes',
 * so granting a sub-admin access to answer submissions also handed them the
 * entire quiz bank. The controller now requires 'answer-writing' instead.
 *
 * That swap would silently revoke access for anyone already moderating
 * answers, so this backfills: every admin who can currently reach the module
 * (i.e. holds 'quizzes') keeps reaching it. Holders of 'all' are untouched —
 * PermissionGuard short-circuits on that.
 */
export class AnswerWritingPermission1786100000000 implements MigrationInterface {
  name = 'AnswerWritingPermission1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE admin_users
         SET permissions = array_append(permissions, 'answer-writing')
       WHERE 'quizzes' = ANY(permissions)
         AND NOT ('answer-writing' = ANY(permissions))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE admin_users
         SET permissions = array_remove(permissions, 'answer-writing')
       WHERE 'answer-writing' = ANY(permissions)
    `);
  }
}
