// ── quiz-packages.module.ts ──────────────────────────────────────────────
// Mock test packages: a priced bundle of tests, shaped like a course.
//
// Lives in its own file rather than inside quizzes.module.ts, which is
// already ~1700 lines. The entitlement check that actually gates a test is
// in QuizzesService.hasPurchased — it reads quiz_package_purchases
// directly, so there is no service-to-service dependency to wire up.
//
// Pricing: a package may be sold for coins, for money, or both, exactly
// like an individual test. Money goes through Google Play, because this is
// digital content bought inside the app.
import {
  Module, Injectable, Controller, Get, Post, Put, Delete, Body,
  Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException,
  UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission } from '../../common/guards';
import { successResponse } from '../../common/utils/response.util';
import {
  syncQuizPackageToPlayCatalog,
  gplayProductIdForQuizPackage,
} from '../../common/utils/gplay-catalog.util';
import {
  getOneTimeProductPurchase,
  acknowledgeOneTimeProductPurchase,
} from '../../common/utils/gplay-purchase.util';

@Injectable()
export class QuizPackagesService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // ── Student-facing ────────────────────────────────────────────────

  /**
   * Published packages, with how many tests each holds and whether this
   * student already owns it. Mirrors the course list so the app can render
   * the two the same way.
   */
  async list(userId: string, query: any = {}) {
    const params: any[] = [userId];
    let where = `p.status = 'published'`;

    if (query.subject) {
      params.push(query.subject);
      where += ` AND p.subject = $${params.length}`;
    }

    const rows = await this.db.query(
      `SELECT p.id, p.title, p.description, p.thumbnail_url, p.subject,
              p.exam_tags, p.is_paid, p.price, p.coin_price, p.gplay_product_id,
              (SELECT COUNT(*)::int FROM quizzes q
                WHERE q.package_id = p.id AND q.status = 'published') AS test_count,
              EXISTS (SELECT 1 FROM quiz_package_purchases pp
                       WHERE pp.package_id = p.id AND pp.user_id = $1) AS is_purchased
         FROM quiz_packages p
        WHERE ${where}
        ORDER BY p.sort_order ASC, p.created_at DESC`,
      params,
    );
    return successResponse({ packages: rows });
  }

  /** One package and the tests inside it. */
  async findOne(packageId: string, userId: string) {
    const [pkg] = await this.db.query(
      `SELECT p.*,
              EXISTS (SELECT 1 FROM quiz_package_purchases pp
                       WHERE pp.package_id = p.id AND pp.user_id = $2) AS is_purchased
         FROM quiz_packages p
        WHERE p.id = $1 AND p.status = 'published'`,
      [packageId, userId],
    );
    if (!pkg) throw new NotFoundException('Package not found');

    const tests = await this.db.query(
      `SELECT q.id, q.title, q.description, q.total_questions, q.duration_mins,
              q.type, q.subject, COALESCE(q.is_paid,false) AS is_paid,
              COALESCE(q.price,0) AS price, COALESCE(q.coin_price,0) AS coin_price,
              EXISTS (SELECT 1 FROM quiz_purchases qp
                       WHERE qp.quiz_id = q.id AND qp.user_id = $2) AS is_purchased
         FROM quizzes q
        WHERE q.package_id = $1 AND q.status = 'published'
        ORDER BY q.created_at ASC`,
      [packageId, userId],
    );

    return successResponse({ package: pkg, tests });
  }

  // ── Buying ────────────────────────────────────────────────────────

  private async alreadyOwns(packageId: string, userId: string): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM quiz_package_purchases WHERE package_id=$1 AND user_id=$2 LIMIT 1`,
      [packageId, userId],
    );
    return rows.length > 0;
  }

  /**
   * Unlock a package with coins.
   *
   * One transaction: debit, entitle, record. A crash between the debit and
   * the entitlement would otherwise take the coins and grant nothing.
   */
  async purchaseWithCoins(packageId: string, userId: string) {
    const [pkg] = await this.db.query(
      `SELECT id, title, COALESCE(is_paid,false) AS is_paid, COALESCE(coin_price,0) AS coin_price
         FROM quiz_packages WHERE id=$1 AND status='published'`,
      [packageId],
    );
    if (!pkg) throw new NotFoundException('Package not found');
    if (!pkg.is_paid) throw new BadRequestException('This package is already free');

    if (await this.alreadyOwns(packageId, userId)) {
      return successResponse({ alreadyOwned: true }, 'You already have this package');
    }

    const cost = Number(pkg.coin_price) || 0;
    if (cost <= 0) throw new BadRequestException('This package cannot be unlocked with coins');

    return this.db.transaction(async (tx) => {
      const [user] = await tx.query(`SELECT coins FROM users WHERE id=$1 FOR UPDATE`, [userId]);
      if (!user) throw new NotFoundException('User not found');
      if (Number(user.coins) < cost) {
        throw new BadRequestException(`Not enough coins — this package costs ${cost}, you have ${user.coins}`);
      }

      await tx.query(`UPDATE users SET coins = coins - $2 WHERE id=$1`, [userId, cost]);
      await tx.query(
        `INSERT INTO quiz_package_purchases (package_id, user_id, coins_spent, payment_provider)
         VALUES ($1,$2,$3,'coins')
         ON CONFLICT (package_id, user_id) DO NOTHING`,
        [packageId, userId, cost],
      );

      const [after] = await tx.query(`SELECT coins FROM users WHERE id=$1`, [userId]);

      // type and balance are both NOT NULL on coin_transactions and only
      // balance carries a default — omitting type makes the insert throw.
      await tx.query(
        `INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
         VALUES ($1,'spent',$2,$3,'quiz_package_unlock',$4)`,
        [userId, -cost, `Unlocked package: ${pkg.title}`, Number(after?.coins) || 0],
      );

      return successResponse({ unlocked: true, coinsLeft: Number(after?.coins) || 0 }, `Unlocked: ${pkg.title}`);
    });
  }

  /**
   * Unlock a package with money, through Google Play.
   *
   * Same contract as the course and single-test verifications: the token is
   * re-checked with Google rather than trusted, the duplicate check is
   * scoped to the requesting user so a captured token cannot be replayed
   * into someone else's entitlement, and the acknowledge is awaited because
   * nothing retries a missed one before Google's 3-day auto-refund.
   */
  async verifyGPlayPurchase(
    packageId: string,
    userId: string,
    dto: { purchaseToken: string; clientPriceInr?: number },
  ) {
    const purchaseToken = dto?.purchaseToken;
    if (!purchaseToken) throw new BadRequestException('purchaseToken required');

    const [dup] = await this.db.query(
      `SELECT id FROM quiz_package_purchases WHERE gplay_purchase_token=$1 AND user_id=$2`,
      [purchaseToken, userId],
    );
    if (dup) return successResponse({ alreadyOwned: true }, 'You already have this package');

    const [pkg] = await this.db.query(
      `SELECT id, title, COALESCE(is_paid,false) AS is_paid, gplay_product_id
         FROM quiz_packages WHERE id=$1 AND status='published'`,
      [packageId],
    );
    if (!pkg) throw new NotFoundException('Package not found');
    if (!pkg.is_paid) throw new BadRequestException('This package is already free');
    if (!pkg.gplay_product_id) {
      throw new BadRequestException('This package is not available for purchase via Google Play yet.');
    }

    let purchase: any;
    try {
      purchase = await getOneTimeProductPurchase(purchaseToken);
    } catch (e: any) {
      console.error(
        `GPlay package verify failed: user=${userId} package=${packageId}`,
        e?.response?.data ?? e?.message ?? e,
      );
      throw new BadRequestException('Google Play purchase verification failed. Contact support.');
    }

    if (purchase.productId !== pkg.gplay_product_id) {
      throw new BadRequestException('This purchase does not match this package.');
    }
    if (purchase.purchaseState !== 'PURCHASED') {
      throw new BadRequestException(`Play purchase not completed (state: ${purchase.purchaseState}).`);
    }
    if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== userId) {
      console.warn(
        `GPlay package account mismatch: user=${userId} tokenAccountId=${purchase.obfuscatedExternalAccountId}`,
      );
      throw new BadRequestException('This purchase does not belong to your account.');
    }

    const amount = Math.max(0, Math.floor(Number(dto.clientPriceInr) || 0));

    await this.db.query(
      `INSERT INTO quiz_package_purchases
         (package_id, user_id, price_paid, coins_spent, payment_provider, gplay_purchase_token, gplay_order_id)
       VALUES ($1,$2,$3,0,'gplay',$4,$5)
       ON CONFLICT (package_id, user_id) DO UPDATE
         SET price_paid=$3, payment_provider='gplay',
             gplay_purchase_token=$4, gplay_order_id=$5`,
      [packageId, userId, amount, purchaseToken, purchase.orderId],
    );

    if (purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
      const acked = await acknowledgeOneTimeProductPurchase(pkg.gplay_product_id, purchaseToken);
      if (!acked) {
        console.error(`GPlay package acknowledge failed: user=${userId} package=${packageId}`);
      }
    }

    return successResponse({ unlocked: true }, `Unlocked: ${pkg.title}`);
  }

  // ── Admin ─────────────────────────────────────────────────────────

  async adminList() {
    const rows = await this.db.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM quizzes q WHERE q.package_id = p.id) AS test_count,
              (SELECT COUNT(*)::int FROM quiz_package_purchases pp WHERE pp.package_id = p.id) AS purchase_count
         FROM quiz_packages p
        ORDER BY p.sort_order ASC, p.created_at DESC`,
    );
    return successResponse({ packages: rows });
  }

  async adminFindOne(packageId: string) {
    const [pkg] = await this.db.query(`SELECT * FROM quiz_packages WHERE id=$1`, [packageId]);
    if (!pkg) throw new NotFoundException('Package not found');

    const tests = await this.db.query(
      `SELECT id, title, type, subject, status, total_questions, duration_mins
         FROM quizzes WHERE package_id=$1 ORDER BY created_at ASC`,
      [packageId],
    );
    return successResponse({ package: pkg, tests });
  }

  async create(data: any, adminId: string) {
    if (!data?.title?.trim()) throw new BadRequestException('Title is required');

    const [row] = await this.db.query(
      `INSERT INTO quiz_packages
         (title, description, thumbnail_url, subject, exam_tags,
          is_paid, price, coin_price, status, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        data.title.trim(),
        data.description || null,
        data.thumbnailUrl || null,
        data.subject || null,
        data.examTags || [],
        data.isPaid !== false,
        data.price != null ? +data.price : 0,
        data.coinPrice != null ? +data.coinPrice : 0,
        data.status || 'draft',
        data.sortOrder != null ? +data.sortOrder : 0,
        adminId,
      ],
    );

    await this.syncPlayCatalog(row.id);
    return successResponse({ package: row }, 'Package created');
  }

  async update(packageId: string, data: any) {
    const map: Record<string, string> = {
      title: 'title', description: 'description', thumbnailUrl: 'thumbnail_url',
      subject: 'subject', examTags: 'exam_tags', isPaid: 'is_paid',
      price: 'price', coinPrice: 'coin_price', status: 'status', sortOrder: 'sort_order',
    };

    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push('updated_at=NOW()');
    const result = await this.db.query(
      `UPDATE quiz_packages SET ${fields.join(',')} WHERE id=$${i} RETURNING id`,
      [...vals, packageId],
    );
    // raw query() returns [rows, affectedCount] for UPDATE/DELETE RETURNING.
    const [updated] = result as [any[], number];
    if (!updated.length) throw new NotFoundException('Package not found');

    await this.syncPlayCatalog(packageId);
    return successResponse(null, 'Package updated');
  }

  async remove(packageId: string) {
    // Tests fall back to standalone rather than being deleted — see the
    // ON DELETE SET NULL note in migration 1786900000000.
    const result = await this.db.query(
      `DELETE FROM quiz_packages WHERE id=$1 RETURNING id`, [packageId],
    );
    const [deleted] = result as [any[], number];
    if (!deleted.length) throw new NotFoundException('Package not found');
    return successResponse(null, 'Package deleted — its tests are now standalone');
  }

  /**
   * Replace the package's test list in one call, the way the admin screen
   * edits it. Tests dropped from the list become standalone again rather
   * than being deleted.
   */
  async setTests(packageId: string, quizIds: string[]) {
    const [pkg] = await this.db.query(`SELECT id FROM quiz_packages WHERE id=$1`, [packageId]);
    if (!pkg) throw new NotFoundException('Package not found');

    const ids = Array.isArray(quizIds) ? quizIds.filter(Boolean) : [];

    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE quizzes SET package_id=NULL WHERE package_id=$1`, [packageId]);
      if (ids.length) {
        await tx.query(`UPDATE quizzes SET package_id=$1 WHERE id = ANY($2::uuid[])`, [packageId, ids]);
      }
    });

    return successResponse({ count: ids.length }, 'Tests updated');
  }

  /**
   * Keep the Play product in step with what admin saved. Best-effort, the
   * same contract as the course and single-test syncs: never throws, never
   * blocks the save.
   */
  private async syncPlayCatalog(packageId: string): Promise<void> {
    const [pkg] = await this.db.query(
      `SELECT id, title, description, price, COALESCE(is_paid,false) AS is_paid
         FROM quiz_packages WHERE id=$1`,
      [packageId],
    ).catch(() => []);
    if (!pkg) return;

    const productId = await syncQuizPackageToPlayCatalog({
      id: pkg.id,
      title: pkg.title,
      description: pkg.description,
      price: Number(pkg.price),
      isPaid: pkg.is_paid,
    });

    if (productId) {
      await this.db.query(
        `UPDATE quiz_packages SET gplay_product_id=$1 WHERE id=$2`,
        [productId, packageId],
      ).catch(() => {});
    }
  }
}

// ── Student controller ──────────────────────────────────────────────
@ApiTags('Quiz Packages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quiz-packages')
export class QuizPackagesController {
  constructor(private readonly s: QuizPackagesService) {}

  @Get()
  list(@Query() q: any, @Req() r: any) { return this.s.list(r.user.id, q); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.findOne(id, r.user.id);
  }

  @Post(':id/purchase')
  @HttpCode(HttpStatus.OK)
  purchase(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.purchaseWithCoins(id, r.user.id);
  }

  @Post(':id/purchase/gplay/verify')
  @HttpCode(HttpStatus.OK)
  verifyGplay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { purchaseToken: string; clientPriceInr?: number },
    @Req() r: any,
  ) {
    return this.s.verifyGPlayPurchase(id, r.user.id, dto);
  }
}

// ── Admin controller ────────────────────────────────────────────────
@ApiTags('Admin — Quiz Packages')
@UseGuards(AdminJwtGuard, PermissionGuard)
@RequirePermission('quizzes')
@Controller('admin/quiz-packages')
export class AdminQuizPackagesController {
  constructor(private readonly s: QuizPackagesService) {}

  @Get()
  list() { return this.s.adminList(); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.s.adminFindOne(id); }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.admin?.id); }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.s.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.remove(id); }

  @Put(':id/tests')
  setTests(@Param('id', ParseUUIDPipe) id: string, @Body() dto: { quizIds: string[] }) {
    return this.s.setTests(id, dto?.quizIds || []);
  }
}

@Module({
  controllers: [QuizPackagesController, AdminQuizPackagesController],
  providers: [QuizPackagesService],
  exports: [QuizPackagesService],
})
export class QuizPackagesModule {}
