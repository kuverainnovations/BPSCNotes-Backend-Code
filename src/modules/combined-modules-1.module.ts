import * as CashfreeUtil from '../common/utils/cashfree.util';
import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, Res, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ConflictException,
  UseGuards, ParseUUIDPipe, OnModuleInit, UseInterceptors, UploadedFile,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(/],
      'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(/],
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

// Headline/Summary only ever load inline-mark TipTap extensions (bold,
// color, highlight, link — no headings/lists/images/tables), but the
// server shouldn't trust that client-side restriction alone — anyone
// hitting the API directly could post arbitrary HTML. Strip down to the
// same inline-only allowlist server-side too.
const CA_SANITIZE_OPTIONS_INLINE = {
  allowedTags: ['strong', 'em', 'u', 's', 'span', 'a', 'mark'],
  allowedAttributes: CA_SANITIZE_OPTIONS.allowedAttributes,
  allowedStyles: CA_SANITIZE_OPTIONS.allowedStyles,
  allowedSchemes: CA_SANITIZE_OPTIONS.allowedSchemes,
  transformTags: CA_SANITIZE_OPTIONS.transformTags,
};

function sanitizeCaInline(html: string | undefined | null): string {
  if (!html) return '';
  return sanitizeHtml(html, CA_SANITIZE_OPTIONS_INLINE);
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
           (SELECT COUNT(*) FROM ca_mcqs m WHERE m.affair_id=ca.id)::int AS mcq_count,
           (SELECT TRUE FROM ca_mcq_attempts cma WHERE cma.user_id=$${params.length+1} AND cma.affair_id=ca.id LIMIT 1) AS mcq_attempted,
           (SELECT cma.final_score FROM ca_mcq_attempts cma WHERE cma.user_id=$${params.length+1} AND cma.affair_id=ca.id ORDER BY cma.attempted_at DESC LIMIT 1) AS mcq_last_score
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
      `SELECT ca.*, (SELECT TRUE FROM affairs_bookmarks WHERE user_id=$2 AND affair_id=ca.id) AS is_bookmarked,
         (SELECT TRUE FROM ca_mcq_attempts cma WHERE cma.user_id=$2 AND cma.affair_id=ca.id LIMIT 1) AS mcq_attempted,
         (SELECT cma.final_score FROM ca_mcq_attempts cma WHERE cma.user_id=$2 AND cma.affair_id=ca.id ORDER BY cma.attempted_at DESC LIMIT 1) AS mcq_last_score
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
    const { page=1, limit=20, status, date, search, category, exam, important } = query;
    const offset = (page-1)*Number(limit);
    const conditions = ['1=1'], params: any[] = [];
    if (status)   { conditions.push(`ca.status=$${params.length+1}`);     params.push(status); }
    if (date)     { conditions.push(`ca.date=$${params.length+1}`);        params.push(date); }
    if (category) { conditions.push(`ca.category=$${params.length+1}`);    params.push(category); }
    if (search)   { conditions.push(`(ca.title ILIKE $${params.length+1} OR ca.summary ILIKE $${params.length+1})`); params.push(`%${search}%`); }
    if (exam) {
      if (exam === 'prelims' || exam === 'mains') {
        conditions.push(`($${params.length+1}=ANY(ca.exam_tags) OR 'both'=ANY(ca.exam_tags))`);
        params.push(exam);
      } else {
        conditions.push(`$${params.length+1}=ANY(ca.exam_tags)`);
        params.push(exam);
      }
    }
    if (important === 'true' || important === true) conditions.push(`ca.is_important=TRUE`);
    const where = conditions.join(' AND ');

    // Build filtered-stats WHERE without the exam filter so we can count prelims/mains/important
    // across the same category+search+status slice the user is viewing.
    // This gives "stats for this filter context" rather than global unfiltered counts.
    const baseConditions = conditions.filter(c => !c.includes('exam_tags'));
    const baseWhere = baseConditions.join(' AND ');
    // baseParams = params without the exam value (always the last pushed param when exam is set)
    const baseParams = exam ? params.slice(0, -1) : [...params];

    const [rows, countResult, prelimsResult, mainsResult, importantResult] = await Promise.all([
      this.db.query(
        `SELECT ca.id, ca.title, ca.summary, ca.full_content, ca.key_points, ca.exam_relevance, ca.important_facts,
                ca.category, ca.date, ca.is_important, ca.exam_tags, ca.tags, ca.status,
                ca.view_count, ca.bookmark_count, ca.created_at, ca.read_time,
                ca.mcq_negative_marking_override, ca.mcq_marks_per_correct_override, ca.mcq_marks_per_wrong_override,
                (SELECT COUNT(*) FROM ca_mcqs m WHERE m.affair_id=ca.id)::int AS mcq_count
         FROM current_affairs ca
         WHERE ${where}
         ORDER BY ca.date DESC, ca.created_at DESC
         LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, Number(limit), offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM current_affairs ca WHERE ${where}`, params),
      // Prelims = articles tagged prelims OR both, within same base filters
      this.db.query(
        `SELECT COUNT(*) FROM current_affairs ca
         WHERE ${baseWhere} AND ('prelims'=ANY(ca.exam_tags) OR 'both'=ANY(ca.exam_tags))`,
        baseParams
      ),
      // Mains = articles tagged mains OR both, within same base filters
      this.db.query(
        `SELECT COUNT(*) FROM current_affairs ca
         WHERE ${baseWhere} AND ('mains'=ANY(ca.exam_tags) OR 'both'=ANY(ca.exam_tags))`,
        baseParams
      ),
      // Important = is_important=TRUE, within same base filters
      this.db.query(
        `SELECT COUNT(*) FROM current_affairs ca
         WHERE ${baseWhere} AND ca.is_important=TRUE`,
        baseParams
      ),
    ]);

    return successResponse({
      affairs:   rows,
      counts: {
        total:     parseInt(countResult[0].count),
        prelims:   parseInt(prelimsResult[0].count),
        mains:     parseInt(mainsResult[0].count),
        important: parseInt(importantResult[0].count),
      },
    }, 'Success', paginationMeta(parseInt(countResult[0].count), Number(page), Number(limit)));
  }

  async adminCreate(data: any, adminId: string) {
    if (!data.title || !data.summary) throw new BadRequestException('Title and summary required');
    // Store type (prelims/mains/both) as the first exam_tag for easy filtering
    const examTagsWithType = data.examTags || [];
    const typeTag = data.type || 'prelims';
    // Always ensure the type is in exam_tags as first element
    const mergedTags = [typeTag, ...examTagsWithType.filter((t: string) => !['prelims','mains','both'].includes(t))];
    const result = await this.db.query(
      `INSERT INTO current_affairs
         (title, summary, full_content, key_points, exam_relevance, important_facts,
          category, source, date, is_important, exam_tags, tags, status, author, read_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        sanitizeCaInline(data.title),
        sanitizeCaInline(data.summary),
        sanitizeCaContent(data.fullContent),
        data.keyPoints   ? sanitizeCaContent(data.keyPoints)   : null,
        data.examRelevance ? sanitizeCaContent(data.examRelevance) : null,
        data.importantFacts ? sanitizeCaContent(data.importantFacts) : null,
        data.category, data.source,
        data.date||new Date().toISOString().split('T')[0],
        data.isImportant||false, mergedTags, data.tags||[],
        data.status||'draft', data.author, data.readTime||1, adminId,
      ]
    );
    return successResponse({ affair: result[0] }, 'Article created — live in app ✅');
  }

  async adminUpdate(affairId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = {
      title:'title', summary:'summary', fullContent:'full_content',
      keyPoints:'key_points', examRelevance:'exam_relevance', importantFacts:'important_facts',
      category:'category', source:'source', date:'date', isImportant:'is_important',
      status:'status', readTime:'read_time',
    };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) {
        const val = (key === 'fullContent' || key === 'keyPoints' || key === 'examRelevance' || key === 'importantFacts')
          ? sanitizeCaContent(data[key])
          : (key === 'title' || key === 'summary') ? sanitizeCaInline(data[key])
          : data[key];
        fields.push(`${col}=$${i++}`); vals.push(val);
      }
    }
    // Per-article MCQ marking override — sits alongside the global config.
    // `mcqNegativeMarkingOverride === null` is the explicit "clear the
    // override, inherit global again" signal (distinct from `undefined`,
    // which means "this field wasn't part of the request at all").
    if (data.mcqNegativeMarkingOverride !== undefined) {
      fields.push(`mcq_negative_marking_override=$${i++}`); vals.push(data.mcqNegativeMarkingOverride);
      if (data.mcqNegativeMarkingOverride === null) {
        fields.push(`mcq_marks_per_correct_override=NULL`);
        fields.push(`mcq_marks_per_wrong_override=NULL`);
      } else {
        fields.push(`mcq_marks_per_correct_override=$${i++}`); vals.push(Number(data.mcqMarksPerCorrectOverride) || 1);
        fields.push(`mcq_marks_per_wrong_override=$${i++}`);   vals.push(Number(data.mcqMarksPerWrongOverride) || 0);
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
        hint         TEXT,
        explanation  TEXT,
        difficulty   VARCHAR(10) DEFAULT 'medium',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Idempotent: add hint column to existing tables that predate this change
    await this.db.query(`
      ALTER TABLE ca_mcqs ADD COLUMN IF NOT EXISTS hint TEXT
    `);
  }

  async getMcqs(affairId: string) {
    await this.ensureCaMcqTable();
    const rows = await this.db.query(
      `SELECT * FROM ca_mcqs WHERE affair_id=$1 ORDER BY created_at ASC`,
      [affairId]
    );
    const markingConfig = (await this.getEffectiveMcqMarkingConfig(affairId)).data.config;
    return successResponse({ mcqs: rows, markingConfig });
  }

  // Persists a CA MCQ practice result so the article list/detail can show
  // "attempted" + last score (mirrors quiz_attempts). Scored server-side
  // from the submitted answers rather than trusting a client-computed
  // score — the existing getMcqs() flow already sends correct answers to
  // the client up front (no real anti-cheat boundary for these low-stakes
  // practice questions), but a submission endpoint specifically should
  // still grade independently rather than accept an arbitrary number.
  async submitMcqAttempt(affairId: string, userId: string, dto: any) {
    await this.ensureCaMcqTable();
    const mcqs = await this.db.query(
      `SELECT id, correct, option_e FROM ca_mcqs WHERE affair_id=$1`,
      [affairId]
    );
    if (!mcqs.length) throw new NotFoundException('No questions found for this article');

    const cfg = (await this.getEffectiveMcqMarkingConfig(affairId)).data.config;
    const negEnabled       = cfg.negativeMarkingEnabled === true;
    const marksPerCorrect  = +cfg.marksPerCorrect || 1;
    const marksPerWrong    = +cfg.marksPerWrong   || 0;

    // Map of questionId -> submitted letter. A question simply absent from
    // this map (never tapped) is what "blank" means below — same semantics
    // as Android's `answers: Map<String,String>` with no entry for a
    // skipped question.
    const submitted: Record<string, string> = {};
    for (const a of (Array.isArray(dto?.answers) ? dto.answers : [])) {
      if (a && typeof a.questionId === 'string' && typeof a.answer === 'string') {
        submitted[a.questionId] = a.answer;
      }
    }

    // Mirrors computeCaMcqResults() in CaMcqQuizScreen.kt exactly — same
    // BPSC rule: correct=+1, wrong=-marksPerWrong, explicit "Option E / not
    // attempting"=0, but a truly blank question loses marks like wrong.
    const results = mcqs.map((q: any) => {
      const userAnswer      = submitted[q.id] ?? null;
      const optionEIsBlank  = !q.option_e || String(q.option_e).trim() === '';
      const isNotAttempting = userAnswer === 'e' && optionEIsBlank;
      const isBlank          = userAnswer === null;
      const isCorrect        = !isBlank && !isNotAttempting && userAnswer === q.correct;
      const marks = isNotAttempting ? 0
        : isCorrect ? marksPerCorrect
        : (negEnabled ? -marksPerWrong : 0);
      return { questionId: q.id, answer: userAnswer, isNotAttempting, isBlank, isCorrect, marks };
    });

    const correct      = results.filter((r: any) => r.isCorrect).length;
    const notAttempted = results.filter((r: any) => r.isNotAttempting).length;
    const blank          = results.filter((r: any) => r.isBlank && !r.isNotAttempting).length;
    const wrong           = results.length - correct - notAttempted - blank;
    const marksObtained  = correct * marksPerCorrect;
    const negativeMarks  = results.reduce((s: number, r: any) => s + (r.marks < 0 ? -r.marks : 0), 0);
    const finalScore       = results.reduce((s: number, r: any) => s + r.marks, 0);
    const totalMarks        = mcqs.length * marksPerCorrect;

    const attempt = await this.db.query(
      `INSERT INTO ca_mcq_attempts
         (user_id, affair_id, total_questions, correct_answers, wrong_answers, not_attempted_count, blank_count,
          negative_marking_enabled, marks_per_correct, marks_per_wrong,
          marks_obtained, negative_marks, final_score, total_marks, answers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, attempted_at`,
      [
        userId, affairId, mcqs.length, correct, wrong, notAttempted, blank,
        negEnabled, marksPerCorrect, marksPerWrong,
        marksObtained, negativeMarks, finalScore, totalMarks, JSON.stringify(results),
      ]
    );

    // findAll()'s list cache is keyed per-filter/page/user (120s TTL) and
    // isn't pattern-invalidated here — the attempted badge can lag up to
    // 120s behind a fresh submission. findOne() (detail) isn't cached, so
    // that one reflects immediately.

    return successResponse({
      attemptId:  attempt[0].id,
      attemptedAt: attempt[0].attempted_at,
      total: mcqs.length, correct, wrong, notAttempted, blank,
      negativeMarkingEnabled: negEnabled, marksPerCorrect, marksPerWrong,
      marksObtained, negativeMarks, finalScore, totalMarks,
    }, 'Attempt recorded');
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
      `INSERT INTO ca_mcqs (affair_id, question, option_a, option_b, option_c, option_d, option_e, correct, hint, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [affairId, data.question, data.optionA||'', data.optionB||'', data.optionC||'',
       data.optionD||'', data.optionE||'',
       data.correct.toLowerCase(), data.hint || '', data.explanation || '']
    );
    return successResponse({ mcq: row[0] }, 'MCQ added ✅');
  }

  async updateMcq(mcqId: string, data: any) {
    await this.ensureCaMcqTable();
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { question:'question', optionA:'option_a', optionB:'option_b',
      optionC:'option_c', optionD:'option_d', optionE:'option_e', correct:'correct',
      hint:'hint', explanation:'explanation' };
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
      `SELECT title, summary, category, date, source, tags, full_content, key_points, exam_relevance, important_facts FROM current_affairs
       WHERE id=$1 AND status='published'`,
      [affairId]
    );
    if (!result.length) throw new NotFoundException('Article not found');
    const row = result[0];
    // fullContentHtml is ONLY the main body — sections are passed separately
    // so the PDF generator can render them as colour-coded boxes that mirror
    // the Android WebView's section-block layout.
    await streamArticlePdf(res, {
      title:              row.title,
      summary:            row.summary || '',
      category:           row.category,
      date:               row.date,
      source:             row.source,
      tags:               row.tags || [],
      fullContentHtml:    row.full_content || '',
      keyPointsHtml:      row.key_points      || null,
      examRelevanceHtml:  row.exam_relevance  || null,
      importantFactsHtml: row.important_facts || null,
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

  async getEffectiveMcqMarkingConfig(affairId: string) {
    const rows = await this.db.query(
      `SELECT mcq_negative_marking_override, mcq_marks_per_correct_override, mcq_marks_per_wrong_override
       FROM current_affairs WHERE id=$1`,
      [affairId]
    );
    const row = rows[0];
    if (row && row.mcq_negative_marking_override !== null) {
      const config = {
        negativeMarkingEnabled: row.mcq_negative_marking_override === true,
        marksPerCorrect:        parseFloat(row.mcq_marks_per_correct_override) || 1,
        marksPerWrong:           parseFloat(row.mcq_marks_per_wrong_override)   || 0,
        isOverride: true,
      };
      return successResponse({ config });
    }
    // Inline the global config lookup rather than calling getMcqMarkingConfig()
    // and accessing .data — TypeScript can't infer the return shape of an
    // async method through a generic wrapper without an explicit return type,
    // so the .data access would be typed as `unknown`.
    const cacheKey = 'ca_mcq:marking_config';
    const cached = await this.cache.get<any>(cacheKey);
    const globalConfig = cached?.data?.config ?? await (async () => {
      const settingRows = await this.db.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [CurrentAffairsService.MCQ_CONFIG_KEYS]
      ).catch(() => []);
      const map: Record<string, string> = {};
      for (const r of settingRows) map[r.key] = r.value;
      return {
        negativeMarkingEnabled: map['ca_mcq_negative_marking_enabled'] === 'true',
        marksPerCorrect:        parseFloat(map['ca_mcq_marks_per_correct']) || 1,
        marksPerWrong:           parseFloat(map['ca_mcq_marks_per_wrong'])   || 0,
      };
    })();
    return successResponse({ config: { ...globalConfig, isOverride: false } });
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
  @Post(':id/mcqs/submit') @HttpCode(201) submitMcqAttempt(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any, @Req() r: any) {
    return this.s.submitMcqAttempt(id, r.user.id, dto);
  }
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
// JOBS MODULE  (restructured)
// ════════════════════════════════════════════════════════════

const EXPERIENCE_OPTIONS = ['Any', 'Freshers', '0-1 Years', '1-3 Years', '3-5 Years', '5+ Years'] as const;

// Map from FCM category topic key → notification topic
// Used for targeted push: admin creates a "Central Govt" job →
// only users who subscribed to "Central Govt" alerts get a push.
const CATEGORY_TOPIC_MAP: Record<string, string> = {
  'Central Govt': 'jobs_central_govt',
  'Bihar Govt':   'jobs_bihar_govt',
  'BPSC':         'jobs_bpsc',
  'Railway':      'jobs_railway',
  'Banking':      'jobs_banking',
  'SSC':          'jobs_ssc',
  'Defence':      'jobs_defence',
  'Private':      'jobs_private',
  'Teaching':     'jobs_teaching',
};

@Injectable()
class JobsService implements OnModuleInit {
  private readonly logger = new Logger('JobsService');
  private readonly uploadDir: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly config: ConfigService,
  ) {
    this.uploadDir = this.config.get('UPLOAD_DIR') || './uploads';
  }

  async onModuleInit() { await this.ensureColumns(); }

  private fileUrl(key: string): string {
    const base = this.config.get('BASE_URL') || 'http://localhost:3000';
    return `${base}/uploads/${key}`;
  }

  /** ADD ANY MISSING COLUMNS — safe to run multiple times */
  async ensureColumns() {
    await this.db.query(`
      ALTER TABLE job_vacancies
        ADD COLUMN IF NOT EXISTS location          TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS salary_range      TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS brief_description TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS pdf_url           TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS experience_required VARCHAR(50) DEFAULT 'Any',
        ADD COLUMN IF NOT EXISTS advert_pdf_key   TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS advert_pdf_url   TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS job_state        VARCHAR(100) DEFAULT 'Bihar',
        ADD COLUMN IF NOT EXISTS job_district     VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS job_city         VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS is_remote        BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_featured      BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_new           BOOLEAN NOT NULL DEFAULT TRUE
    `).catch(() => {});
    await this.db.query(`
      ALTER TABLE current_affairs ADD COLUMN IF NOT EXISTS read_time INTEGER DEFAULT 1
    `).catch(() => {});
    // job_alert_prefs for targeted push
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS job_alert_prefs (
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic_key VARCHAR(100) NOT NULL,
        PRIMARY KEY (user_id, topic_key)
      )
    `).catch(() => {});
  }

  // ── Public: list jobs ─────────────────────────────────────
  // Sort: featured first → is_new → newest created → last_date
  async findAll(query: any, userId: string) {
    const { page=1, limit=20, status='active', category, search, exam } = query;
    const offset = (page-1)*Number(limit);
    const conditions: string[] = [`j.status=$1`];
    const params: any[]        = [status];
    if (category) { conditions.push(`j.category=$${params.length+1}`); params.push(category); }
    if (exam)     { conditions.push(`$${params.length+1}=ANY(j.exam_tags)`); params.push(exam); }
    if (search)   {
      conditions.push(`(j.title ILIKE $${params.length+1} OR j.organization ILIKE $${params.length+1})`);
      params.push(`%${search}%`);
    }
    const where = conditions.join(' AND ');
    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT
           j.id, j.title,
           j.organization                               AS department,
           j.category,
           j.total_posts,
           COALESCE(j.qualification,'')                AS qualification,
           COALESCE(j.age_limit,'')                    AS age_limit,
           COALESCE(j.experience_required,'Any')       AS experience_required,
           COALESCE(j.description,'')                  AS description,
           COALESCE(j.brief_description,'')            AS brief_description,
           COALESCE(j.pdf_url,'')                      AS pdf_url,
           COALESCE(j.advert_pdf_key,'')               AS advert_pdf_key,
           COALESCE(j.advert_pdf_url,'')               AS advert_pdf_url,
           COALESCE(j.application_link,'')             AS official_link,
           j.status,
           j.exam_tags,
           j.notification_date::TEXT                   AS notification_date,
           j.notification_date::TEXT                   AS apply_start_date,
           j.last_date::TEXT                           AS apply_end_date,
           j.exam_date::TEXT                           AS exam_date,
           j.created_at,
           COALESCE(j.is_featured, FALSE)              AS is_featured,
           COALESCE(j.is_new, TRUE)                    AS is_new,
           CASE WHEN j.last_date <= NOW() + INTERVAL '3 days'
                THEN TRUE ELSE FALSE END               AS is_urgent,
           COALESCE(j.job_state,'Bihar')               AS job_state,
           COALESCE(j.job_district,'')                 AS job_district,
           COALESCE(j.job_city,'')                     AS job_city,
           COALESCE(j.is_remote, FALSE)                AS is_remote,
           -- Build display location string from hierarchy
           CASE
             WHEN COALESCE(j.is_remote, FALSE) = TRUE THEN 'Remote'
             WHEN COALESCE(j.job_district,'') <> '' AND COALESCE(j.job_city,'') <> ''
               THEN CONCAT(j.job_city, ', ', j.job_district, ', ', COALESCE(j.job_state,'Bihar'))
             WHEN COALESCE(j.job_district,'') <> ''
               THEN CONCAT(j.job_district, ', ', COALESCE(j.job_state,'Bihar'))
             ELSE COALESCE(NULLIF(j.location,''), COALESCE(j.job_state,'Bihar') || ' (All Districts)')
           END                                         AS location,
           COALESCE(j.salary_range,'')                 AS salary_range,
           '{}'::TEXT[]                                AS nearby_districts,
           (SELECT TRUE FROM job_saves js
            WHERE js.user_id=$${params.length+1} AND js.job_id=j.id) AS is_saved
         FROM job_vacancies j WHERE ${where}
         ORDER BY
           COALESCE(j.is_featured, FALSE) DESC,
           COALESCE(j.is_new, TRUE)       DESC,
           j.created_at                   DESC,
           j.last_date                    ASC
         LIMIT $${params.length+2} OFFSET $${params.length+3}`,
        [...params, userId, Number(limit), offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies j WHERE ${where}`, params),
    ]);
    return successResponse({ jobs: rows }, 'Success', paginationMeta(parseInt(cnt.count), Number(page), Number(limit)));
  }

  // ── Toggle save ───────────────────────────────────────────
  async toggleSave(jobId: string, userId: string) {
    const existing = await this.db.query(`SELECT user_id FROM job_saves WHERE user_id=$1 AND job_id=$2`, [userId, jobId]);
    if (existing.length) {
      await this.db.query(`DELETE FROM job_saves WHERE user_id=$1 AND job_id=$2`, [userId, jobId]);
      await this.db.query(`UPDATE job_vacancies SET save_count=GREATEST(save_count-1,0) WHERE id=$1`, [jobId]);
      return successResponse({ isSaved: false });
    }
    await this.db.query(`INSERT INTO job_saves VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, jobId]);
    await this.db.query(`UPDATE job_vacancies SET save_count=save_count+1 WHERE id=$1`, [jobId]);
    return successResponse({ isSaved: true });
  }

  // ── Cron: auto-expire jobs past their last_date ───────────
  // Runs daily at 00:05 IST (UTC 18:35 prior day) — marks all active jobs
  // whose last_date has passed as 'expired' so they stop showing in the app.
  @Cron('35 18 * * *')
  async expireOverdueJobs() {
    try {
      const result = await this.db.query(
        `UPDATE job_vacancies
         SET status='expired', updated_at=NOW()
         WHERE status='active' AND last_date < CURRENT_DATE
         RETURNING id, title`
      );
      if (result.length > 0) {
        this.logger.log(`expireOverdueJobs: expired ${result.length} jobs — ${result.map((r: any) => r.title).join(', ')}`);
      }
    } catch (err: any) {
      this.logger.warn(`expireOverdueJobs failed: ${err.message}`);
    }
  }

  // ── Cron: unset is_new flag after 7 days ─────────────────
  // "New" badge should only show for the first week after posting.
  @Cron('0 19 * * *')
  async clearIsNewFlag() {
    await this.db.query(
      `UPDATE job_vacancies SET is_new=FALSE, updated_at=NOW()
       WHERE is_new=TRUE AND created_at < NOW() - INTERVAL '7 days'`
    ).catch(() => {});
  }


  // Called when user toggles a category in the Alert sheet.
  // Returns the full current prefs list for the user.
  async syncAlertPrefs(userId: string, categories: string[]) {
    // Replace all rows for this user
    await this.db.query(`DELETE FROM job_alert_prefs WHERE user_id=$1`, [userId]);
    for (const cat of categories) {
      if (cat.length > 100) continue;
      await this.db.query(
        `INSERT INTO job_alert_prefs (user_id, topic_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, cat]
      );
    }
    return successResponse({ subscribed: categories }, 'Alert preferences saved');
  }

  async getAlertPrefs(userId: string) {
    const rows = await this.db.query(
      `SELECT topic_key FROM job_alert_prefs WHERE user_id=$1`,
      [userId]
    );
    return successResponse({ subscribed: rows.map((r: any) => r.topic_key) });
  }

  // ── Admin: list ───────────────────────────────────────────
  async findAllAdmin(query: any) {
    const { page=1, limit=20, search, category, status, sort } = query;
    const orderBy = sort === 'last_date_asc'  ? 'j.last_date ASC'
                  : sort === 'last_date_desc' ? 'j.last_date DESC'
                  : sort === 'created_asc'    ? 'j.created_at ASC'
                  : 'COALESCE(j.is_featured,FALSE) DESC, j.created_at DESC';
    const offset = (page-1)*Number(limit);
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    if (search)   { conditions.push(`(j.title ILIKE $${params.length+1} OR j.organization ILIKE $${params.length+1})`); params.push(`%${search}%`); }
    if (category) { conditions.push(`j.category=$${params.length+1}`); params.push(category); }
    if (status)   { conditions.push(`j.status=$${params.length+1}`); params.push(status); }
    const where = conditions.join(' AND ');
    const [rows, [cnt], [govtCnt], [allCnt]] = await Promise.all([
      this.db.query(
        `SELECT j.*, a.name AS created_by_name FROM job_vacancies j
         LEFT JOIN admin_users a ON j.created_by=a.id
         WHERE ${where} ORDER BY ${orderBy}
         LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, Number(limit), offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies j WHERE ${where}`, params),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies WHERE category NOT IN ('Private','Part-time')`),
      this.db.query(`SELECT COUNT(*) FROM job_vacancies`),
    ]);
    return successResponse({
      jobs:          rows,
      govtJobsTotal: Number(govtCnt.count),
      totalJobsAll:  Number(allCnt.count),
    }, 'Success', paginationMeta(parseInt(cnt.count), Number(page), Number(limit)));
  }

  // ── Admin: create ─────────────────────────────────────────
  async adminCreate(data: any, adminId: string) {
    if (!data.title || !data.organization || !data.lastDate)
      throw new BadRequestException('Title, organization and last date required');

    const locationDisplay = this.buildLocationDisplay(data);

    const [result] = await this.db.query(
      `INSERT INTO job_vacancies
         (title, organization, category, total_posts, notification_date, last_date, exam_date,
          age_limit, qualification, experience_required, application_link, description,
          brief_description, pdf_url, advert_pdf_key, advert_pdf_url,
          location, salary_range, exam_tags,
          job_state, job_district, job_city, is_remote,
          is_featured, is_new, notification_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        data.title, data.organization, data.category || 'BPSC',
        data.totalPosts || data.totalVacancies || 0,
        data.notificationDate || null, data.lastDate, data.examDate || null,
        data.ageLimit || '', data.qualification || '',
        data.experienceRequired || 'Any',
        data.applicationLink || data.applicationUrl || '',
        data.description || '', data.briefDescription || '',
        data.pdfUrl || '', data.advertPdfKey || null, data.advertPdfUrl || null,
        locationDisplay, data.salary || data.salaryRange || '',
        data.examTags || [],
        data.jobState || 'Bihar', data.jobDistrict || null, data.jobCity || null,
        data.isRemote || false,
        data.isFeatured || false, data.isNew !== false,
        data.notificationUrl || null,
        adminId,
      ]
    );

    // 🔔 Targeted push: only users who subscribed to this category
    this.pushJobAlert(result, 'created').catch(() => {});

    return successResponse({ job: result }, 'Job vacancy created — live in app ✅');
  }

  // ── Admin: update ─────────────────────────────────────────
  async adminUpdate(jobId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: Record<string, string> = {
      title: 'title', organization: 'organization', category: 'category',
      totalPosts: 'total_posts', totalVacancies: 'total_posts',
      lastDate: 'last_date', examDate: 'exam_date', status: 'status',
      applicationLink: 'application_link', applicationUrl: 'application_link',
      description: 'description', briefDescription: 'brief_description',
      pdfUrl: 'pdf_url',
      advertPdfKey: 'advert_pdf_key', advertPdfUrl: 'advert_pdf_url',
      salary: 'salary_range', salaryRange: 'salary_range',
      ageLimit: 'age_limit', qualification: 'qualification',
      experienceRequired: 'experience_required',
      jobState: 'job_state', jobDistrict: 'job_district', jobCity: 'job_city',
      isRemote: 'is_remote', isFeatured: 'is_featured', isNew: 'is_new',
      notificationUrl: 'notification_url',
    };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    // Recompute display location if any location field changed
    if (data.jobState !== undefined || data.jobDistrict !== undefined ||
        data.jobCity !== undefined || data.isRemote !== undefined || data.location !== undefined) {
      // Load current row, merge with new data, compute display
      const [current] = await this.db.query(
        `SELECT job_state, job_district, job_city, is_remote, location FROM job_vacancies WHERE id=$1`, [jobId]
      );
      const merged = { ...current, ...data };
      const display = this.buildLocationDisplay(merged);
      fields.push(`location=$${i++}`); vals.push(display);
    }
    if (fields.length) {
      fields.push(`updated_at=NOW()`);
      await this.db.query(`UPDATE job_vacancies SET ${fields.join(',')} WHERE id=$${i}`, [...vals, jobId]);
    }
    return successResponse(null, 'Job updated — live in app ✅');
  }

  // ── Admin: delete ─────────────────────────────────────────
  async adminDelete(jobId: string) {
    const [row] = await this.db.query(`SELECT advert_pdf_key FROM job_vacancies WHERE id=$1`, [jobId]);
    if (row?.advert_pdf_key) {
      const path = require('path').join(this.uploadDir, row.advert_pdf_key);
      try { require('fs').unlinkSync(path); } catch (_) {}
    }
    await this.db.query(`DELETE FROM job_vacancies WHERE id=$1`, [jobId]);
    return successResponse(null, 'Job vacancy deleted');
  }

  // ── Admin: upload advertisement PDF ──────────────────────
  async adminUploadAdvertPdf(jobId: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    // Store under jobs/ subfolder
    const { join } = require('path');
    const fs = require('fs');
    const dest = join(this.uploadDir, 'jobs');
    fs.mkdirSync(dest, { recursive: true });
    const ext = require('path').extname(file.originalname).toLowerCase() || '.pdf';
    const key = `jobs/${jobId}${ext}`;
    const destPath = join(this.uploadDir, key);
    fs.copyFileSync(file.path, destPath);
    try { fs.unlinkSync(file.path); } catch (_) {}
    const url = this.fileUrl(key);
    await this.db.query(
      `UPDATE job_vacancies SET advert_pdf_key=$1, advert_pdf_url=$2, updated_at=NOW() WHERE id=$3`,
      [key, url, jobId]
    );
    return successResponse({ advertPdfKey: key, advertPdfUrl: url }, 'Advertisement PDF uploaded');
  }

  async findOne(jobId: string, userId: string) {
    const [rows, saved] = await Promise.all([
      this.db.query(
        `SELECT j.*, a.name AS created_by_name FROM job_vacancies j
         LEFT JOIN admins a ON a.id = j.created_by
         WHERE j.id = $1`,
        [jobId]
      ),
      this.db.query(
        `SELECT 1 FROM saved_jobs WHERE user_id=$1 AND job_id=$2`,
        [userId, jobId]
      ),
    ]);
    if (!rows[0]) throw new NotFoundException('Job not found');
    return successResponse({ job: { ...rows[0], isSaved: saved.length > 0 } });
  }

  // ── Helpers ───────────────────────────────────────────────
  private buildLocationDisplay(data: any): string {
    if (data.isRemote || data.is_remote) return 'Remote';
    const state    = data.jobState    || data.job_state    || 'Bihar';
    const district = data.jobDistrict || data.job_district || '';
    const city     = data.jobCity     || data.job_city     || '';
    if (city && district)   return `${city}, ${district}, ${state}`;
    if (district)           return `${district}, ${state}`;
    return `${state} (All Districts)`;
  }

  // ── Targeted push via job_alert_prefs ────────────────────
  // Sends to users who subscribed to this job's category.
  // Falls back to broader push if no subscribers found.
  private async pushJobAlert(job: any, event: 'created' | 'updated') {
    if (!job?.category) return;
    const title = `📋 New ${job.category} Job`;
    const body  = `${job.title} · ${job.organization} · Last date: ${job.last_date?.toString().split('T')[0] || ''}`;
    const data  = { type: 'new_job', screen: 'jobs', jobId: job.id || '' };

    try {
      // Get FCM tokens of users subscribed to this category
      const rows = await this.db.query(
        `SELECT u.fcm_token
         FROM job_alert_prefs jap
         JOIN users u ON u.id = jap.user_id
         WHERE jap.topic_key = $1
           AND u.fcm_token IS NOT NULL
           AND u.notification_enabled = TRUE
           AND u.status = 'active'`,
        [job.category]
      );

      const tokens: string[] = rows.map((r: any) => r.fcm_token).filter(Boolean);

      if (tokens.length === 0) {
        this.logger.log(`pushJobAlert: no subscribers for category "${job.category}" — skipping`);
        return;
      }

      const admin = require('firebase-admin');
      if (!admin.apps.length) return;

      // Batch in chunks of 500 (FCM multicast limit)
      for (let i = 0; i < tokens.length; i += 500) {
        await admin.messaging().sendEachForMulticast({
          tokens: tokens.slice(i, i + 500),
          notification: { title, body },
          data,
          android: { priority: 'high' },
        });
      }
      this.logger.log(`pushJobAlert: sent to ${tokens.length} subscribers for "${job.category}"`);
    } catch (err: any) {
      this.logger.warn(`pushJobAlert failed: ${err.message}`);
    }
  }
}

// ── Public controller ─────────────────────────────────────
@ApiTags('Jobs') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('jobs')
class JobsController {
  constructor(private s: JobsService) {}

  @Get()
  findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.findOne(id, r.user.id); }

  @Post(':id/save')
  @HttpCode(200)
  toggleSave(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.toggleSave(id, r.user.id);
  }

  // User syncs their alert category subscriptions
  @Post('alert-prefs')
  @HttpCode(200)
  syncAlertPrefs(@Body() body: { categories: string[] }, @Req() r: any) {
    return this.s.syncAlertPrefs(r.user.id, body.categories || []);
  }

  @Get('alert-prefs')
  getAlertPrefs(@Req() r: any) { return this.s.getAlertPrefs(r.user.id); }
}

// ── Admin controller ──────────────────────────────────────
@ApiTags('Admin — Jobs') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/jobs')
class AdminJobsController {
  constructor(private s: JobsService) {}

  @Get()
  @RequirePermission('jobs')
  findAll(@Query() q: any) { return this.s.findAllAdmin(q); }

  @Post()
  @RequirePermission('jobs')
  @HttpCode(201)
  create(@Body() dto: any, @Req() r: any) { return this.s.adminCreate(dto, r.admin.id); }

  @Put(':id')
  @RequirePermission('jobs')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.s.adminUpdate(id, dto);
  }

  @Delete(':id')
  @RequirePermission('jobs')
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.s.adminDelete(id); }

  // Upload advertisement PDF for a job
  @Post(':id/advert-pdf')
  @RequirePermission('jobs')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', {
    dest: '/tmp',
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    fileFilter: (_req: any, file: any, cb: any) => {
      if (file.mimetype === 'application/pdf') cb(null, true);
      else cb(new BadRequestException('Only PDF files are accepted'), false);
    },
  }))
  uploadAdvertPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) { return this.s.adminUploadAdvertPdf(id, file); }
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

    // ── Create Cashfree order ────────────────────────────────────
    let paymentSessionId: string | null = null;
    let cfOrderId:        string | null = null;
    let paymentEnvironment: 'sandbox' | 'production' = 'sandbox'; // returned to Android SDK
    if (finalAmount > 0) {
      try {
        // Resolve credentials: env vars first, then payment_settings DB override
        const rows = await this.db.query(
          `SELECT key, value FROM payment_settings
           WHERE key IN ('cashfree_app_id','cashfree_secret_key','payment_mode')
             AND value IS NOT NULL AND value != ''`
        ).catch(() => []);
        const cfMap: any = {};
        for (const r of rows) cfMap[r.key] = r.value;

        const { createCashfreeOrder, buildCashfreeCredentials, cashfreeReceiptId } = CashfreeUtil;

        const creds = buildCashfreeCredentials({
          appId:     cfMap['cashfree_app_id'],
          secretKey: cfMap['cashfree_secret_key'],
          env:       cfMap['payment_mode'],
        });

        // Expose the resolved environment so Android SDK uses the matching endpoint
        paymentEnvironment = creds.env;

        if (!creds.appId || !creds.secretKey) {
          console.warn('Cashfree keys not configured — paymentSessionId will be null');
        } else {
          // Fetch user info for customer_details (Cashfree requires phone)
          const [userRow] = await this.db.query(
            `SELECT name, email, mobile FROM users WHERE id=$1`, [userId]
          );
          const order = await createCashfreeOrder(creds, {
            orderId:       cashfreeReceiptId('sub', subscriptionId),
            orderAmount:   finalAmount,
            orderCurrency: 'INR',
            customerId:    userId,
            customerPhone: userRow?.mobile || '9999999999',
            customerEmail: userRow?.email  || `${userId}@bpscnotes.app`,
            customerName:  userRow?.name   || 'BPSCNotes User',
            orderNote:     `BPSCNotes ${data.plan} subscription`,
            orderMeta:     { subscriptionId, plan: data.plan },
          });

          paymentSessionId = order.paymentSessionId;
          cfOrderId        = order.orderId;

          await this.db.query(
            `UPDATE subscriptions
               SET provider_order_id=$1, payment_provider='cashfree'
             WHERE id=$2`,
            [cfOrderId, subscriptionId]
          );
        }
      } catch (err: any) {
        console.error('Cashfree order creation failed:', err.message);
      }
    }

    return successResponse({
      subscriptionId,
      paymentSessionId,          // → Android Cashfree SDK
      providerOrderId: cfOrderId,
      paymentEnvironment,        // → Android SDK: 'sandbox' | 'production'
      breakdown: { baseAmount: price, coinDiscount, couponDiscount, finalAmount, coinsUsed: coinsToUse, couponCode: validCoupon?.code }
    });
  }

  async confirm(subId: string, userId: string, data: any) {
    const subResult = await this.db.query(`SELECT * FROM subscriptions WHERE id=$1 AND user_id=$2 AND payment_status='pending'`, [subId, userId]);
    if (!subResult.length) throw new NotFoundException('Subscription not found or already processed');
    const sub = subResult[0];
    const plan = this.PLANS[sub.plan];
    if (!plan) throw new BadRequestException('Invalid plan');

    // ── Idempotency — check provider_payment_id ─────────────────
    const dupCheck = await this.db.query(
      `SELECT id FROM subscriptions WHERE provider_payment_id=$1`, [data.cfPaymentId]
    );
    if (dupCheck.length) throw new ConflictException('Transaction already processed');

    // ── Verify payment with Cashfree ─────────────────────────────
    // We look up the payment server-side so the client never controls
    // the payment status — eliminates the entire class of client-side
    // tamper attacks that plagued the old HMAC approach.
    const { verifyCashfreePayment, buildCashfreeCredentials } = CashfreeUtil;

    const rows = await this.db.query(
      `SELECT key, value FROM payment_settings
       WHERE key IN ('cashfree_app_id','cashfree_secret_key','payment_mode')
         AND value IS NOT NULL AND value != ''`
    ).catch(() => []);
    const cfMap: any = {};
    for (const r of rows) cfMap[r.key] = r.value;

    const creds = buildCashfreeCredentials({
      appId:     cfMap['cashfree_app_id'],
      secretKey: cfMap['cashfree_secret_key'],
      env:       cfMap['payment_mode'],
    });
    if (!creds.appId || !creds.secretKey) {
      throw new BadRequestException('Payment gateway not configured. Contact support.');
    }

    const providerOrderId = sub.provider_order_id;
    if (!providerOrderId) {
      throw new BadRequestException('Missing provider order ID. Contact support.');
    }

    const payment = await verifyCashfreePayment(creds, providerOrderId);
    if (payment.paymentStatus !== 'SUCCESS') {
      console.error(`PAYMENT STATUS NOT SUCCESS: user=${userId} order=${providerOrderId} status=${payment.paymentStatus}`);
      throw new BadRequestException(`Payment not successful (status: ${payment.paymentStatus}). Contact support.`);
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
         provider_payment_id=$3, payment_provider='cashfree', starts_at=NOW(), ends_at=$4, updated_at=NOW() WHERE id=$5`,
        [payment.paymentMethod || 'upi', payment.upiId || null, payment.cfPaymentId, endsAt, subId]
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
        await this.db.query(`UPDATE users SET coins=COALESCE(coins,0)+$1 WHERE id=$2`, [plan.bonusCoins, userId]);
        const balRow = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]))[0];
        const newBal = Number(balRow?.coins) || 0;
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

  // ── Cashfree Webhook Handler ─────────────────────────────────
  async handleCashfreeWebhook(req: any, body: any) {
    const { verifyCashfreeWebhookSignature } = CashfreeUtil;

    // ── Verify webhook signature ──────────────────────────────
    const webhookSecret = process.env.CASHFREE_WEBHOOK_SECRET
      || (await this.db.query(`SELECT value FROM payment_settings WHERE key='cashfree_webhook_secret'`).catch(() => []))[0]?.value
      || '';
    const signature = req.headers['x-webhook-signature']  || '';
    const timestamp = req.headers['x-webhook-timestamp']  || '';
    const rawBody   = req.rawBody || JSON.stringify(body);

    if (webhookSecret && signature) {
      const valid = verifyCashfreeWebhookSignature(rawBody, timestamp, signature, webhookSecret);
      if (!valid) {
        console.error('Cashfree webhook: invalid signature');
        return { status: 'invalid_signature' };
      }
    }

    // Cashfree PG v3 webhook shape:
    //   { type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: {...}, payment: {...} } }
    const eventType = body.type;
    const orderData = body.data?.order;
    const payData   = body.data?.payment;
    const orderId   = orderData?.order_id;

    if (!orderId) return { status: 'ignored' };

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
      const [sub] = await this.db.query(
        `SELECT * FROM subscriptions WHERE provider_order_id=$1 AND payment_status='pending'`,
        [orderId]
      );
      if (!sub) return { status: 'not_found' };

      const cfPaymentId = String(payData?.cf_payment_id || '');
      if (cfPaymentId) {
        const dup = await this.db.query(
          `SELECT id FROM subscriptions WHERE provider_payment_id=$1`, [cfPaymentId]
        );
        if (dup.length) return { status: 'already_processed' };
      }

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
               provider_payment_id=$3, payment_provider='cashfree',
               starts_at=NOW(), ends_at=$4, updated_at=NOW()
           WHERE id=$5`,
          [
            payData?.payment_group || 'upi',
            payData?.payment_method?.upi?.upi_id || null,
            cfPaymentId,
            endsAt,
            sub.id,
          ]
        );

        if (plan?.bonusCoins > 0 && await this.isCoinSystemEnabled()) {
          await this.db.query(`UPDATE users SET coins=COALESCE(coins,0)+$1 WHERE id=$2`, [plan.bonusCoins, sub.user_id]);
          const [bal] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [sub.user_id]);
          await this.db.query(
            `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
             VALUES ($1,'earned',$2,'Subscription bonus coins','subscription_bonus',$3)`,
            [sub.user_id, plan.bonusCoins, Number(bal?.coins) || 0]
          );
        }

        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK');
        console.error(`Webhook: rollback for sub ${sub.id}:`, err);
        return { status: 'error' };
      }

      await this.cache.del(`user:${sub.user_id}`);
      console.log(`Webhook: subscription ${sub.id} activated for user ${sub.user_id}`);
    }

    if (eventType === 'PAYMENT_FAILED_WEBHOOK') {
      await this.db.query(
        `UPDATE subscriptions SET payment_status='failed', status='failed', updated_at=NOW()
         WHERE provider_order_id=$1 AND payment_status='pending'`,
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
  @Post('create')   @HttpCode(200) create(@Req() r: any, @Body() dto: any)   { return this.s.initiate(r.user.id, dto); }  // backwards-compat alias
  @Post(':id/confirm') @HttpCode(200) confirm(@Param('id', ParseUUIDPipe) id: string, @Req() r: any, @Body() dto: any) { return this.s.confirm(id, r.user.id, dto); }
  @Get('status') getStatus(@Req() r: any) { return this.s.getStatus(r.user.id); }
  @Post('coupons/validate') @HttpCode(200) validateCoupon(@Body() body: any) { return this.s.validateCoupon(body.code, body.type||'subscription'); }
}

// Cashfree webhook — no JWT guard (Cashfree calls this server-to-server)
// rawBody populated by global raw-body middleware in main.ts
// Cashfree webhook — no JWT guard (Cashfree calls this server-to-server)
@Public()
@Controller('webhooks')
class WebhookController {
  constructor(private s: SubscriptionsService) {}

  @Public()
  @Post('cashfree')
  @HttpCode(200)
  cashfree(@Req() req: any, @Body() body: any) {
    return this.s.handleCashfreeWebhook(req, body);
  }
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

@Module({ imports:[ConfigModule], controllers:[SubscriptionsController, WebhookController, AdminSubscriptionsController], providers:[SubscriptionsService] })
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
    @Optional() @Inject(CACHE_MANAGER) private readonly cache: Cache,
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
          } catch (err: any) {
            console.error('FCM multicast failed:', err.message);
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
    if (!admin.apps.length) return 0;
    let sent = 0;
    let offset = 0;
    const BATCH = 2000;   // DB rows per page
    // Paginate through ALL eligible users — no arbitrary cap.
    // Previous version silently dropped users beyond 2000.
    while (true) {
      const tokens = await this.db.query(
        `SELECT fcm_token FROM users
         WHERE notification_enabled=TRUE AND fcm_token IS NOT NULL AND status='active'
         ORDER BY id
         LIMIT $1 OFFSET $2`,
        [BATCH, offset]
      );
      const fcmTokens = tokens.map((t: any) => t.fcm_token).filter(Boolean);
      if (!fcmTokens.length) break;

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
      offset += BATCH;
      if (tokens.length < BATCH) break;   // last page
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

  // ── Scheduled notification crons ─────────────────────────────
  // Each acquires a 2-min Redis distributed lock to prevent duplicate
  // execution when multiple backend instances are running.

  /** 07:00 IST = 01:30 UTC — notify users who haven't started today's daily quiz */
  @Cron('30 1 * * *')
  async cronDailyQuizUnlock() {
    if (!this.cache) return;
    const lockKey = 'cron:daily_quiz_unlock';
    const existing = await this.cache.get(lockKey);
    if (existing) return;
    await this.cache.set(lockKey, '1', 120);
    try {
      const settings = await this.db.query(
        `SELECT value FROM app_settings WHERE key='notif_daily_quiz_enabled'`
      );
      if (settings[0]?.value !== 'true') return;

      const users = await this.db.query(`
        SELECT u.id FROM users u
        WHERE u.status='active'
          AND u.notification_enabled=TRUE
          AND u.fcm_token IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM quiz_sessions qs
            JOIN quizzes q ON q.id=qs.quiz_id
            WHERE qs.user_id=u.id
              AND q.type='daily'
              AND qs.started_at::date = CURRENT_DATE
          )
      `);
      for (const u of users) {
        await this.pushToUser(u.id, "Today's Quiz is Live! 📝", "Start today's daily quiz and keep your streak going.", { type: 'daily_quiz' });
      }
    } finally {
      await this.cache.del(lockKey);
    }
  }

  /** 20:00 IST = 14:30 UTC — notify users whose streak is at risk */
  @Cron('30 14 * * *')
  async cronStreakAtRisk() {
    if (!this.cache) return;
    const lockKey = 'cron:streak_at_risk';
    const existing = await this.cache.get(lockKey);
    if (existing) return;
    await this.cache.set(lockKey, '1', 120);
    try {
      const settings = await this.db.query(
        `SELECT value FROM app_settings WHERE key='notif_streak_risk_enabled'`
      );
      if (settings[0]?.value !== 'true') return;

      const users = await this.db.query(`
        SELECT u.id FROM users u
        WHERE u.status='active'
          AND u.notification_enabled=TRUE
          AND u.fcm_token IS NOT NULL
          AND u.streak > 0
          AND NOT EXISTS (
            SELECT 1 FROM quiz_sessions qs
            WHERE qs.user_id=u.id
              AND qs.started_at::date = CURRENT_DATE
          )
      `);
      for (const u of users) {
        await this.pushToUser(u.id, "Your Streak is at Risk! 🔥", "Study something today to keep your streak alive.", { type: 'streak_risk' });
      }
    } finally {
      await this.cache.del(lockKey);
    }
  }

  /** 09:00 IST = 03:30 UTC — remind users with a daily goal who haven't studied yet */
  @Cron('30 3 * * *')
  async cronDailyTargetReminder() {
    if (!this.cache) return;
    const lockKey = 'cron:daily_target_reminder';
    const existing = await this.cache.get(lockKey);
    if (existing) return;
    await this.cache.set(lockKey, '1', 120);
    try {
      const settings = await this.db.query(
        `SELECT value FROM app_settings WHERE key='notif_target_reminder_enabled'`
      );
      if (settings[0]?.value !== 'true') return;

      const users = await this.db.query(`
        SELECT u.id, u.daily_goal_mins FROM users u
        WHERE u.status='active'
          AND u.notification_enabled=TRUE
          AND u.fcm_token IS NOT NULL
          AND u.daily_goal_mins IS NOT NULL
          AND u.daily_goal_mins > 0
          AND NOT EXISTS (
            SELECT 1 FROM quiz_sessions qs
            WHERE qs.user_id=u.id
              AND qs.started_at::date = CURRENT_DATE
          )
      `);
      for (const u of users) {
        await this.pushToUser(u.id, "Time to Hit Your Daily Goal! 🎯", `You have a ${u.daily_goal_mins}-min study goal. Start now!`, { type: 'target_reminder' });
      }
    } finally {
      await this.cache.del(lockKey);
    }
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