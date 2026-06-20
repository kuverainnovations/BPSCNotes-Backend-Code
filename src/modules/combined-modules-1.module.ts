import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, Res, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ConflictException,
  UseGuards, ParseUUIDPipe, OnModuleInit, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject , Optional } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { extname, join } from 'path';
import type { Response } from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sanitizeHtml = require('sanitize-html');

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../common/guards';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../common/utils/response.util';
import { streamArticlePdf } from '../common/utils/article-pdf-generator.util';
import { AuthService } from './auth/auth.module';
import { ensureFirebaseAdmin } from '../common/firebase/firebase-admin';

// Allowed HTML for Current Affairs rich content — matches what the admin
// TipTap editor can produce. Anything else (script, iframe, on* handlers,
// style tags, etc.) is stripped before it ever reaches the DB, since this
// HTML is later rendered inside a WebView on Android.
const CA_SANITIZE_OPTIONS = {
  allowedTags: [
    'p','br','strong','em','u','s','span','a','ul','ol','li','mark',
    'h1','h2','h3','blockquote','img','table','thead','tbody','tr','th','td',
  ],
  allowedAttributes: {
    a:     ['href','target','rel'],
    img:   ['src','alt','style'],
    span:  ['style'],
    mark:  ['style'],
    p:     ['style'],
    h1: ['style'], h2: ['style'], h3: ['style'],
    table: ['style'], td: ['style'], th: ['style'],
  },
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(/],
      'background-color': [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(/],
      'text-align': [/^left$|^center$|^right$/],
      width: [/^\d+(%|px)$/],
      display: [/^block$|^inline-block$/],
      margin: [/^[\d\sa-z%]+$/],
    },
  },
  allowedSchemes: ['http', 'https'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
  },
};

function sanitizeCaContent(html: string | undefined | null): string {
  if (!html) return '';
  return sanitizeHtml(html, CA_SANITIZE_OPTIONS);
}

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
    if (exam) {
      if (exam === 'prelims' || exam === 'mains') {
        conditions.push(`($${params.length+1}=ANY(ca.exam_tags) OR 'both'=ANY(ca.exam_tags))`);
        params.push(exam);
      } else {
        conditions.push(`$${params.length+1}=ANY(ca.exam_tags)`);
        params.push(exam);
      }
    }
    if (important === 'true') conditions.push(`ca.is_important=TRUE`);
    const where = conditions.join(' AND ');

    const cacheKey = `affairs:${where}:${params.join(',')}:${page}:${limit}:${userId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT ca.id,ca.title,ca.summary,ca.category,ca.date,ca.is_important,ca.exam_tags,ca.tags,ca.view_count,ca.bookmark_count,
           COALESCE(ca.read_time, 1) AS read_time,
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
    if (exam) {
      if (exam === 'prelims' || exam === 'mains') {
        conditions.push(`($${params.length+1}=ANY(ca.exam_tags) OR 'both'=ANY(ca.exam_tags))`);
        params.push(exam);
      } else {
        conditions.push(`$${params.length+1}=ANY(ca.exam_tags)`);
        params.push(exam);
      }
    }
    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT ca.id, ca.title, ca.summary, ca.full_content, ca.category,
                ca.date, ca.is_important, ca.exam_tags, ca.tags, ca.status,
                ca.view_count, ca.bookmark_count, ca.created_at, ca.read_time,
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
      `INSERT INTO current_affairs (title, summary, full_content, category, source, date, is_important, exam_tags, tags, status, author, read_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [data.title, data.summary, sanitizeCaContent(data.fullContent), data.category, data.source, data.date||new Date().toISOString().split('T')[0], data.isImportant||false, mergedTags, data.tags||[], data.status||'draft', data.author, data.readTime||1, adminId]
    );
    return successResponse({ affair: result[0] }, 'Article created — live in app ✅');
  }

  async adminUpdate(affairId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', summary:'summary', fullContent:'full_content', category:'category', source:'source', date:'date', isImportant:'is_important', status:'status', readTime:'read_time' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) {
        const val = key === 'fullContent' ? sanitizeCaContent(data[key]) : data[key];
        fields.push(`${col}=$${i++}`); vals.push(val);
      }
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

  async logActivity(userId: string, activityType: string, durationSecs: number) {
    // Ensure table exists — migration-safe
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ca_activity (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        activity_type VARCHAR(50) NOT NULL DEFAULT 'ca_reading',
        duration_secs INT NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(() => {});

    const safeDuration = Math.max(0, Math.min(durationSecs, 3600)); // cap at 1hr
    if (safeDuration < 10) return successResponse(null, 'Too short to log');

    await this.db.query(
      `INSERT INTO ca_activity (user_id, activity_type, duration_secs)
       VALUES ($1, $2, $3)`,
      [userId, activityType || 'ca_reading', safeDuration]
    );

    // Add to total_study_minutes on users table too
    const durationMins = Math.ceil(safeDuration / 60);
    await this.db.query(
      `UPDATE users SET total_study_minutes = total_study_minutes + $1 WHERE id=$2`,
      [durationMins, userId]
    );
    await this.cache.del(`user:${userId}`);
    // Group Study tier stats (Study Hours requirement / StatPills) are
    // cached and otherwise wouldn't reflect this change.
    await this.cache.del(`user_tier:${userId}`);

    return successResponse({ logged: true, durationSecs: safeDuration });
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

  // ── PDF export ───────────────────────────────────────────────
  async streamPdf(affairId: string, res: Response, uploadDir: string) {
    const result = await this.db.query(
      `SELECT title, category, date, source, tags, full_content FROM current_affairs
       WHERE id=$1 AND status='published'`,
      [affairId]
    );
    if (!result.length) throw new NotFoundException('Article not found');
    const row = result[0];
    await streamArticlePdf(res, {
      title: row.title,
      category: row.category,
      date: row.date,
      source: row.source,
      tags: row.tags || [],
      fullContentHtml: row.full_content || '',
    }, uploadDir);
  }

  // ── Negative marking config for Current Affairs / Practice MCQs ────────
  // Current Affairs MCQs (ca_mcqs) are lightweight practice questions
  // attached to an article — they don't go through the per-test
  // create/edit flow that `quizzes` has, so instead of a per-article
  // setting, this is one global toggle the admin sets once and it applies
  // to every CA MCQ practice session in the app. Reuses the same
  // app_settings key-value table the coin economy config uses.
  private static readonly MCQ_CONFIG_KEYS = [
    'ca_mcq_negative_marking_enabled',
    'ca_mcq_marks_per_correct',
    'ca_mcq_marks_per_wrong',
  ];

  async getMcqMarkingConfig() {
    const cacheKey = 'ca_mcq:marking_config';
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.db.query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [CurrentAffairsService.MCQ_CONFIG_KEYS]
    ).catch(() => []);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;

    const config = {
      negativeMarkingEnabled: map['ca_mcq_negative_marking_enabled'] === 'true',
      marksPerCorrect:        parseFloat(map['ca_mcq_marks_per_correct']) || 1,
      marksPerWrong:           parseFloat(map['ca_mcq_marks_per_wrong'])   || 0,
    };
    const result = successResponse({ config });
    await this.cache.set(cacheKey, result, 300);
    return result;
  }

  async updateMcqMarkingConfig(data: any, adminId: string) {
    const negativeMarkingEnabled = data.negativeMarkingEnabled === true;
    const marksPerCorrect = Number.isFinite(+data.marksPerCorrect) && +data.marksPerCorrect > 0 ? +data.marksPerCorrect : 1;
    const marksPerWrong   = Number.isFinite(+data.marksPerWrong)   && +data.marksPerWrong   >= 0 ? +data.marksPerWrong   : 0;

    const entries: [string, string][] = [
      ['ca_mcq_negative_marking_enabled', String(negativeMarkingEnabled)],
      ['ca_mcq_marks_per_correct', String(marksPerCorrect)],
      ['ca_mcq_marks_per_wrong', String(marksPerWrong)],
    ];
    for (const [key, value] of entries) {
      await this.db.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=NOW()`,
        [key, value, adminId]
      );
    }
    await this.cache.del('ca_mcq:marking_config');
    return successResponse(
      { negativeMarkingEnabled, marksPerCorrect, marksPerWrong },
      'Negative marking settings updated ✅'
    );
  }

  // ── Inline content image upload (for the rich text editor) ─────────────
  // Local disk storage, same pattern as CoursesService.uploadLessonFile —
  // no Cloudinary transform needed here since these are inline article
  // images, not a fixed-size thumbnail.
  async uploadContentImage(file: Express.Multer.File, baseUrl: string) {
    const uploadDir = './uploads';
    const now = new Date();
    const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dest = join(uploadDir, 'current-affairs', subDir);
    fs.mkdirSync(dest, { recursive: true });

    const uniqueId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const safeExt  = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
    const fileName = `${Date.now()}_${uniqueId}${safeExt}`;
    const fullPath = join(dest, fileName);

    fs.writeFileSync(fullPath, file.buffer);

    const relativePath = `uploads/current-affairs/${subDir}/${fileName}`;
    return successResponse({ url: `${baseUrl}/${relativePath}` });
  }
}

@ApiTags('Current Affairs') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('current-affairs')
class CurrentAffairsController {
  constructor(private s: CurrentAffairsService) {}
  @Get() findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }
  // Literal route — MUST stay above @Get(':id') or NestJS would match
  // "mcq-config" as the :id param and 400 on ParseUUIDPipe.
  @Get('mcq-config') getMcqMarkingConfig() { return this.s.getMcqMarkingConfig(); }
  @Get(':id') findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.findOne(id, r.user.id); }
  @Post(':id/bookmark') @HttpCode(200) toggleBookmark(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.toggleBookmark(id, r.user.id); }
  @Get(':id/mcqs') getMcqs(@Param('id', ParseUUIDPipe) id: string) { return this.s.getMcqs(id); }
  // @Res({ passthrough: false }) hands the response fully to us, bypassing
  // the global TransformInterceptor (which would otherwise wrap the PDF
  // bytes in the standard {success,message,data} JSON envelope).
  @Get(':id/pdf')
  async downloadPdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: false }) res: Response) {
    await this.s.streamPdf(id, res, './uploads');
  }
  @Post('log-activity') @HttpCode(200) logActivity(@Body() body: any, @Req() r: any) {
    return this.s.logActivity(r.user.id, body.activityType, body.durationSecs);
  }
}

@ApiTags('Admin — Current Affairs') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/current-affairs')
class AdminCurrentAffairsController {
  constructor(private s: CurrentAffairsService, private config: ConfigService) {}
  @Get() @RequirePermission('current-affairs') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  // Literal routes — MUST stay above @Put(':id')/@Delete(':id') or NestJS
  // would match "mcq-config" as the :id param (this project's established
  // convention: literal segments before dynamic ones).
  @Get('mcq-config') @RequirePermission('current-affairs') getMcqMarkingConfig() { return this.s.getMcqMarkingConfig(); }
  @Put('mcq-config') @RequirePermission('current-affairs') updateMcqMarkingConfig(@Body() dto: any, @Req() r: any) { return this.s.updateMcqMarkingConfig(dto, r.admin.id); }
  @Post() @RequirePermission('current-affairs') @HttpCode(201) create(@Body() dto: any, @Req() r: any) { return this.s.adminCreate(dto, r.admin.id); }
  // Inline image upload for the rich text editor (paste/insert) — must stay
  // a literal route; NestJS matches top-down and a later `:id` PUT/DELETE
  // wouldn't conflict here since the HTTP methods differ, but kept up top
  // next to `create` to match this controller's existing literal-before-
  // dynamic convention.
  @Post('upload-image')
  @RequirePermission('current-affairs')
  @UseInterceptors(FileInterceptor('image', {
    storage: require('multer').memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
    fileFilter: (_req: any, file: any, cb: any) => {
      const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (ALLOWED.includes(file.mimetype)) return cb(null, true);
      cb(new BadRequestException(`File type not allowed: ${file.mimetype}`), false);
    },
  }))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No image provided');
    const baseUrl = this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in';
    return this.s.uploadContentImage(file, baseUrl);
  }
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
    `).catch(() => {});
    await this.db.query(`
      ALTER TABLE current_affairs
        ADD COLUMN IF NOT EXISTS read_time INTEGER DEFAULT 1
    `).catch(() => {});
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
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject('NOTIFICATION_SERVICE') @Optional() private readonly notifService?: {
      pushToUser: (userId: string, title: string, body: string, data?: Record<string, string>) => Promise<boolean>;
    },
  ) {}

  // Reads a value from app_settings (coin_to_inr_rate,
  // max_coin_discount_pct_subscription, coin_system_enabled), falling
  // back to a default if unset. Mirrors CoursesModule's helper so
  // subscriptions and course/material purchases share one source of
  // truth for the coin economy (admin "Coins" page).
  private async getSetting(key: string, fallback: string): Promise<string> {
    const [row] = await this.db.query(
      `SELECT value FROM app_settings WHERE key=$1 LIMIT 1`, [key]
    ).catch(() => []);
    return row?.value ?? fallback;
  }

  // Shares the 'coin:system_enabled' cache key with AuthService.awardCoins
  // so the master switch (Coins page → Economy) is checked consistently
  // and cheaply across both earning and spending paths.
  private async isCoinSystemEnabled(): Promise<boolean> {
    let v = await this.cache.get<string>('coin:system_enabled');
    if (v === undefined || v === null) {
      v = await this.getSetting('coin_system_enabled', 'true');
      await this.cache.set('coin:system_enabled', v, 60);
    }
    return v !== 'false';
  }

  async getPlans() {
    const coinToInrRate        = parseFloat(await this.getSetting('coin_to_inr_rate', '1'));
    const maxCoinDiscountSub    = parseInt(await this.getSetting('max_coin_discount_pct_subscription', '30'), 10);
    const maxCoinDiscountCourse = parseInt(await this.getSetting('max_coins_per_purchase', '50'), 10);
    return successResponse({
      plans: [
        { id:'monthly',   name:'Monthly',   price:199, originalPrice:299,  duration:'1 Month',   billingCycle:'Billed monthly',  bonusCoins:20,  savings:100 },
        { id:'quarterly', name:'Quarterly', price:499, originalPrice:899,  duration:'3 Months',  billingCycle:'₹166/month',      bonusCoins:60,  savings:400, isPopular:true },
        { id:'annual',    name:'Annual',    price:1499,originalPrice:2999, duration:'12 Months', billingCycle:'₹125/month',      bonusCoins:200, savings:1500 },
      ],
      coinValueInr:        coinToInrRate,
      maxCoinDiscountSub:  maxCoinDiscountSub,
      maxCoinDiscountCourse: maxCoinDiscountCourse,
    });
  }

  async initiate(userId: string, data: any) {
    const plan = this.PLANS[data.plan];
    if (!plan) throw new BadRequestException('Invalid plan');
    const { price } = plan;
    const coinSystemEnabled = (await this.getSetting('coin_system_enabled', 'true')) !== 'false';
    const coinValue    = parseFloat(await this.getSetting('coin_to_inr_rate', '1'));
    const maxCoinPct   = parseInt(await this.getSetting('max_coin_discount_pct_subscription', '30'), 10);
    const userCoins    = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0]?.coins || 0;
    const maxCoinDisc  = Math.floor(price * maxCoinPct / 100);
    const coinsToUse   = coinSystemEnabled
      ? Math.min(data.coinsToUse || 0, userCoins, Math.floor(maxCoinDisc / coinValue))
      : 0;
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

    // Verify Razorpay signature — mandatory, no bypass
    const rpSecret = process.env.RAZORPAY_KEY_SECRET;
    if (!rpSecret) {
      throw new BadRequestException('Payment gateway not configured. Contact support.');
    }
    if (!data.razorpaySignature || !sub.razorpay_order_id) {
      throw new BadRequestException('Missing payment verification data.');
    }
    const crypto = require('crypto');
    const expectedSig = crypto
      .createHmac('sha256', rpSecret)
      .update(`${sub.razorpay_order_id}|${data.transactionId}`)
      .digest('hex');
    if (expectedSig !== data.razorpaySignature) {
      console.error(`PAYMENT TAMPER DETECTED: user=${userId} order=${sub.razorpay_order_id} payment=${data.transactionId}`);
      throw new BadRequestException('Payment signature verification failed');
    }

    const endsAt = new Date();
    if (sub.plan === 'monthly')   endsAt.setMonth(endsAt.getMonth() + 1);
    if (sub.plan === 'quarterly') endsAt.setMonth(endsAt.getMonth() + 3);
    if (sub.plan === 'annual')    endsAt.setFullYear(endsAt.getFullYear() + 1);

    // ── Atomic activation: all-or-nothing ───────────────────────
    // Using raw SQL transaction so the subscription status, coin deduction,
    // coupon increment, and bonus award all commit together or all roll back.
    const coinSystemEnabled = plan.bonusCoins > 0 && await this.isCoinSystemEnabled();

    await this.db.query('BEGIN');
    try {
      // 1. Activate subscription
      await this.db.query(
        `UPDATE subscriptions SET payment_status='success', status='active', payment_method=$1, upi_id=$2,
         razorpay_payment_id=$3, starts_at=NOW(), ends_at=$4, updated_at=NOW() WHERE id=$5`,
        [data.paymentMethod||'upi', data.upiId||null, data.transactionId, endsAt, subId]
      );

      // 2. Deduct coins used toward discount
      if (sub.coins_used > 0) {
        await this.db.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [sub.coins_used, userId]);
        const bal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0].coins;
        await this.db.query(
          `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance) VALUES ($1,'spent',$2,'Subscription payment discount','subscription_payment',$3)`,
          [userId, sub.coins_used, bal]
        );
      }

      // 3. Increment coupon usage
      if (sub.coupon_code) {
        await this.db.query(`UPDATE coupons SET used_count=used_count+1 WHERE code=$1`, [sub.coupon_code]);
      }

      // 4. Award bonus coins
      if (coinSystemEnabled) {
        await this.db.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [plan.bonusCoins, userId]);
        const newBal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0].coins;
        await this.db.query(
          `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance) VALUES ($1,'earned',$2,'Subscription bonus coins','subscription_bonus',$3)`,
          [userId, plan.bonusCoins, newBal]
        );
      }

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }

    await this.cache.del(`user:${userId}`);

    // 🔔 Subscription welcome push
    this.notifService?.pushToUser(
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

      await this.db.query('BEGIN');
      try {
        await this.db.query(
          `UPDATE subscriptions
           SET payment_status='success', status='active',
               payment_method=$1, upi_id=$2,
               razorpay_payment_id=$3, starts_at=NOW(), ends_at=$4, updated_at=NOW()
           WHERE id=$5`,
          [payment.method || 'upi', payment.vpa || null, payment.id, endsAt, sub.id]
        );

        if (plan?.bonusCoins > 0 && await this.isCoinSystemEnabled()) {
          await this.db.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [plan.bonusCoins, sub.user_id]);
          const [bal] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [sub.user_id]);
          await this.db.query(
            `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
             VALUES ($1,'earned',$2,'Subscription bonus coins','subscription_bonus',$3)`,
            [sub.user_id, plan.bonusCoins, bal.coins]
          );
        }

        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK');
        console.error(`Webhook: transaction rollback for sub ${sub.id}:`, err);
        return { status: 'error' };
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
    this.firebaseInitialized = ensureFirebaseAdmin();
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
    if (data.target === 'pro' || data.target === 'premium') {
      userQuery += ` AND id IN (SELECT user_id FROM subscriptions WHERE status='active' AND ends_at>NOW())`;
    } else if (data.target === 'free') {
      userQuery += ` AND id NOT IN (SELECT user_id FROM subscriptions WHERE status='active' AND ends_at>NOW())`;
    } else if (data.target === 'inactive') {
      userQuery += ` AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '7 days')`;
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
           n.data,
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

  async getUnreadCount(userId: string) {
    const rows = await this.db.query(
      `SELECT COUNT(*) FROM user_notifications WHERE user_id=$1 AND is_read=FALSE`,
      [userId]
    );
    return successResponse({ count: parseInt(rows[0].count) });
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

      // Broadcast notifications ('all'/'free'/'pro' targets) may not have a
      // user_notifications row for this user yet — getUserNotifications()
      // surfaces them via a LEFT JOIN with is_read defaulting to FALSE, so
      // without a row they'd appear unread forever. Create read rows for
      // any such broadcasts the user is eligible to see.
      await this.db.query(`
        INSERT INTO user_notifications (user_id, notification_id, title, body, is_read, read_at)
        SELECT $1, n.id, n.title, n.body, TRUE, NOW()
        FROM notifications n
        WHERE n.status = 'sent'
          AND NOT EXISTS (SELECT 1 FROM user_notifications un WHERE un.user_id=$1 AND un.notification_id=n.id)
          AND (
            n.target = 'all'
            OR (n.target = 'pro' AND EXISTS(
              SELECT 1 FROM subscriptions s WHERE s.user_id=$1 AND s.status='active' AND s.ends_at > NOW()
            ))
            OR (n.target = 'free' AND NOT EXISTS(
              SELECT 1 FROM subscriptions s WHERE s.user_id=$1 AND s.status='active' AND s.ends_at > NOW()
            ))
          )
      `, [userId]);
    }
    return successResponse(null, 'Marked as read');
  }

  async findAllAdmin(query: any) {
    const [result, stats] = await Promise.all([
      this.db.query(
        `SELECT n.*, a.name AS created_by_name FROM notifications n LEFT JOIN admin_users a ON n.created_by=a.id ORDER BY n.created_at DESC LIMIT 50`
      ),
      this.db.query(
        `SELECT
           COALESCE(SUM(total_sent),0)::int    AS total_sent,
           COALESCE(SUM(total_opened),0)::int  AS total_opened,
           COUNT(*) FILTER (WHERE status='scheduled')::int AS scheduled,
           COUNT(*)::int                       AS total_records
         FROM notifications`
      ),
    ]);
    return successResponse({ notifications: result, stats: stats[0] });
  }
}

@ApiTags('Notifications') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('notifications')
class NotificationsController {
  constructor(private s: NotificationService) {}
  @Get() getUserNotifs(@Query() q: any, @Req() r: any) { return this.s.getUserNotifications(r.user.id, q); }
  /** GET /notifications/unread-count — fast single COUNT query, no list fetch */
  @Get('unread-count') getUnreadCount(@Req() r: any) { return this.s.getUnreadCount(r.user.id); }
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