import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ConflictException,
  UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../common/guards';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../common/utils/response.util';
import { AuthService } from './auth/auth.module';

// ════════════════════════════════════════════════════════════
// CURRENT AFFAIRS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class CurrentAffairsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll(query: any, userId: string) {
    const { page=1, limit=20, date, category, exam, important } = query;
    const offset = (page-1)*limit;
    const conditions = [`ca.status='published'`], params: any[] = [];
    if (date)      { conditions.push(`ca.date=$${params.length+1}`); params.push(date); }
    if (category)  { conditions.push(`ca.category=$${params.length+1}`); params.push(category); }
    if (exam)      { conditions.push(`$${params.length+1}=ANY(ca.exam_tags)`); params.push(exam); }
    if (important === 'true') conditions.push(`ca.is_important=TRUE`);
    const where = conditions.join(' AND ');

    const cacheKey = `affairs:${where}:${params.join(',')}:${page}:${limit}:${userId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT ca.id,ca.title,ca.summary,ca.category,ca.date,ca.is_important,ca.exam_tags,ca.tags,ca.view_count,ca.bookmark_count,
           (SELECT TRUE FROM affairs_bookmarks ab WHERE ab.user_id=$${params.length+1} AND ab.affair_id=ca.id) AS is_bookmarked
         FROM current_affairs ca WHERE ${where}
         ORDER BY ca.date DESC, ca.is_important DESC LIMIT $${params.length+2} OFFSET $${params.length+3}`,
        [...params, userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM current_affairs ca WHERE ${where}`, params),
    ]);
    const result = successResponse({ affairs: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
    await this.cache.set(cacheKey, result, 120);
    return result;
  }

  async findOne(affairId: string, userId: string) {
    const result = await this.db.query(
      `SELECT ca.*, (SELECT TRUE FROM affairs_bookmarks WHERE user_id=$2 AND affair_id=ca.id) AS is_bookmarked
       FROM current_affairs ca WHERE ca.id=$1 AND ca.status='published'`,
      [affairId, userId]
    );
    if (!result.length) throw new NotFoundException('Article not found');
    this.db.query(`UPDATE current_affairs SET view_count=view_count+1 WHERE id=$1`, [affairId]).catch(() => {});
    return successResponse({ affair: result[0] });
  }

  async toggleBookmark(affairId: string, userId: string) {
    const existing = await this.db.query(`SELECT user_id FROM affairs_bookmarks WHERE user_id=$1 AND affair_id=$2`, [userId, affairId]);
    if (existing.length) {
      await this.db.query(`DELETE FROM affairs_bookmarks WHERE user_id=$1 AND affair_id=$2`, [userId, affairId]);
      await this.db.query(`UPDATE current_affairs SET bookmark_count=bookmark_count-1 WHERE id=$1`, [affairId]);
      return successResponse({ isBookmarked: false });
    }
    await this.db.query(`INSERT INTO affairs_bookmarks VALUES ($1,$2)`, [userId, affairId]);
    await this.db.query(`UPDATE current_affairs SET bookmark_count=bookmark_count+1 WHERE id=$1`, [affairId]);
    return successResponse({ isBookmarked: true });
  }

  async findAllAdmin(query: any) {
    const { page=1, limit=30, status, date } = query;
    const offset = (page-1)*limit;
    const conditions = ['1=1'], params: any[] = [];
    if (status) { conditions.push(`status=$${params.length+1}`); params.push(status); }
    if (date)   { conditions.push(`date=$${params.length+1}`); params.push(date); }
    const [rows, countResult] = await Promise.all([
      this.db.query(`SELECT * FROM current_affairs WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
      this.db.query(`SELECT COUNT(*) FROM current_affairs WHERE ${conditions.join(' AND ')}`, params),
    ]);
    return successResponse({ affairs: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async adminCreate(data: any, adminId: string) {
    if (!data.title || !data.summary) throw new BadRequestException('Title and summary required');
    const result = await this.db.query(
      `INSERT INTO current_affairs (title, summary, full_content, category, source, date, is_important, exam_tags, tags, status, author, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [data.title, data.summary, data.fullContent, data.category, data.source, data.date||new Date().toISOString().split('T')[0], data.isImportant||false, data.examTags||[], data.tags||[], data.status||'draft', data.author, adminId]
    );
    return successResponse({ affair: result[0] }, 'Article created — live in app ✅');
  }

  async adminUpdate(affairId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', summary:'summary', fullContent:'full_content', category:'category', source:'source', date:'date', isImportant:'is_important', status:'status' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (data.examTags) { fields.push(`exam_tags=$${i++}`); vals.push(data.examTags); }
    if (data.tags)     { fields.push(`tags=$${i++}`); vals.push(data.tags); }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE current_affairs SET ${fields.join(',')} WHERE id=$${i}`, [...vals, affairId]); }
    return successResponse(null, 'Article updated — live in app ✅');
  }

  async adminDelete(affairId: string) {
    await this.db.query(`DELETE FROM current_affairs WHERE id=$1`, [affairId]);
    return successResponse(null, 'Article deleted');
  }
}

@ApiTags('Current Affairs') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('current-affairs')
class CurrentAffairsController {
  constructor(private s: CurrentAffairsService) {}
  @Get() findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }
  @Get(':id') findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.findOne(id, r.user.id); }
  @Post(':id/bookmark') @HttpCode(200) toggleBookmark(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.toggleBookmark(id, r.user.id); }
}

@ApiTags('Admin — Current Affairs') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/current-affairs')
class AdminCurrentAffairsController {
  constructor(private s: CurrentAffairsService) {}
  @Get() @RequirePermission('current-affairs') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Post() @RequirePermission('current-affairs') @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.adminCreate(dto, r.admin.id); }
  @Put(':id') @RequirePermission('current-affairs') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.adminUpdate(id, dto); }
  @Delete(':id') @RequirePermission('current-affairs') remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.adminDelete(id); }
}

@Module({ controllers:[CurrentAffairsController, AdminCurrentAffairsController], providers:[CurrentAffairsService] })
export class CurrentAffairsModule {}

// ════════════════════════════════════════════════════════════
// JOBS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class JobsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll(query: any, userId: string) {
    const { page=1, limit=20, status='active', category, exam } = query;
    const offset = (page-1)*limit;
    const conditions = [`j.status=$1`], params: any[] = [status];
    if (category) { conditions.push(`j.category=$${params.length+1}`); params.push(category); }
    if (exam)     { conditions.push(`$${params.length+1}=ANY(j.exam_tags)`); params.push(exam); }
    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT j.*, (SELECT TRUE FROM job_saves js WHERE js.user_id=$${params.length+1} AND js.job_id=j.id) AS is_saved
         FROM job_vacancies j WHERE ${where}
         ORDER BY j.created_at DESC LIMIT $${params.length+2} OFFSET $${params.length+3}`,
        [...params, userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies j WHERE ${where}`, params),
    ]);
    return successResponse({ jobs: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async toggleSave(jobId: string, userId: string) {
    const existing = await this.db.query(`SELECT user_id FROM job_saves WHERE user_id=$1 AND job_id=$2`, [userId, jobId]);
    if (existing.length) {
      await this.db.query(`DELETE FROM job_saves WHERE user_id=$1 AND job_id=$2`, [userId, jobId]);
      await this.db.query(`UPDATE job_vacancies SET save_count=save_count-1 WHERE id=$1`, [jobId]);
      return successResponse({ isSaved: false });
    }
    await this.db.query(`INSERT INTO job_saves VALUES ($1,$2)`, [userId, jobId]);
    await this.db.query(`UPDATE job_vacancies SET save_count=save_count+1, view_count=view_count+1 WHERE id=$1`, [jobId]);
    return successResponse({ isSaved: true });
  }

  async findAllAdmin(query: any) {
    const { page=1, limit=20 } = query;
    const offset = (page-1)*limit;
    const [rows, countResult] = await Promise.all([
      this.db.query(`SELECT j.*, a.name AS created_by_name FROM job_vacancies j LEFT JOIN admin_users a ON j.created_by=a.id ORDER BY j.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies`),
    ]);
    return successResponse({ jobs: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async adminCreate(data: any, adminId: string) {
    if (!data.title || !data.organization || !data.lastDate) throw new BadRequestException('Title, organization and last date required');
    const result = await this.db.query(
      `INSERT INTO job_vacancies (title, organization, category, total_posts, notification_date, last_date, exam_date, age_limit, qualification, application_link, description, exam_tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [data.title, data.organization, data.category, data.totalPosts||0, data.notificationDate||null, data.lastDate, data.examDate||null, data.ageLimit, data.qualification, data.applicationLink, data.description, data.examTags||[], adminId]
    );
    return successResponse({ job: result[0] }, 'Job vacancy created — live in app ✅');
  }

  async adminUpdate(jobId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', organization:'organization', category:'category', totalPosts:'total_posts', lastDate:'last_date', examDate:'exam_date', status:'status', applicationLink:'application_link' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE job_vacancies SET ${fields.join(',')} WHERE id=$${i}`, [...vals, jobId]); }
    return successResponse(null, 'Job updated — live in app ✅');
  }

  async adminDelete(jobId: string) {
    await this.db.query(`DELETE FROM job_vacancies WHERE id=$1`, [jobId]);
    return successResponse(null, 'Job vacancy deleted');
  }
}

@ApiTags('Jobs') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('jobs')
class JobsController {
  constructor(private s: JobsService) {}
  @Get() findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }
  @Post(':id/save') @HttpCode(200) toggleSave(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.toggleSave(id, r.user.id); }
}

@ApiTags('Admin — Jobs') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/jobs')
class AdminJobsController {
  constructor(private s: JobsService) {}
  @Get() @RequirePermission('jobs') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Post() @RequirePermission('jobs') @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.adminCreate(dto, r.admin.id); }
  @Put(':id') @RequirePermission('jobs') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.adminUpdate(id, dto); }
  @Delete(':id') @RequirePermission('jobs') remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.adminDelete(id); }
}

@Module({ controllers:[JobsController, AdminJobsController], providers:[JobsService] })
export class JobsModule {}

// ════════════════════════════════════════════════════════════
// SUBSCRIPTIONS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class SubscriptionsService {
  private readonly PLANS = {
    monthly:   { price: 199, originalPrice: 299,  duration: '1 month',  bonusCoins: 20 },
    quarterly: { price: 499, originalPrice: 899,  duration: '3 months', bonusCoins: 60 },
    annual:    { price: 1499,originalPrice: 2999, duration: '12 months',bonusCoins: 200 },
  };

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getPlans() {
    return successResponse({
      plans: [
        { id:'monthly',   name:'Monthly',   price:199, originalPrice:299,  duration:'1 Month',   billingCycle:'Billed monthly',  bonusCoins:20,  savings:100 },
        { id:'quarterly', name:'Quarterly', price:499, originalPrice:899,  duration:'3 Months',  billingCycle:'₹166/month',      bonusCoins:60,  savings:400, isPopular:true },
        { id:'annual',    name:'Annual',    price:1499,originalPrice:2999, duration:'12 Months', billingCycle:'₹125/month',      bonusCoins:200, savings:1500 },
      ],
      coinValueInr:        parseFloat(this.config.get('business.coinValueInr')),
      maxCoinDiscountSub:  this.config.get('business.maxCoinDiscountSub'),
      maxCoinDiscountCourse: this.config.get('business.maxCoinDiscountCourse'),
    });
  }

  async initiate(userId: string, data: any) {
    const plan = this.PLANS[data.plan];
    if (!plan) throw new BadRequestException('Invalid plan');
    const { price } = plan;
    const coinValue    = parseFloat(this.config.get('business.coinValueInr'));
    const maxCoinPct   = parseInt(this.config.get('business.maxCoinDiscountSub'));
    const userCoins    = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0]?.coins || 0;
    const maxCoinDisc  = Math.floor(price * maxCoinPct / 100);
    const coinsToUse   = Math.min(data.coinsToUse || 0, userCoins, Math.floor(maxCoinDisc / coinValue));
    const coinDiscount = Math.floor(coinsToUse * coinValue);

    let couponDiscount = 0, validCoupon: any = null;
    if (data.couponCode) {
      const couponResult = await this.db.query(
        `SELECT * FROM coupons WHERE code=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) AND (max_uses IS NULL OR used_count<max_uses) AND applies_to IN ('subscription','both')`,
        [data.couponCode.toUpperCase()]
      );
      if (couponResult.length) {
        validCoupon = couponResult[0];
        couponDiscount = validCoupon.type === 'flat' ? Math.min(validCoupon.value, price) : Math.floor(price * validCoupon.value / 100);
      }
    }

    const finalAmount = Math.max(1, price - coinDiscount - couponDiscount);
    const subResult = await this.db.query(
      `INSERT INTO subscriptions (user_id, plan, amount, original_amount, coins_used, coin_discount, coupon_code, coupon_discount, final_amount, payment_status, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','pending') RETURNING id`,
      [userId, data.plan, price, price, coinsToUse, coinDiscount, validCoupon?.code||null, couponDiscount, finalAmount]
    );
    return successResponse({
      subscriptionId: subResult[0].id,
      breakdown: { baseAmount: price, coinDiscount, couponDiscount, finalAmount, coinsUsed: coinsToUse, couponCode: validCoupon?.code }
    });
  }

  async confirm(subId: string, userId: string, data: any) {
    const subResult = await this.db.query(`SELECT * FROM subscriptions WHERE id=$1 AND user_id=$2 AND payment_status='pending'`, [subId, userId]);
    if (!subResult.length) throw new NotFoundException('Subscription not found or already processed');
    const sub = subResult[0];
    const plan = this.PLANS[sub.plan];
    if (!plan) throw new BadRequestException('Invalid plan');

    // Validate no duplicate transaction
    const dupCheck = await this.db.query(`SELECT id FROM subscriptions WHERE razorpay_payment_id=$1`, [data.transactionId]);
    if (dupCheck.length) throw new ConflictException('Transaction already processed');

    const endsAt = new Date();
    if (sub.plan === 'monthly')   endsAt.setMonth(endsAt.getMonth() + 1);
    if (sub.plan === 'quarterly') endsAt.setMonth(endsAt.getMonth() + 3);
    if (sub.plan === 'annual')    endsAt.setFullYear(endsAt.getFullYear() + 1);

    await this.db.query(
      `UPDATE subscriptions SET payment_status='success', status='active', payment_method=$1, upi_id=$2,
       razorpay_payment_id=$3, starts_at=NOW(), ends_at=$4, updated_at=NOW() WHERE id=$5`,
      [data.paymentMethod||'upi', data.upiId||null, data.transactionId, endsAt, subId]
    );

    // Deduct coins
    if (sub.coins_used > 0) {
      await this.db.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [sub.coins_used, userId]);
      const bal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0].coins;
      await this.db.query(`INSERT INTO coin_transactions (user_id,type,amount,description,action,balance) VALUES ($1,'spent',$2,'Subscription payment discount','subscription_payment',$3)`, [userId, sub.coins_used, bal]);
    }

    // Update coupon usage
    if (sub.coupon_code) await this.db.query(`UPDATE coupons SET used_count=used_count+1 WHERE code=$1`, [sub.coupon_code]);

    // Award bonus coins
    await this.db.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [plan.bonusCoins, userId]);
    const newBal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0].coins;
    await this.db.query(`INSERT INTO coin_transactions (user_id,type,amount,description,action,balance) VALUES ($1,'earned',$2,'Subscription bonus coins','subscription_bonus',$3)`, [userId, plan.bonusCoins, newBal]);

    await this.cache.del(`user:${userId}`);
    return successResponse({ bonusCoinsEarned: plan.bonusCoins }, '🎉 Subscription activated! Enjoy BPSCNotes Pro');
  }

  async getStatus(userId: string) {
    const result = await this.db.query(
      `SELECT id, plan, status, starts_at, ends_at, auto_renew, payment_method FROM subscriptions WHERE user_id=$1 AND status='active' AND ends_at>NOW() ORDER BY ends_at DESC LIMIT 1`,
      [userId]
    );
    return successResponse({ isActive: result.length > 0, subscription: result[0] || null });
  }

  async validateCoupon(code: string, type: string) {
    const result = await this.db.query(
      `SELECT * FROM coupons WHERE code=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) AND (max_uses IS NULL OR used_count<max_uses) AND applies_to IN ($2,'both')`,
      [code.toUpperCase(), type]
    );
    if (!result.length) throw new NotFoundException('Invalid or expired coupon code');
    const coupon = result[0];
    return successResponse({ code: coupon.code, type: coupon.type, value: coupon.value, description: coupon.description },
      `Coupon applied! ${coupon.type === 'flat' ? `₹${coupon.value} off` : `${coupon.value}% off`}`);
  }

  async findAllAdmin(query: any) {
    const { page=1, limit=30, status, plan } = query;
    const offset = (page-1)*limit;
    const conditions = ['1=1'], params: any[] = [];
    if (status) { conditions.push(`s.status=$${params.length+1}`); params.push(status); }
    if (plan)   { conditions.push(`s.plan=$${params.length+1}`);   params.push(plan); }
    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT s.*, u.name AS user_name, u.email AS user_email, u.mobile AS user_mobile FROM subscriptions s JOIN users u ON s.user_id=u.id WHERE ${where} ORDER BY s.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM subscriptions s WHERE ${where}`, params),
    ]);
    return successResponse({ subscriptions: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async getCouponsAdmin() {
    const result = await this.db.query(`SELECT * FROM coupons ORDER BY created_at DESC`);
    return successResponse({ coupons: result });
  }

  async createCoupon(data: any, adminId: string) {
    if (!data.code || !data.type || !data.value) throw new BadRequestException('Code, type and value required');
    const result = await this.db.query(
      `INSERT INTO coupons (code, type, value, description, applies_to, max_uses, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.code.toUpperCase(), data.type, data.value, data.description, data.appliesTo||'both', data.maxUses||null, data.expiresAt||null, adminId]
    );
    return successResponse({ coupon: result[0] }, 'Coupon created — active now ✅');
  }

  async updateCoupon(couponId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    ['is_active','max_uses','expires_at','value'].forEach(col => {
      const key = col.replace(/_([a-z])/g, g => g[1].toUpperCase());
      if (data[key] !== undefined || data[col] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key] ?? data[col]); }
    });
    if (data.isActive !== undefined) { fields.push(`is_active=$${i++}`); vals.push(data.isActive); }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE coupons SET ${fields.join(',')} WHERE id=$${i}`, [...vals, couponId]); }
    return successResponse(null, 'Coupon updated ✅');
  }

  async deleteCoupon(couponId: string) {
    await this.db.query(`DELETE FROM coupons WHERE id=$1`, [couponId]);
    return successResponse(null, 'Coupon deleted');
  }
}

@ApiTags('Subscriptions') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('subscriptions')
class SubscriptionsController {
  constructor(private s: SubscriptionsService) {}
  @Get('plans') @HttpCode(200) getPlans() { return this.s.getPlans(); }
  @Post('initiate') @HttpCode(200) initiate(@Req() r: any, @Body() dto: any) { return this.s.initiate(r.user.id, dto); }
  @Post(':id/confirm') @HttpCode(200) confirm(@Param('id', ParseUUIDPipe) id: string, @Req() r: any, @Body() dto: any) { return this.s.confirm(id, r.user.id, dto); }
  @Get('status') getStatus(@Req() r: any) { return this.s.getStatus(r.user.id); }
  @Post('coupons/validate') @HttpCode(200) validateCoupon(@Body() body: any) { return this.s.validateCoupon(body.code, body.type||'subscription'); }
}

@ApiTags('Admin — Subscriptions') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/subscriptions')
class AdminSubscriptionsController {
  constructor(private s: SubscriptionsService) {}
  @Get() @RequirePermission('subscriptions') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Get('coupons') @RequirePermission('subscriptions') getCoupons() { return this.s.getCouponsAdmin(); }
  @Post('coupons') @RequirePermission('subscriptions') @HttpCode(201) createCoupon(@Body() dto: any, @Req() r: any) { return this.s.createCoupon(dto, r.admin.id); }
  @Put('coupons/:id') @RequirePermission('subscriptions') updateCoupon(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.updateCoupon(id, dto); }
  @Delete('coupons/:id') @RequirePermission('subscriptions') deleteCoupon(@Param('id', ParseUUIDPipe) id: string) { return this.s.deleteCoupon(id); }
}

@Module({ imports:[ConfigModule], controllers:[SubscriptionsController, AdminSubscriptionsController], providers:[SubscriptionsService] })
export class SubscriptionsModule {}

// ════════════════════════════════════════════════════════════
// NOTIFICATIONS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
export class NotificationService {
  private firebaseInitialized = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {
    this.initFirebase();
  }

  private initFirebase() {
    try {
      if (!admin.apps.length) {
        const fb = this.config.get('firebase');
        if (fb.projectId && fb.privateKey) {
          admin.initializeApp({
            credential: admin.credential.cert({
              projectId:   fb.projectId,
              privateKeyId: fb.privateKeyId,
              privateKey:   fb.privateKey,
              clientEmail:  fb.clientEmail,
            } as any),
          });
          this.firebaseInitialized = true;
        }
      } else {
        this.firebaseInitialized = true;
      }
    } catch (err) {
      console.warn('⚠️  Firebase not configured — push notifications disabled:', err.message);
    }
  }

  async send(data: any, adminId: string) {
    if (!data.title || !data.body) throw new BadRequestException('Title and body required');

    if (data.scheduledAt) {
      const result = await this.db.query(
        `INSERT INTO notifications (title, body, type, target, target_exam, data, status, scheduled_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8) RETURNING id`,
        [data.title, data.body, data.type||'announcement', data.target||'all', data.targetExam||null, JSON.stringify(data.data||{}), data.scheduledAt, adminId]
      );
      return successResponse({ notificationId: result[0].id }, `Notification scheduled for ${data.scheduledAt}`);
    }

    const notifResult = await this.db.query(
      `INSERT INTO notifications (title, body, type, target, target_exam, data, status, sent_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,'sent',NOW(),$7) RETURNING id`,
      [data.title, data.body, data.type||'announcement', data.target||'all', data.targetExam||null, JSON.stringify(data.data||{}), adminId]
    );
    const notifId = notifResult[0].id;

    let userQuery = `SELECT id, fcm_token FROM users WHERE status='active' AND notification_enabled=TRUE AND deleted_at IS NULL`;
    const params: any[] = [];
    if (data.target === 'pro') {
      userQuery += ` AND id IN (SELECT user_id FROM subscriptions WHERE status='active' AND ends_at>NOW())`;
    } else if (data.target === 'free') {
      userQuery += ` AND id NOT IN (SELECT user_id FROM subscriptions WHERE status='active' AND ends_at>NOW())`;
    } else if (data.target === 'exam' && data.targetExam) {
      userQuery += ` AND primary_exam=$1`;
      params.push(data.targetExam);
    } else if (data.target === 'user' && data.targetUserId) {
      userQuery += ` AND id=$1`;
      params.push(data.targetUserId);
    }

    const users = await this.db.query(userQuery, params);

    // Batch insert into user_notifications
    if (users.length > 0) {
      const chunkSize = 1000;
      for (let i = 0; i < users.length; i += chunkSize) {
        const chunk = users.slice(i, i + chunkSize);
        const vals  = chunk.map((_: any, j: number) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4})`).join(',');
        const flat  = chunk.flatMap((u: any) => [u.id, notifId, data.title, data.body]);
        await this.db.query(`INSERT INTO user_notifications (user_id, notification_id, title, body) VALUES ${vals}`, flat);
      }
    }

    // FCM push
    let pushSuccess = 0, pushFail = 0;
    if (this.firebaseInitialized) {
      const tokens = users.map((u: any) => u.fcm_token).filter(Boolean);
      if (tokens.length > 0) {
        for (let i = 0; i < tokens.length; i += 500) {
          try {
            const result = await admin.messaging().sendEachForMulticast({
              tokens: tokens.slice(i, i + 500),
              notification: { title: data.title, body: data.body },
              data: { type: data.type || 'announcement', notifId },
              android: { priority: 'high' },
            });
            pushSuccess += result.successCount;
            pushFail    += result.failureCount;
          } catch (err) {
            console.error('FCM error:', err.message);
          }
        }
      }
    }

    await this.db.query(`UPDATE notifications SET total_sent=$1 WHERE id=$2`, [users.length, notifId]);
    return successResponse({ notificationId: notifId, totalSent: users.length, pushSuccess, pushFail }, `Notification sent to ${users.length} users ✅`);
  }

  async getUserNotifications(userId: string, query: any) {
    const { page=1, limit=20 } = query;
    const offset = (page-1)*limit;
    const [notifs, unread] = await Promise.all([
      this.db.query(
        `SELECT un.id, un.title, un.body, n.type, un.is_read, un.created_at FROM user_notifications un LEFT JOIN notifications n ON un.notification_id=n.id WHERE un.user_id=$1 ORDER BY un.created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM user_notifications WHERE user_id=$1 AND is_read=FALSE`, [userId]),
    ]);
    return successResponse({ notifications: notifs, unreadCount: parseInt(unread[0].count) }, 'Success',
      paginationMeta(0, page, limit));
  }

  async markRead(userId: string, ids?: string[]) {
    if (ids?.length) {
      await this.db.query(`UPDATE user_notifications SET is_read=TRUE, read_at=NOW() WHERE user_id=$1 AND id=ANY($2)`, [userId, ids]);
    } else {
      await this.db.query(`UPDATE user_notifications SET is_read=TRUE, read_at=NOW() WHERE user_id=$1`, [userId]);
    }
    return successResponse(null, 'Marked as read');
  }

  async findAllAdmin(query: any) {
    const result = await this.db.query(
      `SELECT n.*, a.name AS created_by_name FROM notifications n LEFT JOIN admin_users a ON n.created_by=a.id ORDER BY n.created_at DESC LIMIT 50`
    );
    return successResponse({ notifications: result });
  }
}

@ApiTags('Notifications') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('notifications')
class NotificationsController {
  constructor(private s: NotificationService) {}
  @Get() getUserNotifs(@Query() q: any, @Req() r: any) { return this.s.getUserNotifications(r.user.id, q); }
  @Post('mark-read') @HttpCode(200) markRead(@Req() r: any, @Body() body: any) { return this.s.markRead(r.user.id, body.ids); }
}

@ApiTags('Admin — Notifications') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/notifications')
class AdminNotificationsController {
  constructor(private s: NotificationService) {}
  @Get() @RequirePermission('notifications') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Post('send') @RequirePermission('notifications') @HttpCode(200) send(@Body() dto: any, @Req() r: any) { return this.s.send(dto, r.admin.id); }
}

@Module({ imports:[ConfigModule], controllers:[NotificationsController, AdminNotificationsController], providers:[NotificationService], exports:[NotificationService] })
export class NotificationsModule {}

// ════════════════════════════════════════════════════════════
// COINS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class CoinsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getBalance(userId: string) {
    const [balance, earned, spent] = await Promise.all([
      this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]),
      this.db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM coin_transactions WHERE user_id=$1 AND type='earned'`, [userId]),
      this.db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM coin_transactions WHERE user_id=$1 AND type='spent'`, [userId]),
    ]);
    return successResponse({
      balance:     parseInt(balance[0]?.coins || 0),
      totalEarned: parseInt(earned[0].total),
      totalSpent:  parseInt(spent[0].total),
    });
  }

  async getHistory(userId: string, query: any) {
    const { page=1, limit=20 } = query;
    const offset = (page-1)*limit;
    const [rows, countResult] = await Promise.all([
      this.db.query(`SELECT id, type, amount, description, action, created_at, balance FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]),
      this.db.query(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [userId]),
    ]);
    return successResponse({ history: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async getRules() {
    const rules = await this.db.query(
      `SELECT cr.*, (SELECT COALESCE(SUM(amount),0) FROM coin_transactions WHERE action=cr.action AND type='earned') AS total_awarded FROM coin_rules ORDER BY created_at`
    );
    return successResponse({ rules });
  }

  async updateRule(ruleId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    if (data.coinsAwarded !== undefined) { fields.push(`coins_awarded=$${i++}`); vals.push(data.coinsAwarded); }
    if (data.maxPerDay    !== undefined) { fields.push(`max_per_day=$${i++}`);   vals.push(data.maxPerDay); }
    if (data.isActive     !== undefined) { fields.push(`is_active=$${i++}`);     vals.push(data.isActive); }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE coin_rules SET ${fields.join(',')} WHERE id=$${i}`, [...vals, ruleId]); }
    return successResponse(null, 'Coin rule updated — effective immediately ✅');
  }

  async getTopEarners() {
    const result = await this.db.query(
      `SELECT id, name, primary_exam, coins, streak, avatar_url FROM users WHERE status='active' ORDER BY coins DESC LIMIT 50`
    );
    return successResponse({ earners: result });
  }
}

@ApiTags('Coins') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('coins')
class CoinsController {
  constructor(private s: CoinsService) {}
  @Get('balance') getBalance(@Req() r: any) { return this.s.getBalance(r.user.id); }
  @Get('history') getHistory(@Query() q: any, @Req() r: any) { return this.s.getHistory(r.user.id, q); }
  
}


@Module({ imports:[ConfigModule], controllers:[CoinsController, AdminCoinsController], providers:[CoinsService] })


@ApiTags('Admin — Coins') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/coins')
class AdminCoinsController {
  constructor(private s: CoinsService) {}
  @Get('rules') @RequirePermission('coins') getRules() { return this.s.getRules(); }
  @Put('rules/:id') @RequirePermission('coins') updateRule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.updateRule(id, dto); }
  @Get('top-earners') @RequirePermission('coins') getTopEarners() { return this.s.getTopEarners(); }
}

//export class CoinsModule {}
