import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ConflictException,
  UseGuards, ParseUUIDPipe, OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject , Optional } from '@nestjs/common';
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
           (SELECT TRUE FROM affairs_bookmarks ab WHERE ab.user_id=$${params.length+1} AND ab.affair_id=ca.id) AS is_bookmarked,
           (SELECT COUNT(*) FROM ca_mcqs m WHERE m.affair_id=ca.id)::int AS mcq_count
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
    // Note: current_affairs table has no 'type' column — type is stored in exam_tags[0]
    const { page=1, limit=20, status, date, search, category, exam } = query;
    const offset = (page-1)*limit;
    const conditions = ['1=1'], params: any[] = [];
    if (status)   { conditions.push(`ca.status=$${params.length+1}`);     params.push(status); }
    if (date)     { conditions.push(`ca.date=$${params.length+1}`);        params.push(date); }
    if (category) { conditions.push(`ca.category=$${params.length+1}`);    params.push(category); }
    if (search)   { conditions.push(`ca.title ILIKE $${params.length+1}`); params.push(`%${search}%`); }
    if (exam)     { conditions.push(`$${params.length+1}=ANY(ca.exam_tags)`); params.push(exam); }
    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT ca.id, ca.title, ca.summary, ca.full_content, ca.category,
                ca.date, ca.is_important, ca.exam_tags, ca.tags, ca.status,
                ca.view_count, ca.bookmark_count, ca.created_at,
                (SELECT COUNT(*) FROM ca_mcqs m WHERE m.affair_id=ca.id)::int AS mcq_count
         FROM current_affairs ca
         WHERE ${where}
         ORDER BY ca.date DESC, ca.created_at DESC
         LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM current_affairs ca WHERE ${where}`, params),
    ]);
    return successResponse({ affairs: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async adminCreate(data: any, adminId: string) {
    if (!data.title || !data.summary) throw new BadRequestException('Title and summary required');
    // Store type (prelims/mains/both) as the first exam_tag for easy filtering
    const examTagsWithType = data.examTags || [];
    const typeTag = data.type || 'prelims';
    // Always ensure the type is in exam_tags as first element
    const mergedTags = [typeTag, ...examTagsWithType.filter((t: string) => !['prelims','mains','both'].includes(t))];
    const result = await this.db.query(
      `INSERT INTO current_affairs (title, summary, full_content, category, source, date, is_important, exam_tags, tags, status, author, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [data.title, data.summary, data.fullContent, data.category, data.source, data.date||new Date().toISOString().split('T')[0], data.isImportant||false, mergedTags, data.tags||[], data.status||'draft', data.author, adminId]
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
    // Merge type into exam_tags so it persists
    const examTagsToSave = data.examTags !== undefined ? data.examTags : undefined;
    if (data.type || examTagsToSave !== undefined) {
      const typeTag = data.type || 'prelims';
      const otherTags = (examTagsToSave || []).filter((t: string) => !['prelims','mains','both'].includes(t));
      fields.push(`exam_tags=$${i++}`); vals.push([typeTag, ...otherTags]);
    }
    if (data.tags)     { fields.push(`tags=$${i++}`); vals.push(data.tags); }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE current_affairs SET ${fields.join(',')} WHERE id=$${i}`, [...vals, affairId]); }
    return successResponse(null, 'Article updated — live in app ✅');
  }

  async adminDelete(affairId: string) {
    await this.db.query(`DELETE FROM current_affairs WHERE id=$1`, [affairId]);
    return successResponse(null, 'Article deleted');
  }

  // ── CA MCQs ──────────────────────────────────────────────────────────
  async ensureCaMcqTable() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ca_mcqs (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        affair_id    UUID NOT NULL REFERENCES current_affairs(id) ON DELETE CASCADE,
        question     TEXT NOT NULL,
        option_a     TEXT NOT NULL,
        option_b     TEXT NOT NULL,
        option_c     TEXT NOT NULL,
        option_d     TEXT NOT NULL,
        correct      CHAR(1) NOT NULL CHECK (correct IN ('a','b','c','d','e')),
        option_e     TEXT NOT NULL DEFAULT '',
        explanation  TEXT,
        difficulty   VARCHAR(10) DEFAULT 'medium',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async getMcqs(affairId: string) {
    await this.ensureCaMcqTable();
    const rows = await this.db.query(
      `SELECT * FROM ca_mcqs WHERE affair_id=$1 ORDER BY created_at ASC`,
      [affairId]
    );
    return successResponse({ mcqs: rows });
  }

  async addMcq(affairId: string, data: any) {
    await this.ensureCaMcqTable();
    if (!data.question || !data.optionA || !data.optionB || !data.correct) {
      throw new BadRequestException('question, optionA, optionB and correct are required');
    }
    const row = await this.db.query(
      `INSERT INTO ca_mcqs (affair_id, question, option_a, option_b, option_c, option_d, option_e, correct, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [affairId, data.question, data.optionA||'', data.optionB||'', data.optionC||'',
       data.optionD||'', data.optionE||'',
       data.correct.toLowerCase(), data.explanation || '']
    );
    return successResponse({ mcq: row[0] }, 'MCQ added ✅');
  }

  async updateMcq(mcqId: string, data: any) {
    await this.ensureCaMcqTable();
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { question:'question', optionA:'option_a', optionB:'option_b',
      optionC:'option_c', optionD:'option_d', optionE:'option_e', correct:'correct',
      explanation:'explanation' };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[k]); }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    await this.db.query(`UPDATE ca_mcqs SET ${fields.join(',')} WHERE id=$${i}`, [...vals, mcqId]);
    return successResponse(null, 'MCQ updated ✅');
  }

  async deleteMcq(mcqId: string) {
    await this.ensureCaMcqTable();
    await this.db.query(`DELETE FROM ca_mcqs WHERE id=$1`, [mcqId]);
    return successResponse(null, 'MCQ deleted');
  }
}

@ApiTags('Current Affairs') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('current-affairs')
class CurrentAffairsController {
  constructor(private s: CurrentAffairsService) {}
  @Get() findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }
  @Get(':id') findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.findOne(id, r.user.id); }
  @Post(':id/bookmark') @HttpCode(200) toggleBookmark(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.toggleBookmark(id, r.user.id); }
  @Get(':id/mcqs') getMcqs(@Param('id', ParseUUIDPipe) id: string) { return this.s.getMcqs(id); }
}

@ApiTags('Admin — Current Affairs') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/current-affairs')
class AdminCurrentAffairsController {
  constructor(private s: CurrentAffairsService) {}
  @Get() @RequirePermission('current-affairs') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Post() @RequirePermission('current-affairs') @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.adminCreate(dto, r.admin.id); }
  @Put(':id') @RequirePermission('current-affairs') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.adminUpdate(id, dto); }
  @Delete(':id') @RequirePermission('current-affairs') remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.adminDelete(id); }
  // MCQ management
  @Get(':id/mcqs') @RequirePermission('current-affairs') getMcqs(@Param('id', ParseUUIDPipe) id: string) { return this.s.getMcqs(id); }
  @Post(':id/mcqs') @RequirePermission('current-affairs') @HttpCode(201) addMcq(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.addMcq(id, dto); }
  @Put('mcqs/:mcqId') @RequirePermission('current-affairs') updateMcq(@Param('mcqId', ParseUUIDPipe) mcqId: string, @Body() dto: any) { return this.s.updateMcq(mcqId, dto); }
  @Delete('mcqs/:mcqId') @RequirePermission('current-affairs') deleteMcq(@Param('mcqId', ParseUUIDPipe) mcqId: string) { return this.s.deleteMcq(mcqId); }
}

@Module({ controllers:[CurrentAffairsController, AdminCurrentAffairsController], providers:[CurrentAffairsService] })
export class CurrentAffairsModule {}

// ════════════════════════════════════════════════════════════
// JOBS MODULE
// ════════════════════════════════════════════════════════════
@Injectable()
class JobsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject('NOTIFICATION_SERVICE') @Optional() private readonly notifService?: { pushToAll: (title: string, body: string, data?: Record<string, string>) => Promise<void> },
  ) {}

  async onModuleInit() {
    await this.ensureColumns();
  }

  async findAll(query: any, userId: string) {
    const { page=1, limit=20, status='active', category, exam } = query;
    const offset = (page-1)*limit;
    const conditions = [`j.status=$1`], params: any[] = [status];
    if (category) { conditions.push(`j.category=$${params.length+1}`); params.push(category); }
    if (exam)     { conditions.push(`$${params.length+1}=ANY(j.exam_tags)`); params.push(exam); }
    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT
           j.id, j.title,
           j.organization                        AS department,
           j.category,
           j.total_posts,
           COALESCE(j.qualification,'')          AS qualification,
           COALESCE(j.age_limit,'')              AS age_limit,
           COALESCE(j.description,'')            AS description,
           COALESCE(j.brief_description,'')      AS brief_description,
           COALESCE(j.pdf_url,'')                AS pdf_url,
           COALESCE(j.application_link,'')       AS official_link,
           j.status,
           j.exam_tags,
           j.notification_date::TEXT             AS notification_date,
           j.notification_date::TEXT             AS apply_start_date,
           j.last_date::TEXT                     AS apply_end_date,
           j.exam_date::TEXT                     AS exam_date,
           j.created_at,
           -- Columns that don't exist in table yet — coalesce with safe defaults
           FALSE                                               AS is_featured,
FALSE                                               AS is_new,
CASE WHEN j.last_date <= NOW() + INTERVAL '3 days'
     THEN TRUE ELSE FALSE END                      AS is_urgent,
'{}'::TEXT[]                                       AS nearby_districts,
COALESCE(j.location,'')                                    AS location,
COALESCE(j.salary_range,'')                                AS salary_range,
           (SELECT TRUE FROM job_saves js
            WHERE js.user_id=$${params.length+1} AND js.job_id=j.id) AS is_saved
         FROM job_vacancies j WHERE ${where}
         ORDER BY j.last_date ASC LIMIT $${params.length+2} OFFSET $${params.length+3}`,
        [...params, userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies j WHERE ${where}`, params),
    ]);
    return successResponse({ jobs: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  /** Ensure location + salary_range + brief_description + pdf_url columns exist (run once on startup) */
  async ensureColumns() {
    await this.db.query(`
      ALTER TABLE job_vacancies 
        ADD COLUMN IF NOT EXISTS location          TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS salary_range      TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS brief_description TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS pdf_url           TEXT DEFAULT ''
    `).catch(() => {});  // ignore if already exists
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
    const { page=1, limit=20, search, category, status, sort } = query;
    const orderBy = sort === 'last_date_asc' ? 'j.last_date ASC' : sort === 'last_date_desc' ? 'j.last_date DESC' : sort === 'created_asc' ? 'j.created_at ASC' : 'j.created_at DESC';
    const offset = (page-1)*limit;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    if (search)   { conditions.push(`(j.title ILIKE $${params.length+1} OR j.organization ILIKE $${params.length+1})`); params.push(`%${search}%`); }
    if (category) { conditions.push(`j.category=$${params.length+1}`); params.push(category); }
    if (status)   { conditions.push(`j.status=$${params.length+1}`); params.push(status); }
    const where = conditions.join(' AND ');
    const [rows, countResult, govtCount, totalAllCount] = await Promise.all([
      this.db.query(`SELECT j.*, a.name AS created_by_name FROM job_vacancies j LEFT JOIN admin_users a ON j.created_by=a.id WHERE ${where} ORDER BY ${orderBy} LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies j WHERE ${where}`, params),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies WHERE category NOT IN ('Private','Part-time')`),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies`),
    ]);
    return successResponse({
      jobs: rows,
      govtJobsTotal: Number(govtCount[0].count),
      totalJobsAll: Number(totalAllCount[0].count),
    }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async adminCreate(data: any, adminId: string) {
    if (!data.title || !data.organization || !data.lastDate) throw new BadRequestException('Title, organization and last date required');
    const result = await this.db.query(
      `INSERT INTO job_vacancies (title, organization, category, total_posts, notification_date, last_date, exam_date, age_limit, qualification, application_link, description, brief_description, pdf_url, location, salary_range, exam_tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [data.title, data.organization, data.category, data.totalPosts||data.totalVacancies||0, data.notificationDate||null, data.lastDate, data.examDate||null, data.ageLimit||'', data.qualification||'', data.applicationLink||data.applicationUrl||'', data.description||'', data.briefDescription||'', data.pdfUrl||'', data.location||'', data.salary||data.salaryRange||'', data.examTags||[], adminId]
    );
    // 🔔 New job alert to all users (only if notification service available)
    this.notifService?.pushToAll(
      `📋 New Job: ${data.title}`,
      `${data.organization} · Last date: ${data.lastDate?.split('T')[0] || ''}`,
      { type: 'new_job', screen: 'jobs' }
    ).catch(() => {});

    return successResponse({ job: result[0] }, 'Job vacancy created — live in app ✅');
  }

  async adminUpdate(jobId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = {
      title:'title', organization:'organization', category:'category',
      totalPosts:'total_posts', totalVacancies:'total_posts',
      lastDate:'last_date', examDate:'exam_date', status:'status',
      applicationLink:'application_link', applicationUrl:'application_link',
      description:'description', briefDescription:'brief_description', pdfUrl:'pdf_url',
      location:'location', salary:'salary_range', salaryRange:'salary_range',
      ageLimit:'age_limit', qualification:'qualification',
    };
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
  pushToUser: any;

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
    const subscriptionId = subResult[0].id;

    // Create Razorpay order (amount in paise)
    let razorpayOrder: any = null;
    let activeRpKey = '';   // track whichever key we actually used for the return
    if (finalAmount > 0) {
      try {
        // Priority: env vars → payment_settings DB → warn
        let rpKey    = process.env.RAZORPAY_KEY_ID    || '';
        let rpSecret = process.env.RAZORPAY_KEY_SECRET || '';
        if (!rpKey || !rpSecret) {
          const rows = await this.db.query(
            `SELECT key, value FROM payment_settings WHERE key IN ('razorpay_key_id','razorpay_key_secret') AND value IS NOT NULL AND value != ''`
          ).catch(() => []);
          for (const r of rows) {
            if (r.key === 'razorpay_key_id')     rpKey    = r.value;
            if (r.key === 'razorpay_key_secret')  rpSecret = r.value;
          }
        }
        if (!rpKey || !rpSecret) {
          console.warn('Razorpay keys not configured — razorpayOrderId will be null');
        } else {
          activeRpKey = rpKey;
          const rpResponse = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Basic ' + Buffer.from(`${rpKey}:${rpSecret}`).toString('base64'),
            },
            body: JSON.stringify({
              amount:   finalAmount * 100,
              currency: 'INR',
              receipt:  `sub_${subscriptionId.substring(0,8)}`,
              notes:    { subscriptionId, userId, plan: data.plan },
            }),
          });
          razorpayOrder = await rpResponse.json();
          if (razorpayOrder.id) {
            await this.db.query(
              `UPDATE subscriptions SET razorpay_order_id=$1 WHERE id=$2`,
              [razorpayOrder.id, subscriptionId]
            );
          } else {
            // Log Razorpay error for debugging (e.g. bad credentials)
            console.error('Razorpay order creation error:', JSON.stringify(razorpayOrder));
          }
        }
      } catch (err: any) {
        console.error('Razorpay order creation failed:', err.message);
      }
    }

    return successResponse({
      subscriptionId,
      razorpayOrderId: razorpayOrder?.id || null,
      razorpayKeyId:   activeRpKey || null,   // return the key actually used, not empty env var
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

    // Verify Razorpay signature to ensure payment authenticity
    if (data.razorpaySignature && sub.razorpay_order_id) {
      const crypto = require('crypto');
      const expectedSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
        .update(`${sub.razorpay_order_id}|${data.transactionId}`)
        .digest('hex');
      if (expectedSig !== data.razorpaySignature) {
        // Log tamper attempt
        console.error(`PAYMENT TAMPER DETECTED: user=${userId} order=${sub.razorpay_order_id} payment=${data.transactionId}`);
        throw new BadRequestException('Payment signature verification failed');
      }
    }

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

    // 🔔 Subscription welcome push
    this.pushToUser(
      userId,
      '🎉 BPSCNotes Pro Activated!',
      `Your ${sub.plan} plan is live. Enjoy unlimited access + 🪙 ${plan.bonusCoins} bonus coins!`,
      { type: 'subscription', screen: 'courses' }
    ).catch(() => {});

    return successResponse({ bonusCoinsEarned: plan.bonusCoins }, '🎉 Subscription activated! Enjoy BPSCNotes Pro');
  }

  async getStatus(userId: string) {
    const result = await this.db.query(
      `SELECT id, plan, status, starts_at, ends_at, auto_renew, payment_method FROM subscriptions WHERE user_id=$1 AND status='active' AND ends_at>NOW() ORDER BY ends_at DESC LIMIT 1`,
      [userId]
    );
    return successResponse({ isActive: result.length > 0, subscription: result[0] || null });
  }

  // ── Razorpay Webhook Handler ─────────────────────────────────
  async handleRazorpayWebhook(req: any, body: any) {
    const crypto = require('crypto');

    // Verify webhook signature
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature     = req.headers['x-razorpay-signature'];
    if (webhookSecret && signature) {
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(body))
        .digest('hex');
      if (expected !== signature) {
        console.error('Razorpay webhook: invalid signature');
        return { status: 'invalid_signature' };
      }
    }

    const event   = body.event;
    const payment = body.payload?.payment?.entity;
    const orderId = payment?.order_id;

    if (!orderId) return { status: 'ignored' };

    // payment.captured — successful payment
    if (event === 'payment.captured') {
      const [sub] = await this.db.query(
        `SELECT * FROM subscriptions WHERE razorpay_order_id=$1 AND payment_status='pending'`,
        [orderId]
      );
      if (!sub) return { status: 'not_found' };

      // Idempotency guard
      const dup = await this.db.query(
        `SELECT id FROM subscriptions WHERE razorpay_payment_id=$1`, [payment.id]
      );
      if (dup.length) return { status: 'already_processed' };

      const plan   = this.PLANS[sub.plan];
      const endsAt = new Date();
      if (sub.plan === 'monthly')   endsAt.setMonth(endsAt.getMonth() + 1);
      if (sub.plan === 'quarterly') endsAt.setMonth(endsAt.getMonth() + 3);
      if (sub.plan === 'annual')    endsAt.setFullYear(endsAt.getFullYear() + 1);

      await this.db.query(
        `UPDATE subscriptions
         SET payment_status='success', status='active',
             payment_method=$1, upi_id=$2,
             razorpay_payment_id=$3, starts_at=NOW(), ends_at=$4, updated_at=NOW()
         WHERE id=$5`,
        [payment.method || 'upi', payment.vpa || null, payment.id, endsAt, sub.id]
      );

      // Bonus coins
      if (plan?.bonusCoins > 0) {
        await this.db.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [plan.bonusCoins, sub.user_id]);
        const [bal] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [sub.user_id]);
        await this.db.query(
          `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
           VALUES ($1,'earned',$2,'Subscription bonus coins','subscription_bonus',$3)`,
          [sub.user_id, plan.bonusCoins, bal.coins]
        );
      }

      await this.cache.del(`user:${sub.user_id}`);
      console.log(`Webhook: subscription ${sub.id} activated for user ${sub.user_id}`);
    }

    // payment.failed
    if (event === 'payment.failed') {
      await this.db.query(
        `UPDATE subscriptions SET payment_status='failed', status='failed', updated_at=NOW()
         WHERE razorpay_order_id=$1 AND payment_status='pending'`,
        [orderId]
      );
    }

    return { status: 'ok' };
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
    // Map camelCase → snake_case columns (handles isActive→is_active automatically)
    const colMap: Record<string, string> = {
      isActive: 'is_active', maxUses: 'max_uses', expiresAt: 'expires_at', value: 'value'
    };
    for (const [camel, snake] of Object.entries(colMap)) {
      const val = data[camel] !== undefined ? data[camel] : data[snake];
      if (val !== undefined) { fields.push(`${snake}=$${i++}`); vals.push(val); }
    }
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
  @Post('create')   @HttpCode(200) create(@Req() r: any, @Body() dto: any)   { return this.s.initiate(r.user.id, dto); }  // alias for Razorpay flow
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
  
        const serviceAccountPath =
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        '/app/firebase-service-account.json';
      
      console.log('Firebase path:', serviceAccountPath);
      
  
        admin.initializeApp({
          credential: admin.credential.cert(
            require(serviceAccountPath)
          ),
        });
  
        this.firebaseInitialized = true;
  
        console.log('✅ Firebase initialized');
  
      } else {
        this.firebaseInitialized = true;
      }
  
    } catch (err: any) {
      console.error(
        '❌ Firebase initialization failed:',
        err.message
      );
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
    console.log('==== PUSH DEBUG ====');
console.log('firebaseInitialized:', this.firebaseInitialized);
console.log('users count:', users.length);
    if (this.firebaseInitialized) {
      const tokens = users.map((u: any) => u.fcm_token).filter(Boolean);
      console.log('tokens count:', tokens.length);
console.log('sample token:', tokens[0]);
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
            console.error('FCM FULL ERROR:', err);
            // console.error('FCM error:', err.message);
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

    // FIX: Also pull broadcast notifications (target='all') that may not have a user_notifications row
    // This happens when admin sends before this user created their account, or due to batch insert failures
    // Strategy: union user_notifications (personal) with 'all'/'free'/'pro' broadcasts
    const [notifs, unread] = await Promise.all([
      this.db.query(
        `SELECT
           COALESCE(un.id::text, n.id::text)        AS id,
           COALESCE(un.title, n.title)               AS title,
           COALESCE(un.body, n.body)                 AS body,
           n.type,
           COALESCE(un.is_read, FALSE)               AS is_read,
           COALESCE(un.created_at, n.created_at)     AS created_at
         FROM notifications n
         LEFT JOIN user_notifications un
           ON un.notification_id = n.id AND un.user_id = $1
         WHERE n.status = 'sent'
           AND (
             un.user_id = $1
             OR n.target = 'all'
             OR (n.target = 'pro' AND EXISTS(
               SELECT 1 FROM subscriptions s
               WHERE s.user_id=$1 AND s.status='active' AND s.ends_at > NOW()
             ))
             OR (n.target = 'free' AND NOT EXISTS(
               SELECT 1 FROM subscriptions s
               WHERE s.user_id=$1 AND s.status='active' AND s.ends_at > NOW()
             ))
           )
         ORDER BY COALESCE(un.created_at, n.created_at) DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(*) FROM user_notifications WHERE user_id=$1 AND is_read=FALSE`, [userId]
      ),
    ]);

    return successResponse({ notifications: notifs, unreadCount: parseInt(unread[0].count) }, 'Success',
      paginationMeta(0, page, limit));
  }

  // ── Direct push helpers (called by other modules) ──────────
  async pushToUser(userId: string, title: string, body: string, data: Record<string, string> = {}) {
    const rows = await this.db.query(
      `SELECT fcm_token, notification_enabled FROM users WHERE id=$1 AND fcm_token IS NOT NULL LIMIT 1`,
      [userId]
    );
    const user  = rows[0];
    const token = user?.fcm_token;

    // ── Always save to user_notifications so inbox is populated ──
    // This runs regardless of FCM success/failure and notification_enabled setting
    // (user should still see past notifications in-app even if push was disabled)
    try {
      // Insert a notifications record (system/trigger type — no admin user)
      const [notifRow] = await this.db.query(
        `INSERT INTO notifications (title, body, type, target, data, status, sent_at, created_by)
         VALUES ($1, $2, $3, 'user', $4, 'sent', NOW(), NULL)
         RETURNING id`,
        [title, body, data.type || 'system', JSON.stringify(data)]
      );
      const notifId = notifRow?.id;

      if (notifId) {
        await this.db.query(
          `INSERT INTO user_notifications (user_id, notification_id, title, body)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [userId, notifId, title, body]
        );
      }
    } catch (dbErr: any) {
      console.error('pushToUser DB insert failed:', dbErr.message);
    }

    // ── FCM push (only if user has token and notifications enabled) ──
    if (!token || !user?.notification_enabled || !admin.apps.length) return false;
    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
        data,
        android: { priority: 'high', notification: { channelId: data.type || 'general' } },
      });
      return true;
    } catch (err: any) {
      console.error('FCM push failed:', err.message);
      return false;
    }
  }

  async pushToAll(title: string, body: string, data: Record<string, string> = {}) {
    const tokens = await this.db.query(
      `SELECT fcm_token FROM users WHERE notification_enabled=TRUE AND fcm_token IS NOT NULL AND status='active' LIMIT 2000`
    );
    const fcmTokens = tokens.map((t: any) => t.fcm_token).filter(Boolean);
    if (!fcmTokens.length || !admin.apps.length) return 0;
    let sent = 0;
    for (let i = 0; i < fcmTokens.length; i += 500) {
      try {
        const res = await admin.messaging().sendEachForMulticast({
          tokens: fcmTokens.slice(i, i + 500),
          notification: { title, body },
          data,
          android: { priority: 'high' },
        });
        sent += res.successCount;
      } catch (err: any) {
        console.error('FCM multicast failed:', err.message);
      }
    }
    return sent;
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

@Module({
  imports:   [ConfigModule],
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    NotificationService,
    { provide: 'NOTIFICATION_SERVICE', useExisting: NotificationService },
  ],
  exports: [NotificationService, 'NOTIFICATION_SERVICE'],
})
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

  async createRule(data: any) {
    const { action, description, coinsAwarded, maxPerDay, isActive } = data;
    if (!action || !description) throw new BadRequestException('action and description are required');
    const [existing] = await this.db.query(`SELECT id FROM coin_rules WHERE action=$1`, [action]);
    if (existing) {
      await this.db.query(
        `UPDATE coin_rules SET description=$1, coins_awarded=$2, max_per_day=$3, is_active=$4, updated_at=NOW() WHERE action=$5`,
        [description, coinsAwarded ?? 5, maxPerDay ?? 1, isActive !== false, action]
      );
      return successResponse(null, 'Coin rule updated');
    }
    const [row] = await this.db.query(
      `INSERT INTO coin_rules (action, description, coins_awarded, max_per_day, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [action, description, coinsAwarded ?? 5, maxPerDay ?? 1, isActive !== false]
    );
    return successResponse({ rule: row }, 'Coin rule created ✅');
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

  async deleteRule(ruleId: string) {
    await this.db.query(`DELETE FROM coin_rules WHERE id=$1`, [ruleId]);
    return successResponse(null, 'Coin rule deleted');
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

// NOTE: AdminCoinsController must be declared BEFORE the @Module that references it
@ApiTags('Admin — Coins') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/coins')
class AdminCoinsController {
  constructor(private s: CoinsService) {}
  @Get('rules')        @RequirePermission('coins') getRules()    { return this.s.getRules(); }
  @Post('rules')       @RequirePermission('coins') @HttpCode(HttpStatus.CREATED)
    createRule(@Body() dto: any) { return this.s.createRule(dto); }
    @Put('rules/:id')
    @RequirePermission('coins')
    updateRule(
      @Param('id') id: string,
      @Body() dto: any
    ) {
      return this.s.updateRule(id, dto);
    }
  @Delete('rules/:id') @RequirePermission('coins') @HttpCode(HttpStatus.OK)
  deleteRule(
    @Param('id') id: string
  ) { return this.s.deleteRule(id); }
  @Get('top-earners')  @RequirePermission('coins') getTopEarners() { return this.s.getTopEarners(); }
}

// ⚠️ @Module MUST be directly above the class it decorates
@Module({ imports: [ConfigModule], controllers: [CoinsController, AdminCoinsController], providers: [CoinsService] })
export class CoinsModule {}