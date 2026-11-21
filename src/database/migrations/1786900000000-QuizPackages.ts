import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mock test packages — a priced bundle of tests, shaped like a course.
 *
 * Mock tests were flat: each one priced on its own. The client wants them
 * sold the way courses are, a series bought once that unlocks everything
 * inside it.
 *
 * Individual pricing stays. A test can belong to a package, be priced on
 * its own, or both — in which case owning either the package or the test
 * grants access. Nothing already selling has to change, and the client can
 * simply stop using per-test prices if they prefer bundles only.
 *
 * quizzes.package_id is ON DELETE SET NULL on purpose: deleting a package
 * must not delete the tests in it. They fall back to standalone, which is
 * recoverable, where a cascade would destroy question banks.
 */
export class QuizPackages1786900000000 implements MigrationInterface {
  name = 'QuizPackages1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS quiz_packages (
        id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        title            TEXT        NOT NULL,
        description      TEXT,
        thumbnail_url    TEXT,
        subject          TEXT,
        exam_tags        TEXT[]      NOT NULL DEFAULT '{}',
        is_paid          BOOLEAN     NOT NULL DEFAULT TRUE,
        price            INTEGER     NOT NULL DEFAULT 0,
        coin_price       INTEGER     NOT NULL DEFAULT 0,
        status           TEXT        NOT NULL DEFAULT 'draft',
        sort_order       INTEGER     NOT NULL DEFAULT 0,
        gplay_product_id TEXT,
        created_by       UUID,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      ALTER TABLE quizzes
        ADD COLUMN IF NOT EXISTS package_id UUID REFERENCES quiz_packages(id) ON DELETE SET NULL
    `);

    // Listing a package's tests is the hot path on the package screen.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_quizzes_package ON quizzes(package_id) WHERE package_id IS NOT NULL`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS quiz_package_purchases (
        id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        package_id           UUID        NOT NULL REFERENCES quiz_packages(id) ON DELETE CASCADE,
        user_id              UUID        NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
        price_paid           INTEGER     NOT NULL DEFAULT 0,
        coins_spent          INTEGER     NOT NULL DEFAULT 0,
        payment_provider     TEXT        NOT NULL DEFAULT 'coins',
        gplay_purchase_token TEXT,
        gplay_order_id       TEXT,
        purchased_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (package_id, user_id)
      )
    `);

    // The entitlement check runs on every mock-test card render.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_quiz_package_purchases_user ON quiz_package_purchases(user_id, package_id)`
    );

    // One Play token can only ever entitle one row. Partial so the coin
    // rows, which carry no token, are not all competing for a single NULL.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_package_purchases_gplay_token
        ON quiz_package_purchases(gplay_purchase_token)
        WHERE gplay_purchase_token IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS quiz_package_purchases`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_quizzes_package`);
    await queryRunner.query(`ALTER TABLE quizzes DROP COLUMN IF EXISTS package_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS quiz_packages`);
  }
}
