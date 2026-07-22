import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Body, Param, Query, Req,
  UseGuards, UseInterceptors, UploadedFiles, UploadedFile, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { join, extname } from 'path';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission } from '../../common/guards';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthModule, AuthService } from '../auth/auth.module';
import { NotificationsModule, NotificationService } from '../combined-modules-1.module';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/answer-writing/answer-writing.module.ts
//
// ANSWER WRITING — daily Mains descriptive-answer practice.
//
// Flow: admin posts a question (marks, word limit, model answer) →
// user writes an answer in the app (one attempt per question) →
// model answer is revealed immediately after submitting → an admin
// grades it later with a score + feedback → user gets a push.
//
// Powers: AnswerWritingScreen (Android), admin.bpscnotes.in/answer-writing
// Endpoints:
//   GET  /answer-writing               — published questions + my status
//   GET  /answer-writing/my            — my submissions (history tab)
//   GET  /answer-writing/:id           — question detail (+ my submission,
//                                        model answer only after submitting)
//   POST /answer-writing/:id/submit    — submit my answer (awards coins)
//   GET  /admin/answer-writing/questions        — admin list + stats
//   POST /admin/answer-writing/questions        — create
//   PUT  /admin/answer-writing/questions/:id    — update
//   DELETE /admin/answer-writing/questions/:id  — delete
//   GET  /admin/answer-writing/submissions      — review queue
//   PUT  /admin/answer-writing/submissions/:id/review — grade + feedback
// ════════════════════════════════════════════════════════════

const countWords = (text: string): number =>
  text.trim().split(/\s+/).filter(Boolean).length;

// ── Peer review constants ─────────────────────────────────────
// An answer is "peer_reviewed" once it has this many peer reviews…
const PEER_REVIEWS_TARGET = 2;
// …and stops being served to new reviewers after this many, so review
// capacity spreads across the pool instead of piling on one answer.
const PEER_REVIEWS_MAX = 5;

const REVIEW_VERDICTS = ['yes', 'partly', 'no'];
// v2 set per client notes: Introduction / Structure / Content /
// Value Addition / Analysis / Conclusion. Old values stay accepted so
// reviews from earlier app builds don't start failing.
const IMPROVEMENT_AREAS = [
  'introduction', 'structure', 'content', 'value_addition', 'analysis', 'conclusion',
  'bihar_angle', 'presentation', // legacy
];
const MAX_IMPROVEMENT_AREAS = 3; // "top three weaknesses"

/** IST calendar date (YYYY-MM-DD) for a timestamp */
const istDate = (d: Date | string): string =>
  new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ── Multer storage for handwritten-answer photos ─────────────
// Same disk layout as study materials: uploads/answers/<year>/<month>/,
// served at BASE_URL/uploads/… by the static handler in main.ts.
const ANSWER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per photo
const MAX_IMAGES = 5;
const ANSWER_PDF_TYPES = ['application/pdf'];
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB per answer PDF

function answerImageStorage() {
  const now = new Date();
  const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dest = join('./uploads', 'answers', subDir);
  fs.mkdirSync(dest, { recursive: true });
  return diskStorage({
    destination: (_req, _file, cb) => cb(null, dest),
    filename: (_req, file, cb) => {
      const uniqueId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const safeExt = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
      cb(null, `${Date.now()}_${uniqueId}${safeExt}`);
    },
  });
}

// ════════════════════════════════════════════════════════════
// USER SERVICE
// ════════════════════════════════════════════════════════════
@Injectable()
export class AnswerWritingService {
  private readonly logger = new Logger(AnswerWritingService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly authService: AuthService,
    private readonly notifService: NotificationService,
    private readonly config: ConfigService,
  ) {}

  private fileUrl(diskPath: string): string {
    const base = this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in';
    const key = diskPath.replace(/\\/g, '/').replace(/^\.?\/?uploads\//, '');
    return `${base}/uploads/${key}`;
  }

  // ── GET /answer-writing — published questions with my status ──
  // "Today's question" = the one scheduled for today (IST); the app
  // pins it as the hero card. Unscheduled questions just list below.
  async findAll(userId: string, page = 1, limit = 20, subject?: string) {
    const offset = (page - 1) * limit;
    const conditions = [`q.status = 'published'`];
    const params: any[] = [];
    if (subject) { conditions.push(`q.subject = $${params.length + 1}`); params.push(subject); }
    // Never show questions scheduled for a future day
    conditions.push(`(q.scheduled_for IS NULL OR q.scheduled_for <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`);
    const where = conditions.join(' AND ');

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT
           q.id, q.question_text, q.subject, q.marks, q.word_limit,
           q.scheduled_for, q.created_at,
           COALESCE(q.is_pyq, FALSE) AS is_pyq, q.pyq_year,
           (q.scheduled_for = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_today,
           s.id IS NOT NULL                        AS is_submitted,
           s.status                                AS my_status,
           s.score                                 AS my_score,
           (SELECT COUNT(*)::int FROM answer_submissions WHERE question_id = q.id) AS submission_count
         FROM answer_questions q
         LEFT JOIN answer_submissions s ON s.question_id = q.id AND s.user_id = $${params.length + 1}
         WHERE ${where}
         ORDER BY q.scheduled_for DESC NULLS LAST, q.created_at DESC
         LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
        [...params, userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM answer_questions q WHERE ${where}`, params),
    ]);

    return successResponse(
      { questions: rows },
      'Success',
      paginationMeta(parseInt(countResult[0].count), page, limit)
    );
  }

  // ── GET /answer-writing/insights — personal stats dashboard ───
  // Powers the "Insights" tab: writing volume, ratings, review
  // activity, streak and a monthly goal. All derived — no new tables.
  async insights(userId: string) {
    const [row] = await this.db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM answer_submissions WHERE user_id = $1)                                        AS answers_written,
         (SELECT COUNT(*)::int FROM answer_submissions WHERE user_id = $1
            AND created_at >= date_trunc('month', NOW()))                                                          AS answers_this_month,
         (SELECT COUNT(*)::int FROM answer_peer_reviews WHERE reviewer_id = $1)                                    AS reviews_given,
         (SELECT COUNT(*)::int FROM answer_peer_reviews pr
            JOIN answer_submissions s ON s.id = pr.submission_id WHERE s.user_id = $1)                             AS reviews_received,
         (SELECT ROUND(AVG(pr.rating)::numeric, 1) FROM answer_peer_reviews pr
            JOIN answer_submissions s ON s.id = pr.submission_id WHERE s.user_id = $1)                             AS avg_rating,
         (SELECT ROUND(AVG(score)::numeric, 1) FROM answer_submissions
            WHERE user_id = $1 AND status = 'reviewed' AND score IS NOT NULL)                                      AS avg_mentor_score,
         (SELECT COUNT(*)::int FROM answer_submissions WHERE user_id = $1 AND status = 'reviewed')                 AS mentor_reviewed,
         (SELECT COALESCE(review_credits, 0) FROM users WHERE id = $1)                                             AS review_credits,
         (SELECT COALESCE(SUM(word_count), 0)::int FROM answer_submissions WHERE user_id = $1)                     AS total_words`,
      [userId]
    );

    // Writing streak — consecutive days (IST) ending today/yesterday
    // with at least one submission.
    const days = await this.db.query(
      `SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
       FROM answer_submissions WHERE user_id = $1
       ORDER BY day DESC LIMIT 60`,
      [userId]
    );
    let streak = 0;
    if (days.length) {
      const toKey = (d: Date) => d.toISOString().slice(0, 10);
      const daySet = new Set(days.map((r: any) =>
        (r.day instanceof Date ? toKey(r.day) : String(r.day).slice(0, 10))));
      // streak may start today or yesterday (today's answer not written yet)
      const cursor = new Date();
      if (!daySet.has(toKey(cursor))) cursor.setDate(cursor.getDate() - 1);
      while (daySet.has(toKey(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
    }

    // "Top three weaknesses" — most-flagged improvement areas across
    // all peer reviews received on my answers.
    const weaknessRows = await this.db.query(
      `SELECT area, COUNT(*)::int AS cnt FROM (
         SELECT unnest(
           COALESCE(pr.improvement_areas,
                    CASE WHEN pr.improvement_area IS NOT NULL
                         THEN ARRAY[pr.improvement_area] ELSE ARRAY[]::text[] END)
         ) AS area
         FROM answer_peer_reviews pr
         JOIN answer_submissions s ON s.id = pr.submission_id
         WHERE s.user_id = $1
       ) t GROUP BY area ORDER BY cnt DESC LIMIT 3`,
      [userId]
    );

    const monthlyGoal = 10; // answers per month — product default
    return successResponse({
      topWeaknesses:    weaknessRows.map((w: any) => ({ area: w.area, count: Number(w.cnt) })),
      answersWritten:   Number(row.answers_written) || 0,
      answersThisMonth: Number(row.answers_this_month) || 0,
      reviewsGiven:     Number(row.reviews_given) || 0,
      reviewsReceived:  Number(row.reviews_received) || 0,
      avgRating:        row.avg_rating != null ? Number(row.avg_rating) : null,
      avgMentorScore:   row.avg_mentor_score != null ? Number(row.avg_mentor_score) : null,
      mentorReviewed:   Number(row.mentor_reviewed) || 0,
      reviewCredits:    Number(row.review_credits) || 0,
      totalWords:       Number(row.total_words) || 0,
      writingStreak:    streak,
      monthlyGoal,
    });
  }

  // ── GET /answer-writing/leaderboard — community rankings ──────
  // Top Reviewers (most reviews given) + Top Writers (best avg peer
  // rating, min 2 rated answers). Names are public here by design —
  // recognition is the reward; individual reviews stay anonymous.
  async leaderboard(userId: string) {
    const topReviewers = await this.db.query(
      `SELECT u.name, COUNT(*)::int AS reviews_given,
              COALESCE(u.review_credits, 0) AS review_credits,
              (u.id = $1) AS is_me
       FROM answer_peer_reviews pr
       JOIN users u ON u.id = pr.reviewer_id
       GROUP BY u.id, u.name, u.review_credits
       ORDER BY reviews_given DESC, review_credits DESC
       LIMIT 10`,
      [userId]
    );
    const topWriters = await this.db.query(
      `SELECT u.name,
              COUNT(s.id)::int AS answers,
              ROUND(AVG(s.avg_peer_rating)::numeric, 1) AS avg_rating,
              (u.id = $1) AS is_me
       FROM answer_submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.avg_peer_rating IS NOT NULL
       GROUP BY u.id, u.name
       HAVING COUNT(s.id) >= 1
       ORDER BY avg_rating DESC, answers DESC
       LIMIT 10`,
      [userId]
    );
    return successResponse({ topReviewers, topWriters });
  }

  // ── GET /answer-writing/my — my submission history ────────────
  async mySubmissions(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const rows = await this.db.query(
      `SELECT s.id, s.question_id, s.word_count, s.status, s.score, s.feedback,
              s.answer_images, s.answer_pdf, s.peer_review_count, s.avg_peer_rating,
              s.created_at, s.reviewed_at,
              q.question_text, q.subject, q.marks, q.word_limit
       FROM answer_submissions s
       JOIN answer_questions q ON q.id = s.question_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    const [{ count }] = await this.db.query(
      `SELECT COUNT(*) FROM answer_submissions WHERE user_id = $1`, [userId]
    );
    return successResponse(
      { submissions: rows },
      'Success',
      paginationMeta(parseInt(count), page, limit)
    );
  }

  // ── GET /answer-writing/:id — detail (+ my submission) ────────
  // Model answer reveal (client rule: "will show next day"): visible
  // only once the user has submitted AND the IST calendar day has
  // rolled past the day they submitted. model_answer_tomorrow tells
  // the app to show the "unlocks tomorrow" note.
  async findOne(questionId: string, userId: string) {
    const [q] = await this.db.query(
      `SELECT id, question_text, subject, marks, word_limit, tips,
              model_answer, scheduled_for, created_at,
              COALESCE(is_pyq, FALSE) AS is_pyq, pyq_year
       FROM answer_questions WHERE id = $1 AND status = 'published'`,
      [questionId]
    );
    if (!q) throw new NotFoundException('Question not found');

    const [sub] = await this.db.query(
      `SELECT id, answer_text, answer_images, answer_pdf, word_count, time_taken_secs, status, score,
              feedback, peer_review_count, avg_peer_rating, created_at, reviewed_at
       FROM answer_submissions WHERE question_id = $1 AND user_id = $2`,
      [questionId, userId]
    );

    // Peer reviews received on MY submission — anonymous (no reviewer identity)
    let peerReviews: any[] = [];
    if (sub) {
      peerReviews = await this.db.query(
        `SELECT verdict, rating, improvement_area, improvement_areas, suggestion, created_at
         FROM answer_peer_reviews WHERE submission_id = $1 ORDER BY created_at DESC`,
        [sub.id]
      );
    }

    const { model_answer, ...rest } = q;
    const revealModelAnswer = !!sub && istDate(new Date()) > istDate(sub.created_at);
    return successResponse({
      question: {
        ...rest,
        model_answer: revealModelAnswer ? model_answer : null,
        // true → submitted, model answer exists, but reveals next day
        model_answer_tomorrow: !!sub && !revealModelAnswer && !!model_answer,
      },
      submission: sub || null,
      peerReviews,
    });
  }

  // ── POST /answer-writing/:id/submit ───────────────────────────
  // Text answers. Photo answers go through submitPhoto() below — both
  // funnel into the same insert + coin award.
  async submit(questionId: string, userId: string, body: { answerText?: string; timeTakenSecs?: number }) {
    const answerText = (body?.answerText || '').trim();
    if (!answerText) throw new BadRequestException('Answer text is required');
    if (answerText.length > 30000) throw new BadRequestException('Answer is too long');
    return this.insertSubmission(questionId, userId, {
      answerText,
      images: null,
      pdf: null,
      wordCount: countWords(answerText),
      timeTakenSecs: body?.timeTakenSecs,
    });
  }

  // ── POST /answer-writing/:id/submit-pdf ───────────────────────
  // Handwritten/typed answer as a single PDF. wordCount is client-reported
  // (best effort). Same insert + coin award as text/photo submissions.
  async submitPdf(
    questionId: string,
    userId: string,
    file: Express.Multer.File | undefined,
    body: { wordCount?: number; timeTakenSecs?: number },
  ) {
    if (!file) throw new BadRequestException('A PDF of your answer is required');
    return this.insertSubmission(questionId, userId, {
      answerText: null,
      images: null,
      pdf: this.fileUrl(file.path),
      wordCount: Math.max(0, Math.floor(Number(body?.wordCount) || 0)),
      timeTakenSecs: body?.timeTakenSecs,
    });
  }

  // ── POST /answer-writing/:id/submit-photo ─────────────────────
  // Handwritten answers: 1-5 photos of the notebook pages. wordCount is
  // client-reported (best effort) since we can't count handwriting.
  async submitPhoto(
    questionId: string,
    userId: string,
    files: Express.Multer.File[],
    body: { wordCount?: number; timeTakenSecs?: number },
  ) {
    if (!files?.length) throw new BadRequestException('At least one photo of your answer is required');
    const imageUrls = files.map(f => this.fileUrl(f.path));
    return this.insertSubmission(questionId, userId, {
      answerText: null,
      images: imageUrls,
      pdf: null,
      wordCount: Math.max(0, Math.floor(Number(body?.wordCount) || 0)),
      timeTakenSecs: body?.timeTakenSecs,
    });
  }

  private async insertSubmission(
    questionId: string,
    userId: string,
    data: { answerText: string | null; images: string[] | null; pdf: string | null; wordCount: number; timeTakenSecs?: number },
  ) {
    const [q] = await this.db.query(
      `SELECT id, question_text, marks, word_limit, model_answer
       FROM answer_questions WHERE id = $1 AND status = 'published'`,
      [questionId]
    );
    if (!q) throw new NotFoundException('Question not found');

    const timeTaken = Math.max(0, Math.floor(Number(data.timeTakenSecs) || 0)) || null;

    let submission: any;
    try {
      const rows = await this.db.query(
        `INSERT INTO answer_submissions (question_id, user_id, answer_text, answer_images, answer_pdf, word_count, time_taken_secs)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, answer_text, answer_images, answer_pdf, word_count, time_taken_secs, status, score, feedback,
                   peer_review_count, avg_peer_rating, created_at`,
        [questionId, userId, data.answerText, data.images, data.pdf, data.wordCount, timeTaken]
      );
      submission = rows[0];
    } catch (err: any) {
      // UNIQUE(question_id, user_id) — one attempt per question
      if (String(err?.code) === '23505') {
        throw new BadRequestException('You have already submitted an answer for this question');
      }
      throw err;
    }

    // Coins — amount/daily-cap/off-switch live in coin_rules.answer_writing
    let coinsEarned = 0;
    try {
      coinsEarned = await this.authService.awardCoins(userId, 'answer_writing');
    } catch (e) {
      this.logger.warn(`awardCoins(answer_writing) failed: ${(e as Error).message}`);
    }

    return successResponse({
      submission,
      coinsEarned,
      // Client rule: the model answer reveals NEXT DAY, never on submit
      modelAnswer: null,
      modelAnswerTomorrow: !!q.model_answer,
    }, coinsEarned > 0
      ? `Answer submitted! 🪙 +${coinsEarned} coins — the model answer unlocks tomorrow.`
      : 'Answer submitted! The model answer unlocks tomorrow.');
  }

  // ═══════════════════════════════════════════════════════════
  // PEER REVIEW — "give one review to get review" (client rule v2)
  //
  // Gate A — you may only review answers to questions you also
  //          submitted (competence + skin in the game).
  // Give-to-get — the queue serves answers from authors who have
  //          GIVEN reviews first; answers from authors who never
  //          reviewed anyone only surface when nothing else is
  //          waiting. So: give a review → your answer jumps the
  //          queue. Soft priority (not a hard gate) so day one
  //          isn't a deadlock where nobody can review anybody.
  // Assignment: never your own answer, never one you already
  // reviewed, capped at PEER_REVIEWS_MAX, anonymous both ways.
  // ═══════════════════════════════════════════════════════════

  /** WHERE clause for the pool of answers this user may review ($1 = userId). */
  private reviewPoolFilter(userId: string) {
    return `
      s.user_id != $1
      AND s.status != 'reviewed'
      AND s.peer_review_count < ${PEER_REVIEWS_MAX}
      AND s.question_id IN (SELECT question_id FROM answer_submissions WHERE user_id = $1)
      AND NOT EXISTS (
        SELECT 1 FROM answer_peer_reviews pr
        WHERE pr.submission_id = s.id AND pr.reviewer_id = $1
      )`;
  }

  /** Give-to-get ordering: reviewers' answers first, then neediest/oldest. */
  private static readonly POOL_ORDER = `
    ORDER BY EXISTS (
      SELECT 1 FROM answer_peer_reviews g WHERE g.reviewer_id = s.user_id
    ) DESC, s.peer_review_count ASC, s.created_at ASC`;

  // ── GET /answer-writing/review/stats — powers the Peer Review card ──
  async reviewStats(userId: string) {
    const [given]  = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_peer_reviews WHERE reviewer_id = $1`, [userId]
    );
    const [user]   = await this.db.query(
      `SELECT COALESCE(review_credits, 0) AS credits FROM users WHERE id = $1`, [userId]
    );
    const [mine]   = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions WHERE user_id = $1`, [userId]
    );

    // v2: reviewing unlocks as soon as you've submitted your own answer.
    // (Give-to-get is handled by queue priority, not a hard lock.)
    const unlocked = Number(mine?.cnt) > 0;

    let pendingAvailable = 0;
    if (unlocked) {
      const [pool] = await this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM answer_submissions s WHERE ${this.reviewPoolFilter(userId)}`,
        [userId]
      );
      pendingAvailable = Number(pool?.cnt) || 0;
    }

    return successResponse({
      reviewsGiven:     Number(given?.cnt) || 0,
      reviewCredits:    Number(user?.credits) || 0,
      pendingAvailable,
      canReview:        unlocked,
      // Why reviewing is locked — the app shows a friendly explanation
      lockedReason:     unlocked ? null : 'no_submission',
    });
  }

  // ── GET /answer-writing/review/next — next answer to review ──
  async nextToReview(userId: string) {
    const [mine] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions WHERE user_id = $1`, [userId]
    );
    if (Number(mine?.cnt) === 0) {
      throw new ForbiddenException('Submit your own answer first to unlock peer reviewing.');
    }

    const [next] = await this.db.query(
      `SELECT s.id, s.answer_text, s.answer_images, s.answer_pdf, s.word_count, s.created_at,
              q.id AS question_id, q.question_text, q.subject, q.marks, q.word_limit
       FROM answer_submissions s
       JOIN answer_questions q ON q.id = s.question_id
       WHERE ${this.reviewPoolFilter(userId)}
       ${AnswerWritingService.POOL_ORDER}
       LIMIT 1`,
      [userId]
    );

    // Anonymous — deliberately no user identity on the payload
    return successResponse({ submission: next || null });
  }

  // ── GET /answer-writing/review/list — the pool I can pick from ──
  // Same eligibility as review/next, but returns up to 20 so the app can show
  // a browsable list and let the reviewer choose which answer to review
  // (QA 21-07 Issue 12). Still anonymous — no reviewer/author identity leaks.
  async listToReview(userId: string) {
    const [mine] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions WHERE user_id = $1`, [userId]
    );
    if (Number(mine?.cnt) === 0) {
      throw new ForbiddenException('Submit your own answer first to unlock peer reviewing.');
    }

    const rows = await this.db.query(
      `SELECT s.id, s.answer_text, s.answer_images, s.answer_pdf, s.word_count, s.created_at,
              q.id AS question_id, q.question_text, q.subject, q.marks, q.word_limit
       FROM answer_submissions s
       JOIN answer_questions q ON q.id = s.question_id
       WHERE ${this.reviewPoolFilter(userId)}
       ${AnswerWritingService.POOL_ORDER}
       LIMIT 20`,
      [userId]
    );

    return successResponse({ submissions: rows });
  }

  // ── POST /answer-writing/review/:submissionId ─────────────────
  // v2: up to MAX_IMPROVEMENT_AREAS weaknesses per review
  // ("top three weaknesses"). improvementArea (single) still accepted
  // from older app builds.
  async submitPeerReview(
    submissionId: string,
    userId: string,
    body: { verdict?: string; rating?: number; improvementArea?: string; improvementAreas?: string[]; suggestion?: string },
  ) {
    const verdict = String(body?.verdict || '').toLowerCase();
    const rating  = Math.floor(Number(body?.rating));
    const suggestion = (body?.suggestion || '').trim().slice(0, 200) || null;

    // Normalise areas: prefer the v2 array, fall back to the single field
    const rawAreas = Array.isArray(body?.improvementAreas) && body.improvementAreas.length
      ? body.improvementAreas
      : (body?.improvementArea ? [body.improvementArea] : []);
    const areas = [...new Set(rawAreas.map(a => String(a).toLowerCase().trim()).filter(Boolean))];

    if (!REVIEW_VERDICTS.includes(verdict)) throw new BadRequestException('verdict must be yes | partly | no');
    if (isNaN(rating) || rating < 1 || rating > 5) throw new BadRequestException('rating must be 1-5');
    if (areas.length > MAX_IMPROVEMENT_AREAS) throw new BadRequestException(`Pick at most ${MAX_IMPROVEMENT_AREAS} improvement areas`);
    if (areas.some(a => !IMPROVEMENT_AREAS.includes(a))) throw new BadRequestException('Invalid improvement area');

    const [sub] = await this.db.query(
      `SELECT id, user_id, status, peer_review_count FROM answer_submissions WHERE id = $1`,
      [submissionId]
    );
    if (!sub) throw new NotFoundException('Submission not found');
    if (sub.user_id === userId) throw new BadRequestException("You can't review your own answer");
    const [mine] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions WHERE user_id = $1`, [userId]
    );
    if (Number(mine?.cnt) === 0) {
      throw new ForbiddenException('Submit your own answer first to unlock peer reviewing.');
    }

    try {
      await this.db.query(
        `INSERT INTO answer_peer_reviews (submission_id, reviewer_id, verdict, rating, improvement_area, improvement_areas, suggestion)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [submissionId, userId, verdict, rating, areas[0] ?? null, areas.length ? areas : null, suggestion]
      );
    } catch (err: any) {
      if (String(err?.code) === '23505') {
        throw new BadRequestException('You have already reviewed this answer');
      }
      throw err;
    }

    // Recompute count + average, promote to peer_reviewed at the target.
    // (Never demote a mentor-graded 'reviewed' submission.)
    await this.db.query(
      `UPDATE answer_submissions s SET
         peer_review_count = agg.cnt,
         avg_peer_rating   = agg.avg,
         status = CASE
           WHEN s.status = 'reviewed' THEN s.status
           WHEN agg.cnt >= ${PEER_REVIEWS_TARGET} THEN 'peer_reviewed'
           ELSE s.status END,
         updated_at = NOW()
       FROM (
         SELECT COUNT(*)::int AS cnt, ROUND(AVG(rating)::numeric, 2) AS avg
         FROM answer_peer_reviews WHERE submission_id = $1
       ) agg
       WHERE s.id = $1`,
      [submissionId]
    );

    // Review credit for the reviewer (+ coins via the peer_review rule)
    const [me] = await this.db.query(
      `UPDATE users SET review_credits = COALESCE(review_credits, 0) + 1
       WHERE id = $1 RETURNING review_credits`,
      [userId]
    );
    let coinsEarned = 0;
    try {
      coinsEarned = await this.authService.awardCoins(userId, 'peer_review');
    } catch (e) {
      this.logger.warn(`awardCoins(peer_review) failed: ${(e as Error).message}`);
    }

    // Tell the author — anonymously
    this.notifService.pushToUser(
      sub.user_id,
      '🤝 Peer Review Received!',
      `A fellow aspirant rated your answer ${'⭐'.repeat(rating)} — open the app to read it.`,
      { type: 'peer_review_received', screen: 'answer_writing' }
    ).catch(() => {});

    return successResponse({
      reviewCredits: Number(me[0]?.review_credits) || 0,
      coinsEarned,
    }, coinsEarned > 0
      ? `Review submitted! +1 credit · 🪙 +${coinsEarned} coins`
      : 'Review submitted! +1 review credit');
  }
}

// ════════════════════════════════════════════════════════════
// USER CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Answer Writing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('answer-writing')
export class AnswerWritingController {
  constructor(private readonly svc: AnswerWritingService) {}

  /** GET /answer-writing?page=1&limit=20&subject= */
  @Get()
  findAll(
    @Req() r: any,
    @Query('page')    page = 1,
    @Query('limit')   limit = 20,
    @Query('subject') subject?: string,
  ) { return this.svc.findAll(r.user.id, +page, +limit, subject); }

  /** GET /answer-writing/my — my submission history */
  @Get('my')
  mySubmissions(@Req() r: any, @Query('page') page = 1, @Query('limit') limit = 20) {
    return this.svc.mySubmissions(r.user.id, +page, +limit);
  }

  /** GET /answer-writing/insights — personal stats for the Insights tab */
  @Get('insights')
  insights(@Req() r: any) { return this.svc.insights(r.user.id); }

  /** GET /answer-writing/leaderboard — Top Reviewers + Top Writers */
  @Get('leaderboard')
  leaderboard(@Req() r: any) { return this.svc.leaderboard(r.user.id); }

  // ── Peer review (declared before :id so 'review' isn't eaten by it) ──

  /** GET /answer-writing/review/stats — Peer Review card numbers + gate state */
  @Get('review/stats')
  reviewStats(@Req() r: any) { return this.svc.reviewStats(r.user.id); }

  /** GET /answer-writing/review/next — next anonymous answer to review */
  @Get('review/next')
  nextToReview(@Req() r: any) { return this.svc.nextToReview(r.user.id); }

  /** GET /answer-writing/review/list — the anonymous pool to choose from */
  @Get('review/list')
  listToReview(@Req() r: any) { return this.svc.listToReview(r.user.id); }

  /** POST /answer-writing/review/:submissionId — submit a structured peer review */
  @Post('review/:submissionId')
  @HttpCode(HttpStatus.OK)
  submitPeerReview(@Param('submissionId') submissionId: string, @Req() r: any, @Body() body: any) {
    return this.svc.submitPeerReview(submissionId, r.user.id, body);
  }

  /** GET /answer-writing/:id */
  @Get(':id')
  findOne(@Param('id') id: string, @Req() r: any) {
    return this.svc.findOne(id, r.user.id);
  }

  /** POST /answer-writing/:id/submit — typed answer */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id') id: string, @Req() r: any, @Body() body: any) {
    return this.svc.submit(id, r.user.id, body);
  }

  /** POST /answer-writing/:id/submit-photo — handwritten answer photos (1-5) */
  @Post(':id/submit-photo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor('images', MAX_IMAGES, {
    storage: answerImageStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ANSWER_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new BadRequestException('Only JPG/PNG/WebP/HEIC photos are allowed'), false);
    },
  }))
  submitPhoto(
    @Param('id') id: string,
    @Req() r: any,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any,
  ) {
    return this.svc.submitPhoto(id, r.user.id, files, body);
  }

  /** POST /answer-writing/:id/submit-pdf — a single PDF answer */
  @Post(':id/submit-pdf')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('pdf', {
    storage: answerImageStorage(),   // same uploads/answers/<y>/<m> layout
    limits: { fileSize: MAX_PDF_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ANSWER_PDF_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new BadRequestException('Only a PDF file is allowed'), false);
    },
  }))
  submitPdf(
    @Param('id') id: string,
    @Req() r: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    return this.svc.submitPdf(id, r.user.id, file, body);
  }
}

// ════════════════════════════════════════════════════════════
// ADMIN — powers admin.bpscnotes.in/answer-writing
// ════════════════════════════════════════════════════════════
@Injectable()
export class AdminAnswerWritingService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly notifService: NotificationService,
  ) {}

  // ── Questions ────────────────────────────────────────────────

  async listQuestions(query: any) {
    const { page = 1, limit = 20, status, search } = query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (status) { conditions.push(`q.status = $${params.length + 1}`);              params.push(status); }
    if (search) { conditions.push(`q.question_text ILIKE $${params.length + 1}`);   params.push(`%${search}%`); }

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT q.*,
           (SELECT COUNT(*)::int FROM answer_submissions WHERE question_id = q.id)                          AS submission_count,
           (SELECT COUNT(*)::int FROM answer_submissions WHERE question_id = q.id AND status = 'submitted') AS pending_count
         FROM answer_questions q
         WHERE ${conditions.join(' AND ')}
         ORDER BY q.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM answer_questions q WHERE ${conditions.join(' AND ')}`, params),
    ]);
    return successResponse(
      { questions: rows },
      'Success',
      paginationMeta(parseInt(countResult[0].count), page, limit)
    );
  }

  async createQuestion(data: any, adminId: string) {
    if (!data.questionText?.trim()) throw new BadRequestException('Question text is required');
    const rows = await this.db.query(
      `INSERT INTO answer_questions
         (question_text, subject, marks, word_limit, model_answer, tips, scheduled_for, status, created_by, is_pyq, pyq_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        data.questionText.trim(),
        data.subject || null,
        Math.max(1, +data.marks || 10),
        Math.max(50, +data.wordLimit || 250),
        data.modelAnswer || null,
        data.tips || null,
        data.scheduledFor || null,
        data.status === 'published' ? 'published' : 'draft',
        adminId,
        data.isPyq === true,
        data.pyqYear ? +data.pyqYear : null,
      ]
    );
    return successResponse({ question: rows[0] }, 'Question created ✅');
  }

  async updateQuestion(id: string, data: any) {
    const map: Record<string, string> = {
      questionText: 'question_text',
      subject:      'subject',
      marks:        'marks',
      wordLimit:    'word_limit',
      modelAnswer:  'model_answer',
      tips:         'tips',
      scheduledFor: 'scheduled_for',
      status:       'status',
      isPyq:        'is_pyq',
      pyqYear:      'pyq_year',
    };
    const fields: string[] = []; const vals: any[] = []; let i = 1;
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key] === '' ? null : data[key]); }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push('updated_at=NOW()');
    // raw query() returns [rows, affectedCount] for UPDATE/DELETE RETURNING
    const [updated] = await this.db.query(
      `UPDATE answer_questions SET ${fields.join(',')} WHERE id=$${i} RETURNING id`,
      [...vals, id]
    );
    if (!updated.length) throw new NotFoundException('Question not found');
    return successResponse(null, 'Question updated ✅');
  }

  async deleteQuestion(id: string) {
    const [deleted] = await this.db.query(`DELETE FROM answer_questions WHERE id=$1 RETURNING id`, [id]);
    if (!deleted.length) throw new NotFoundException('Question not found');
    return successResponse(null, 'Question deleted');
  }

  // ── Submissions / review queue ───────────────────────────────

  async listSubmissions(query: any) {
    const { page = 1, limit = 20, status, questionId } = query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (status)     { conditions.push(`s.status = $${params.length + 1}`);      params.push(status); }
    if (questionId) { conditions.push(`s.question_id = $${params.length + 1}`); params.push(questionId); }

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT s.id, s.question_id, s.answer_text, s.answer_images, s.answer_pdf, s.word_count, s.time_taken_secs,
                s.status, s.score, s.feedback, s.peer_review_count, s.avg_peer_rating,
                s.created_at, s.reviewed_at,
                u.name  AS user_name, u.id AS user_id,
                q.question_text, q.subject, q.marks, q.word_limit
         FROM answer_submissions s
         JOIN users u            ON u.id = s.user_id
         JOIN answer_questions q ON q.id = s.question_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY (s.status = 'submitted') DESC, s.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM answer_submissions s WHERE ${conditions.join(' AND ')}`, params),
    ]);
    return successResponse(
      { submissions: rows },
      'Success',
      paginationMeta(parseInt(countResult[0].count), page, limit)
    );
  }

  async reviewSubmission(id: string, data: any, adminId: string) {
    const score = Number(data?.score);
    if (isNaN(score) || score < 0) throw new BadRequestException('A valid score is required');

    const [sub] = await this.db.query(
      `SELECT s.id, s.user_id, q.marks, q.question_text
       FROM answer_submissions s JOIN answer_questions q ON q.id = s.question_id
       WHERE s.id = $1`,
      [id]
    );
    if (!sub) throw new NotFoundException('Submission not found');
    if (score > Number(sub.marks)) {
      throw new BadRequestException(`Score can't exceed the question's ${sub.marks} marks`);
    }

    await this.db.query(
      `UPDATE answer_submissions
       SET status='reviewed', score=$1, feedback=$2, reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$4`,
      [score, data?.feedback || null, adminId, id]
    );

    // Best-effort push — never fail the review because FCM hiccuped
    this.notifService.pushToUser(
      sub.user_id,
      '✍️ Answer Reviewed!',
      `You scored ${score}/${sub.marks} — open the app to read your feedback.`,
      { type: 'answer_reviewed', screen: 'answer_writing' }
    ).catch(() => {});

    return successResponse(null, 'Review saved ✅');
  }
}

@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/answer-writing')
export class AdminAnswerWritingController {
  constructor(private readonly svc: AdminAnswerWritingService) {}

  @Get('questions')
  @RequirePermission('quizzes')
  listQuestions(@Query() query: any) { return this.svc.listQuestions(query); }

  @Post('questions')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.CREATED)
  createQuestion(@Body() dto: any, @Req() r: any) {
    return this.svc.createQuestion(dto, r.admin.id);
  }

  @Put('questions/:id')
  @RequirePermission('quizzes')
  updateQuestion(@Param('id') id: string, @Body() dto: any) {
    return this.svc.updateQuestion(id, dto);
  }

  @Delete('questions/:id')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.OK)
  deleteQuestion(@Param('id') id: string) { return this.svc.deleteQuestion(id); }

  @Get('submissions')
  @RequirePermission('quizzes')
  listSubmissions(@Query() query: any) { return this.svc.listSubmissions(query); }

  @Put('submissions/:id/review')
  @RequirePermission('quizzes')
  reviewSubmission(@Param('id') id: string, @Body() dto: any, @Req() r: any) {
    return this.svc.reviewSubmission(id, dto, r.admin.id);
  }
}

@Module({
  imports:     [AuthModule, NotificationsModule],
  controllers: [AnswerWritingController, AdminAnswerWritingController],
  providers:   [AnswerWritingService, AdminAnswerWritingService],
  exports:     [AnswerWritingService],
})
export class AnswerWritingModule {}
