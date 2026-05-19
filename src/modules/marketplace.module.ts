import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException,
  UseGuards, ParseUUIDPipe, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../common/guards';
import { successResponse, paginationMeta } from '../common/utils/response.util';
import { AuthModule } from '../auth/auth.module';

import * as cloudinary from 'cloudinary';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';

// ════════════════════════════════════════════════════════════
// DB MIGRATION — run once to create marketplace tables
// Add this to a new migration file: 1747600000000-Marketplace.ts
// ════════════════════════════════════════════════════════════
/*
  CREATE TABLE marketplace_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(300) NOT NULL,
    description     TEXT,
    subject         VARCHAR(100),
    exam_tags       TEXT[] DEFAULT '{}',
    price           INTEGER NOT NULL DEFAULT 0,       -- in paise (0 = free)
    original_price  INTEGER,
    file_url        TEXT NOT NULL,                   -- Cloudinary PDF URL
    preview_url     TEXT,                            -- first page preview image
    thumbnail_url   TEXT,
    total_pages     INTEGER DEFAULT 0,
    downloads       INTEGER NOT NULL DEFAULT 0,
    rating          DECIMAL(3,2) DEFAULT 0,
    review_count    INTEGER DEFAULT 0,
    commission_pct  INTEGER NOT NULL DEFAULT 30,     -- platform cut (20-40%)
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','removed')),
    is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE marketplace_purchases (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    buyer_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id       UUID NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
    amount_paid   INTEGER NOT NULL DEFAULT 0,
    commission    INTEGER NOT NULL DEFAULT 0,
    seller_payout INTEGER NOT NULL DEFAULT 0,
    status        VARCHAR(20) NOT NULL DEFAULT 'completed',
    purchased_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(buyer_id, item_id)
  );

  CREATE TABLE marketplace_reviews (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    buyer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id    UUID NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
    rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(buyer_id, item_id)
  );

  CREATE INDEX idx_marketplace_status  ON marketplace_items(status);
  CREATE INDEX idx_marketplace_subject ON marketplace_items(subject);
  CREATE INDEX idx_marketplace_seller  ON marketplace_items(seller_id);
  CREATE INDEX idx_marketplace_purchases_buyer ON marketplace_purchases(buyer_id);
*/

// ════════════════════════════════════════════════════════════
// SERVICE
// ════════════════════════════════════════════════════════════
@Injectable()
export class MarketplaceService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  // ── Browse: GET /marketplace ────────────────────────────────
  async findAll(query: any, userId?: string) {
    const { page = 1, limit = 20, subject, search, sort = 'popular' } = query;
    const offset = (page - 1) * limit;
    const conds: string[] = [`mi.status = 'approved'`];
    const params: any[]   = [];

    if (subject) { conds.push(`mi.subject = $${params.length + 1}`); params.push(subject); }
    if (search) {
      conds.push(`(mi.title ILIKE $${params.length + 1} OR mi.description ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    const orderBy = sort === 'newest'  ? 'mi.created_at DESC'
                  : sort === 'rating'  ? 'mi.rating DESC, mi.downloads DESC'
                  : sort === 'price_asc' ? 'mi.price ASC'
                  : sort === 'price_desc' ? 'mi.price DESC'
                  : 'mi.downloads DESC, mi.is_featured DESC'; // popular

    const userSubQ = userId ? `,(SELECT true FROM marketplace_purchases mp WHERE mp.buyer_id=$${params.length + 1} AND mp.item_id=mi.id LIMIT 1) AS is_purchased` : '';
    if (userId) params.push(userId);

    const where = conds.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT
           mi.id, mi.title, mi.description, mi.subject, mi.price, mi.original_price,
           mi.thumbnail_url, mi.preview_url, mi.total_pages, mi.downloads,
           mi.rating, mi.review_count, mi.exam_tags, mi.is_featured, mi.created_at,
           u.id AS seller_id, u.name AS seller_name, u.avatar_url AS seller_avatar
           ${userSubQ}
         FROM marketplace_items mi
         JOIN users u ON u.id = mi.seller_id
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM marketplace_items mi WHERE ${where}`, params.slice(0, userId ? params.length - 1 : params.length)),
    ]);

    return successResponse({ items: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  // ── Detail: GET /marketplace/:id ───────────────────────────
  async findOne(itemId: string, userId?: string) {
    const [item] = await this.db.query(
      `SELECT mi.*, u.name AS seller_name, u.avatar_url AS seller_avatar,
         (SELECT COUNT(*) FROM marketplace_purchases WHERE item_id=mi.id) AS total_buyers,
         ${userId ? `(SELECT true FROM marketplace_purchases WHERE buyer_id=$2 AND item_id=mi.id LIMIT 1) AS is_purchased,` : ''}
         (SELECT json_agg(json_build_object('id',mr.id,'rating',mr.rating,'comment',mr.comment,'reviewer_name',ru.name,'created_at',mr.created_at))
          FROM marketplace_reviews mr JOIN users ru ON ru.id=mr.buyer_id WHERE mr.item_id=mi.id LIMIT 20) AS reviews
       FROM marketplace_items mi JOIN users u ON u.id=mi.seller_id
       WHERE mi.id=$1 AND mi.status='approved'`,
      userId ? [itemId, userId] : [itemId]
    );
    if (!item) throw new NotFoundException('Item not found');
    return successResponse({ item });
  }

  // ── Upload: POST /marketplace (seller) ─────────────────────
  async create(data: any, sellerId: string) {
    if (!data.title || !data.fileUrl) throw new BadRequestException('title and fileUrl are required');
    const price = parseInt(data.price || '0');
    if (price < 0) throw new BadRequestException('Price cannot be negative');

    const [item] = await this.db.query(
      `INSERT INTO marketplace_items
         (seller_id, title, description, subject, exam_tags, price, original_price, file_url, preview_url, thumbnail_url, total_pages, commission_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        sellerId, data.title, data.description || '', data.subject || 'General',
        data.examTags || [], price, data.originalPrice || price,
        data.fileUrl, data.previewUrl || null, data.thumbnailUrl || null,
        data.totalPages || 0,
        30, // default 30% commission — admin can override per-item
      ]
    );
    return successResponse({ item }, 'Notes submitted for review! Admin will approve within 24 hours. 📋');
  }

  // ── Purchase: POST /marketplace/:id/purchase ───────────────
  async purchase(itemId: string, buyerId: string) {
    const [item] = await this.db.query(
      `SELECT id, price, seller_id, commission_pct, status FROM marketplace_items WHERE id=$1`,
      [itemId]
    );
    if (!item) throw new NotFoundException('Item not found');
    if (item.status !== 'approved') throw new BadRequestException('Item not available for purchase');
    if (item.seller_id === buyerId) throw new ForbiddenException('You cannot purchase your own notes');

    // Check already purchased
    const [already] = await this.db.query(
      `SELECT id FROM marketplace_purchases WHERE buyer_id=$1 AND item_id=$2`,
      [buyerId, itemId]
    );
    if (already) return successResponse({ alreadyPurchased: true }, 'You already own this item');

    const price       = item.price;
    const commission  = Math.round(price * (item.commission_pct / 100));
    const sellerPayout = price - commission;

    if (price > 0) {
      // Deduct coins from buyer (1 coin = 1 paise for simplicity)
      const [buyer] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [buyerId]);
      if ((buyer?.coins || 0) < price) {
        throw new ForbiddenException({ message: 'Insufficient coins', code: 'INSUFFICIENT_COINS', required: price, current: buyer?.coins || 0 });
      }
      await this.db.query(
        `UPDATE users SET coins = coins - $1 WHERE id = $2`,
        [price, buyerId]
      );
      // Award seller their cut
      await this.db.query(
        `UPDATE users SET coins = coins + $1 WHERE id = $2`,
        [sellerPayout, item.seller_id]
      );
      // Record transactions
      const balAfterBuyer = (buyer.coins || 0) - price;
      await this.db.query(
        `INSERT INTO coin_transactions (user_id, type, amount, description, action, balance) VALUES ($1,'spent',$2,$3,'marketplace_purchase',$4)`,
        [buyerId, price, `Purchased: notes item`, balAfterBuyer]
      );
    }

    await this.db.query(
      `INSERT INTO marketplace_purchases (buyer_id, item_id, amount_paid, commission, seller_payout) VALUES ($1,$2,$3,$4,$5)`,
      [buyerId, itemId, price, commission, sellerPayout]
    );
    await this.db.query(`UPDATE marketplace_items SET downloads = downloads + 1 WHERE id=$1`, [itemId]);

    return successResponse({ purchased: true, fileAccess: true }, 'Purchase successful! 🎉 Your notes are ready to download.');
  }

  // ── Get file URL after purchase: GET /marketplace/:id/access
  async getFileAccess(itemId: string, userId: string) {
    const [item] = await this.db.query(`SELECT id, price, file_url, status FROM marketplace_items WHERE id=$1`, [itemId]);
    if (!item || item.status !== 'approved') throw new NotFoundException('Item not found');

    if (item.price > 0) {
      const [purchase] = await this.db.query(
        `SELECT id FROM marketplace_purchases WHERE buyer_id=$1 AND item_id=$2`,
        [userId, itemId]
      );
      if (!purchase) throw new ForbiddenException('Purchase this item first');
    }

    return successResponse({ fileUrl: item.file_url }, 'Access granted');
  }

  // ── My listings: GET /marketplace/my-listings ──────────────
  async myListings(sellerId: string) {
    const rows = await this.db.query(
      `SELECT mi.*, (SELECT COUNT(*) FROM marketplace_purchases WHERE item_id=mi.id) AS total_buyers,
         (SELECT COALESCE(SUM(seller_payout),0) FROM marketplace_purchases WHERE item_id=mi.id) AS earnings
       FROM marketplace_items mi
       WHERE mi.seller_id=$1 ORDER BY mi.created_at DESC`,
      [sellerId]
    );
    return successResponse({ listings: rows });
  }

  // ── My purchases: GET /marketplace/my-purchases ────────────
  async myPurchases(buyerId: string) {
    const rows = await this.db.query(
      `SELECT mi.id, mi.title, mi.subject, mi.thumbnail_url, mi.total_pages,
         mi.file_url, mp.purchased_at, mp.amount_paid, u.name AS seller_name
       FROM marketplace_purchases mp
       JOIN marketplace_items mi ON mi.id=mp.item_id
       JOIN users u ON u.id=mi.seller_id
       WHERE mp.buyer_id=$1 ORDER BY mp.purchased_at DESC`,
      [buyerId]
    );
    return successResponse({ purchases: rows });
  }

  // ── Review: POST /marketplace/:id/review ───────────────────
  async submitReview(itemId: string, userId: string, data: { rating: number; comment?: string }) {
    const [purchase] = await this.db.query(
      `SELECT id FROM marketplace_purchases WHERE buyer_id=$1 AND item_id=$2`,
      [userId, itemId]
    );
    if (!purchase) throw new ForbiddenException('Purchase this item to leave a review');

    await this.db.query(
      `INSERT INTO marketplace_reviews (buyer_id, item_id, rating, comment)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (buyer_id, item_id) DO UPDATE SET rating=$3, comment=$4`,
      [userId, itemId, data.rating, data.comment || null]
    );
    await this.db.query(
      `UPDATE marketplace_items SET
         rating       = (SELECT ROUND(AVG(rating)::numeric,2) FROM marketplace_reviews WHERE item_id=$1),
         review_count = (SELECT COUNT(*) FROM marketplace_reviews WHERE item_id=$1)
       WHERE id=$1`,
      [itemId]
    );
    return successResponse(null, 'Review submitted ✅');
  }

  // ── Admin: list all items ───────────────────────────────────
  async adminFindAll(query: any) {
    const { page = 1, limit = 50, status } = query;
    const offset = (page - 1) * limit;
    const conds  = status ? [`mi.status='${status}'`] : ['1=1'];
    const rows   = await this.db.query(
      `SELECT mi.*, u.name AS seller_name,
         (SELECT COUNT(*) FROM marketplace_purchases WHERE item_id=mi.id) AS total_buyers
       FROM marketplace_items mi JOIN users u ON u.id=mi.seller_id
       WHERE ${conds.join(' AND ')} ORDER BY mi.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const [{ count }] = await this.db.query(`SELECT COUNT(*) FROM marketplace_items mi WHERE ${conds.join(' AND ')}`);
    return successResponse({ items: rows }, 'Success', paginationMeta(parseInt(count), page, limit));
  }

  async adminUpdateItem(itemId: string, data: { status?: string; commissionPct?: number; isFeatured?: boolean }) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    if (data.status !== undefined)       { fields.push(`status=$${i++}`);         vals.push(data.status); }
    if (data.commissionPct !== undefined) { fields.push(`commission_pct=$${i++}`); vals.push(data.commissionPct); }
    if (data.isFeatured !== undefined)    { fields.push(`is_featured=$${i++}`);    vals.push(data.isFeatured); }
    if (!fields.length) throw new BadRequestException('Nothing to update');
    fields.push('updated_at=NOW()');
    await this.db.query(`UPDATE marketplace_items SET ${fields.join(',')} WHERE id=$${i}`, [...vals, itemId]);
    return successResponse(null, 'Item updated ✅');
  }
}

// ════════════════════════════════════════════════════════════
// USER CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Marketplace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketplace')
class MarketplaceController {
  constructor(private s: MarketplaceService) {}

  @Get()
  findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user?.id); }

  @Get('my-listings')
  myListings(@Req() r: any) { return this.s.myListings(r.user.id); }

  @Get('my-purchases')
  myPurchases(@Req() r: any) { return this.s.myPurchases(r.user.id); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.findOne(id, r.user?.id);
  }

  @Get(':id/access')
  getFileAccess(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.getFileAccess(id, r.user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.user.id); }

  @Post(':id/purchase')
  @HttpCode(HttpStatus.OK)
  purchase(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.purchase(id, r.user.id);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.CREATED)
  review(@Param('id', ParseUUIDPipe) id: string, @Req() r: any, @Body() dto: any) {
    return this.s.submitReview(id, r.user.id, dto);
  }
}

// ════════════════════════════════════════════════════════════
// ADMIN CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Admin — Marketplace')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/marketplace')
class AdminMarketplaceController {
  constructor(private s: MarketplaceService) {}

  @Get()
  findAll(@Query() q: any) { return this.s.adminFindAll(q); }

  @Put(':id')
  @RequirePermission('content')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.s.adminUpdateItem(id, dto);
  }

  @Delete(':id')
  @RequirePermission('content')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.adminUpdateItem(id, { status: 'removed' });
  }
}

// ════════════════════════════════════════════════════════════
// MODULE
// ════════════════════════════════════════════════════════════
@Module({
  imports:     [AuthModule],
  controllers: [MarketplaceController, AdminMarketplaceController],
  providers:   [MarketplaceService],
  exports:     [MarketplaceService],
})
export class MarketplaceModule {}