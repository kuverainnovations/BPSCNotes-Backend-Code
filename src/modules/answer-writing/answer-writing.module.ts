import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Body, Param, Query, Req,
  UseGuards, UseInterceptors, UploadedFiles, UploadedFile, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { FilesInterceptor, FileInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
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
// the model answer unlocks the next day → peers review the answer →
// an admin grades it later with a score + feedback → user gets a push.
//
// Powers: AnswerWritingScreen (Android), admin.bpscnotes.in/answer-writing
// Endpoints:
//   GET  /answer-writing               — published questions + my status
//   GET  /answer-writing/my            — my submissions (history tab)
//   GET  /answer-writing/:id           — question detail (+ my submission,
//                                        model answer only the next day,
//                                        peer reviews only once reciprocated)
//   POST /answer-writing/:id/submit    — submit my answer (awards coins)
//   GET  /answer-writing/review/questions   — questions I can review, with
//                                        pending counts (peer review screen 1)
//   GET  /answer-writing/review/list   — answers to review, optionally for
//                                        one question (peer review screen 2)
//   GET  /admin/answer-writing/questions        — admin list + stats
//   POST /admin/answer-writing/questions        — create
//   PUT  /admin/answer-writing/questions/:id    — update
//   DELETE /admin/answer-writing/questions/:id  — delete
//   POST /admin/answer-writing/questions/:id/seed — post a sample answer
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

// Reserved house account that owns seed ("Sample") answers — created by
// migration 1785000000000. Seeds keep the review pool non-empty so the
// first student to answer a question can still unlock their own feedback.
const SEED_USER_MOBILE = '0000000001';

// ── Reviewer reputation ───────────────────────────────────────
// Only the author of a reviewed answer may vote on the review, and the
// rating is the share of a reviewer's VOTED-ON reviews judged helpful,
// mapped onto 1–5 stars. Reviews nobody voted on don't count either way,
// so a reviewer is never punished for reviewing quiet answers.
const RATING_MIN = 1;
const RATING_MAX = 5;
// Below this share, after enough votes to be more than noise, reviews
// stop earning coins. The review is still recorded and still satisfies
// the reciprocity unlock — the incentive to farm coins is what goes, not
// the ability to participate. The app is told why.
const LOW_REPUTATION_RATIO   = 0.25;
const LOW_REPUTATION_MIN_VOTED = 5;

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

/** Root of the served upload tree — main.ts hands this exact dir to the static handler. */
function uploadRoot(): string {
  return (process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads'));
}

/**
 * Answer photo/PDF storage.
 *
 * Both the destination and the year/month bucket are resolved per request:
 * the interceptor decorators are evaluated once at module load, so anything
 * computed out here would freeze the date at server-start (and, before this,
 * pinned uploads to a relative ./uploads that prod's UPLOAD_DIR never sees —
 * every handwritten answer 404'd once the two diverged).
 */
function answerFileStorage() {
  return diskStorage({
    destination: (_req, _file, cb) => {
      const now = new Date();
      const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dest = join(uploadRoot(), 'answers', subDir);
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (_req, file, cb) => {
      const uniqueId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const safeExt = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
      cb(null, `${Date.now()}_${uniqueId}${safeExt}`);
    },
  });
}

/** Disk path → public URL, relative to whichever upload root is configured. */
function answerFileUrl(diskPath: string, base: string): string {
  const root = uploadRoot().replace(/\\/g, '/').replace(/\/+$/, '');
  let key = diskPath.replace(/\\/g, '/');
  if (key.startsWith(root)) key = key.slice(root.length);
  key = key.replace(/^\/+/, '').replace(/^\.?\/?uploads\//, '');
  return `${base}/uploads/${key}`;
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
    return answerFileUrl(diskPath, this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in');
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
           (SELECT COUNT(*)::int FROM answer_submissions
              WHERE question_id = q.id AND is_seed = FALSE) AS submission_count
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
            JOIN answer_submissions s ON s.id = pr.submission_id
            WHERE s.user_id = $1 AND ${AnswerWritingService.RECIPROCATED('s.question_id')})                        AS avg_rating,
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

    // "Top three weaknesses" — most-flagged improvement areas across the
    // peer reviews received on my answers. Reviews I have not yet earned
    // the right to read (reciprocity) are excluded: the weakness list is
    // their content in summary form.
    const weaknessRows = await this.db.query(
      `SELECT area, COUNT(*)::int AS cnt FROM (
         SELECT unnest(
           COALESCE(pr.improvement_areas,
                    CASE WHEN pr.improvement_area IS NOT NULL
                         THEN ARRAY[pr.improvement_area] ELSE ARRAY[]::text[] END)
         ) AS area
         FROM answer_peer_reviews pr
         JOIN answer_submissions s ON s.id = pr.submission_id
         WHERE s.user_id = $1 AND ${AnswerWritingService.RECIPROCATED('s.question_id')}
       ) t GROUP BY area ORDER BY cnt DESC LIMIT 3`,
      [userId]
    );

    // Reviewer standing + what reviewing has actually paid out, and where
    // this user sits among reviewers (client: "Ranking #18").
    const reputation = await this.reviewerReputation(userId);
    const [coinRow] = await this.db.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS coins
       FROM coin_transactions WHERE user_id = $1 AND action = 'peer_review'`,
      [userId]
    );
    const [rankRow] = await this.db.query(
      `SELECT rank FROM (
         SELECT reviewer_id, RANK() OVER (ORDER BY COUNT(*) DESC)::int AS rank
         FROM answer_peer_reviews GROUP BY reviewer_id
       ) r WHERE r.reviewer_id = $1`,
      [userId]
    );

    const monthlyGoal = 10; // answers per month — product default
    return successResponse({
      helpfulReviews:  reputation.helpfulReviews,
      votedReviews:    reputation.votedReviews,
      reviewerRating:  reputation.reviewerRating,
      lowReputation:   reputation.lowReputation,
      coinsFromReviews: Number(coinRow?.coins) || 0,
      reviewerRank:    rankRow?.rank != null ? Number(rankRow.rank) : null,
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
    // Reviewers rank on volume, but the helpful share is shown beside it so
    // the board rewards useful reviewing rather than fast reviewing.
    const topReviewers = await this.db.query(
      `SELECT u.name, COUNT(*)::int AS reviews_given,
              COALESCE(u.review_credits, 0) AS review_credits,
              COUNT(*) FILTER (WHERE pr.helpful_votes > pr.unhelpful_votes)::int AS helpful_reviews,
              CASE WHEN COUNT(*) FILTER (WHERE pr.helpful_votes + pr.unhelpful_votes > 0) > 0
                   THEN ROUND((${RATING_MIN} + (${RATING_MAX} - ${RATING_MIN}) *
                        (COUNT(*) FILTER (WHERE pr.helpful_votes > pr.unhelpful_votes)::numeric
                         / NULLIF(COUNT(*) FILTER (WHERE pr.helpful_votes + pr.unhelpful_votes > 0), 0)))::numeric, 1)
                   ELSE NULL END AS reviewer_rating,
              (u.id = $1) AS is_me
       FROM answer_peer_reviews pr
       JOIN users u ON u.id = pr.reviewer_id
       GROUP BY u.id, u.name, u.review_credits
       ORDER BY reviews_given DESC, helpful_reviews DESC, review_credits DESC
       LIMIT 10`,
      [userId]
    );
    // Sample answers never appear here, and my own rows are excluded until
    // I have reciprocated on that question — otherwise the leaderboard
    // hands me the rating the detail screen is withholding.
    const topWriters = await this.db.query(
      `SELECT u.name,
              COUNT(s.id)::int AS answers,
              ROUND(AVG(s.avg_peer_rating)::numeric, 1) AS avg_rating,
              (u.id = $1) AS is_me
       FROM answer_submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.avg_peer_rating IS NOT NULL
         AND s.is_seed = FALSE
         AND (u.id <> $1 OR ${AnswerWritingService.RECIPROCATED('s.question_id')})
       GROUP BY u.id, u.name
       HAVING COUNT(s.id) >= 1
       ORDER BY avg_rating DESC, answers DESC
       LIMIT 10`,
      [userId]
    );
    return successResponse({ topReviewers, topWriters });
  }

  /**
   * SQL: "I have reviewed someone's answer to this question" ($1 = userId).
   * The reciprocity test used by the list + aggregate queries. findOne uses
   * the fuller peerReviewUnlock(), which also unlocks when there is nothing
   * left to review; these queries stay conservative on purpose — erring
   * towards hiding a rating is cheaper than leaking one.
   */
  private static readonly RECIPROCATED = (questionCol: string) => `
    EXISTS (
      SELECT 1 FROM answer_peer_reviews pr
      JOIN answer_submissions rs ON rs.id = pr.submission_id
      WHERE pr.reviewer_id = $1 AND rs.question_id = ${questionCol}
    )`;

  // ── GET /answer-writing/my — my submission history ────────────
  // avg_peer_rating is withheld on questions I have not reciprocated on —
  // it is a summary of the reviews the detail screen is hiding. The count
  // stays visible: it is the reason to go and review someone.
  async mySubmissions(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const reciprocated = AnswerWritingService.RECIPROCATED('ms.question_id');
    const rows = await this.db.query(
      `SELECT ms.id, ms.question_id, ms.word_count, ms.status, ms.score, ms.feedback,
              ms.answer_images, ms.answer_pdf, ms.peer_review_count,
              CASE WHEN ${reciprocated} OR NOT EXISTS (
                     SELECT 1 FROM answer_submissions s
                     WHERE s.question_id = ms.question_id AND ${this.reviewPoolFilter(userId)}
                   ) THEN ms.avg_peer_rating ELSE NULL END          AS avg_peer_rating,
              NOT (${reciprocated} OR NOT EXISTS (
                     SELECT 1 FROM answer_submissions s
                     WHERE s.question_id = ms.question_id AND ${this.reviewPoolFilter(userId)}
                   ))                                               AS peer_reviews_locked,
              ms.created_at, ms.reviewed_at,
              q.question_text, q.subject, q.marks, q.word_limit
       FROM answer_submissions ms
       JOIN answer_questions q ON q.id = ms.question_id
       WHERE ms.user_id = $1
       ORDER BY ms.created_at DESC
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

    // Peer reviews received on MY submission — anonymous (no reviewer
    // identity), and held back until I have reviewed someone else's answer
    // to this same question (client reciprocity rule).
    let peerReviews: any[] = [];
    let gate = { unlocked: true, reviewsGivenHere: 0, reviewableCount: 0 };
    if (sub) {
      gate = await this.peerReviewUnlock(userId, questionId);
      if (gate.unlocked) {
        // Ordered most-useful-first (the client's "Top Review Highlights"):
        // reviews the author found helpful rise, ones they marked unhelpful
        // sink, unvoted ones sit in between by recency.
        peerReviews = await this.db.query(
          `SELECT pr.id, pr.verdict, pr.rating, pr.improvement_area, pr.improvement_areas,
                  pr.suggestion, pr.created_at, pr.helpful_votes, pr.unhelpful_votes,
                  v.helpful AS my_vote
           FROM answer_peer_reviews pr
           LEFT JOIN answer_review_votes v ON v.review_id = pr.id AND v.voter_id = $2
           WHERE pr.submission_id = $1
           ORDER BY (pr.helpful_votes - pr.unhelpful_votes) DESC, pr.created_at DESC`,
          [sub.id, userId]
        );
      } else {
        // Locked: the count is the carrot ("2 reviews waiting"), but the
        // average rating summarises the hidden content, so it goes too.
        sub.avg_peer_rating = null;
      }
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
      // Reciprocity state for this question — drives the locked card + CTA
      peerReviewsLocked: !!sub && !gate.unlocked,
      peerReviewCount:   sub ? Number(sub.peer_review_count) || 0 : 0,
      reviewableCount:   gate.reviewableCount,
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
  // PEER REVIEW — per-question reciprocity (client rule, 23 Jul)
  //
  // "The review section for your answer to a particular question
  //  unlocks only after you review another user's answer for that
  //  same question."
  //
  // Note what this gates: VISIBILITY of the feedback you received,
  // not eligibility. Your answer enters the pool the moment you
  // submit it, so the pool never dries up — you simply can't read
  // your reviews until you've given one on the same question.
  // See peerReviewUnlock().
  //
  // Gate A — you may only review answers to questions you also
  //          submitted (competence + skin in the game).
  // Assignment: never your own answer, never one you already
  // reviewed, capped at PEER_REVIEWS_MAX, anonymous both ways.
  //
  // Seed answers (is_seed) are house-authored samples that keep the
  // pool non-empty on a brand-new question. They are exempt from the
  // cap — one seed must be able to unlock every student, not just the
  // first PEER_REVIEWS_MAX of them — and they sort LAST so real
  // students' answers always get the review capacity first.
  // ═══════════════════════════════════════════════════════════

  /** WHERE clause for the pool of answers this user may STILL review ($1 = userId).
   *  Excludes ones they've already reviewed — used for counts + reciprocity. */
  private reviewPoolFilter(userId: string) {
    return `
      s.user_id != $1
      AND s.status != 'reviewed'
      AND (s.is_seed OR s.peer_review_count < ${PEER_REVIEWS_MAX})
      AND s.question_id IN (SELECT question_id FROM answer_submissions WHERE user_id = $1)
      AND NOT EXISTS (
        SELECT 1 FROM answer_peer_reviews pr
        WHERE pr.submission_id = s.id AND pr.reviewer_id = $1
      )`;
  }

  /** WHERE clause for the answers a user may SEE in the review list ($1 = userId).
   *  Like the pool, but keeps answers they've already reviewed so they stay on
   *  the list to read and learn from (client, 26 Jul) — the app shows those
   *  read-only with the review already given. */
  private reviewVisibleFilter(userId: string) {
    return `
      s.user_id != $1
      AND s.status != 'reviewed'
      AND s.question_id IN (SELECT question_id FROM answer_submissions WHERE user_id = $1)
      AND (
        s.is_seed OR s.peer_review_count < ${PEER_REVIEWS_MAX}
        OR EXISTS (
          SELECT 1 FROM answer_peer_reviews pr
          WHERE pr.submission_id = s.id AND pr.reviewer_id = $1
        )
      )`;
  }

  /** Not-yet-reviewed first, then real answers before samples, neediest/oldest. */
  private static readonly POOL_ORDER = `
    ORDER BY
      EXISTS (SELECT 1 FROM answer_peer_reviews m WHERE m.submission_id = s.id AND m.reviewer_id = $1) ASC,
      s.is_seed ASC,
      EXISTS (SELECT 1 FROM answer_peer_reviews g WHERE g.reviewer_id = s.user_id) DESC,
      s.peer_review_count ASC, s.created_at ASC`;

  /**
   * Per-question reciprocity check.
   *
   * Unlocked when the user has given ≥1 review on this question, OR when
   * there is nothing left for them to review on it. The second arm is the
   * safety net behind seeding: seeding is a manual step in a daily
   * workflow, and when it gets missed a student should see their feedback
   * rather than be blocked by an empty pool they can do nothing about.
   */
  private async peerReviewUnlock(userId: string, questionId: string) {
    const [given] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM answer_peer_reviews pr
       JOIN answer_submissions s ON s.id = pr.submission_id
       WHERE pr.reviewer_id = $1 AND s.question_id = $2`,
      [userId, questionId]
    );
    const reviewsGivenHere = Number(given?.cnt) || 0;

    const [pool] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions s
       WHERE s.question_id = $2 AND ${this.reviewPoolFilter(userId)}`,
      [userId, questionId]
    );
    const reviewableCount = Number(pool?.cnt) || 0;

    return {
      unlocked: reviewsGivenHere > 0 || reviewableCount === 0,
      reviewsGivenHere,
      reviewableCount,
    };
  }

  // ── GET /answer-writing/review/questions — peer review screen 1 ──
  // Questions I have attempted that still have answers waiting for my
  // review, neediest first. `myReviewsHere` drives the "unlocked" tick,
  // so a student can see at a glance which of their own answers are
  // still waiting on a review from them.
  async reviewQuestions(userId: string) {
    const rows = await this.db.query(
      `SELECT q.id, q.question_text, q.subject, q.marks, q.word_limit,
              COALESCE(q.is_pyq, FALSE) AS is_pyq, q.pyq_year,
              (SELECT COUNT(*)::int FROM answer_submissions s
                 WHERE s.question_id = q.id AND ${this.reviewPoolFilter(userId)})    AS pending_count,
              (SELECT COUNT(*)::int FROM answer_submissions s
                 WHERE s.question_id = q.id AND ${this.reviewVisibleFilter(userId)}) AS answer_count,
              (SELECT COUNT(*)::int FROM answer_peer_reviews pr
                 JOIN answer_submissions s2 ON s2.id = pr.submission_id
                 WHERE pr.reviewer_id = $1 AND s2.question_id = q.id)            AS my_reviews_here,
              (SELECT COALESCE(peer_review_count, 0) FROM answer_submissions
                 WHERE question_id = q.id AND user_id = $1)                      AS my_reviews_received
       FROM answer_questions q
       WHERE q.status = 'published'
         AND q.id IN (SELECT question_id FROM answer_submissions WHERE user_id = $1)
       ORDER BY pending_count DESC, q.scheduled_for DESC NULLS LAST, q.created_at DESC`,
      [userId]
    );

    return successResponse({
      // Keep any question that still has answers I can open (to review OR to
      // re-read), not just ones with pending reviews.
      questions: rows
        .filter((r: any) => Number(r.answer_count) > 0)
        .map((r: any) => ({
          ...r,
          pending_count:       Number(r.pending_count) || 0,
          answer_count:        Number(r.answer_count) || 0,
          my_reviews_here:     Number(r.my_reviews_here) || 0,
          my_reviews_received: Number(r.my_reviews_received) || 0,
          // true → reviewing here unlocks the feedback on my own answer
          unlocks_my_reviews:  Number(r.my_reviews_here) === 0 && Number(r.my_reviews_received) > 0,
        })),
      totalPending: rows.reduce((n: number, r: any) => n + (Number(r.pending_count) || 0), 0),
    });
  }

  // ═══════════════════════════════════════════════════════════
  // REVIEWER REPUTATION
  // ═══════════════════════════════════════════════════════════

  /**
   * A reviewer's standing, from the votes their reviews received.
   *
   * voted   — my reviews that got at least one vote
   * helpful — of those, the ones the author judged useful
   * rating  — helpful share on a 1–5 scale, null until anything is voted
   */
  private async reviewerReputation(userId: string) {
    const [row] = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE helpful_votes + unhelpful_votes > 0)::int AS voted,
         COUNT(*) FILTER (WHERE helpful_votes > unhelpful_votes)::int     AS helpful,
         COUNT(*)::int                                                    AS given
       FROM answer_peer_reviews WHERE reviewer_id = $1`,
      [userId]
    );
    const voted   = Number(row?.voted) || 0;
    const helpful = Number(row?.helpful) || 0;
    const ratio   = voted > 0 ? helpful / voted : null;
    return {
      reviewsGiven:   Number(row?.given) || 0,
      helpfulReviews: helpful,
      votedReviews:   voted,
      helpfulRatio:   ratio,
      reviewerRating: ratio === null
        ? null
        : Math.round((RATING_MIN + (RATING_MAX - RATING_MIN) * ratio) * 10) / 10,
      // Coins are withheld once a reviewer is demonstrably unhelpful
      lowReputation: voted >= LOW_REPUTATION_MIN_VOTED && (ratio ?? 1) < LOW_REPUTATION_RATIO,
    };
  }

  // ── POST /answer-writing/review/:reviewId/vote ────────────────
  // "Was this review useful?" — answered by the author of the reviewed
  // answer, who is the only person positioned to judge it. Voting again
  // changes the vote rather than erroring, so a mis-tap is recoverable.
  async voteOnReview(reviewId: string, userId: string, body: { helpful?: boolean }) {
    if (typeof body?.helpful !== 'boolean') {
      throw new BadRequestException('helpful must be true or false');
    }

    const [review] = await this.db.query(
      `SELECT pr.id, pr.reviewer_id, s.user_id AS author_id, s.question_id
       FROM answer_peer_reviews pr
       JOIN answer_submissions s ON s.id = pr.submission_id
       WHERE pr.id = $1`,
      [reviewId]
    );
    if (!review) throw new NotFoundException('Review not found');
    if (review.author_id !== userId) {
      throw new ForbiddenException('Only the author of the answer can rate this review');
    }
    // You must be able to READ a review before judging it, so the same
    // reciprocity gate applies here.
    const gate = await this.peerReviewUnlock(userId, review.question_id);
    if (!gate.unlocked) {
      throw new ForbiddenException('Review one answer on this question to unlock your reviews first');
    }

    await this.db.query(
      `INSERT INTO answer_review_votes (review_id, voter_id, helpful)
       VALUES ($1, $2, $3)
       ON CONFLICT (review_id, voter_id)
       DO UPDATE SET helpful = EXCLUDED.helpful, updated_at = NOW()`,
      [reviewId, userId, body.helpful]
    );

    const [counts] = await this.db.query(
      `UPDATE answer_peer_reviews pr SET
         helpful_votes   = agg.helpful,
         unhelpful_votes = agg.unhelpful
       FROM (
         SELECT COUNT(*) FILTER (WHERE helpful)::int     AS helpful,
                COUNT(*) FILTER (WHERE NOT helpful)::int AS unhelpful
         FROM answer_review_votes WHERE review_id = $1
       ) agg
       WHERE pr.id = $1
       RETURNING pr.helpful_votes, pr.unhelpful_votes`,
      [reviewId]
    );

    return successResponse({
      helpfulVotes:   Number(counts?.[0]?.helpful_votes) || 0,
      unhelpfulVotes: Number(counts?.[0]?.unhelpful_votes) || 0,
      myVote:         body.helpful,
    }, body.helpful ? 'Thanks — marked as helpful' : 'Thanks for the feedback');
  }

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

  // ── GET /answer-writing/review/list — the answers I can pick from ──
  // Returns a browsable list so the reviewer chooses which answer to review
  // (QA 21-07 Issue 12). Pass questionId for peer review screen 2 — the
  // answers under one question. Still anonymous — no reviewer/author leaks.
  //
  // Answers the user has ALREADY reviewed stay on the list (client, 26 Jul):
  // students learn from reading other answers, so a reviewed one isn't
  // removed — it comes back with `reviewed_by_me` + the review they gave, and
  // the app shows it read-only. Not-yet-reviewed answers sort first.
  //
  // Deliberately NOT returned per answer: avg_peer_rating. A visible score
  // anchors the reviewer to the existing average before they have formed
  // their own view. peer_review_count is safe and useful — it tells the
  // reviewer which answers still need help.
  async listToReview(userId: string, questionId?: string) {
    const [mine] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions WHERE user_id = $1`, [userId]
    );
    if (Number(mine?.cnt) === 0) {
      throw new ForbiddenException('Submit your own answer first to unlock peer reviewing.');
    }

    const params: any[] = [userId];
    let scope = '';
    if (questionId) { params.push(questionId); scope = `AND s.question_id = $${params.length}`; }

    const rows = await this.db.query(
      `SELECT s.id, s.answer_text, s.answer_images, s.answer_pdf, s.word_count, s.created_at,
              s.peer_review_count, s.is_seed,
              q.id AS question_id, q.question_text, q.subject, q.marks, q.word_limit,
              (mine.id IS NOT NULL)      AS reviewed_by_me,
              mine.verdict               AS my_verdict,
              mine.rating                AS my_rating,
              mine.improvement_area      AS my_improvement_area,
              mine.improvement_areas     AS my_improvement_areas,
              mine.suggestion            AS my_suggestion
       FROM answer_submissions s
       JOIN answer_questions q ON q.id = s.question_id
       LEFT JOIN answer_peer_reviews mine ON mine.submission_id = s.id AND mine.reviewer_id = $1
       WHERE ${this.reviewVisibleFilter(userId)} ${scope}
       ${AnswerWritingService.POOL_ORDER}
       LIMIT ${questionId ? 50 : 20}`,
      params
    );

    // On a per-question list, tell the app whether reviewing here unlocks
    // the feedback on the user's own answer — it drives the banner copy.
    let unlocksMyReviews = false;
    if (questionId) {
      const gate = await this.peerReviewUnlock(userId, questionId);
      const [mineHere] = await this.db.query(
        `SELECT COALESCE(peer_review_count, 0)::int AS cnt
         FROM answer_submissions WHERE question_id = $1 AND user_id = $2`,
        [questionId, userId]
      );
      unlocksMyReviews = !gate.unlocked && Number(mineHere?.cnt) > 0;
    }

    return successResponse({ submissions: rows, unlocksMyReviews });
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
      `SELECT id, user_id, question_id, status, peer_review_count, is_seed
       FROM answer_submissions WHERE id = $1`,
      [submissionId]
    );
    if (!sub) throw new NotFoundException('Submission not found');
    if (sub.user_id === userId) throw new BadRequestException("You can't review your own answer");

    // Gate A on the write path too — the pool query enforces it when the
    // app picks an answer, but the invariant shouldn't live in only one
    // place. Same for the review cap (a stale list could push past it).
    const [mine] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM answer_submissions
       WHERE user_id = $1 AND question_id = $2`,
      [userId, sub.question_id]
    );
    if (Number(mine?.cnt) === 0) {
      throw new ForbiddenException('Answer this question yourself before reviewing others.');
    }
    if (!sub.is_seed && Number(sub.peer_review_count) >= PEER_REVIEWS_MAX) {
      throw new BadRequestException('This answer already has enough reviews — try another one.');
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
    // Coins, unless this reviewer's own reviews are consistently voted
    // unhelpful. The review still counts and still unlocks their feedback —
    // what stops is the reward for churning them out.
    const reputation = await this.reviewerReputation(userId);
    let coinsEarned = 0;
    if (!reputation.lowReputation) {
      try {
        coinsEarned = await this.authService.awardCoins(userId, 'peer_review');
      } catch (e) {
        this.logger.warn(`awardCoins(peer_review) failed: ${(e as Error).message}`);
      }
    }

    // Tell the author — anonymously, and without leaking the rating, which
    // they may not have unlocked yet. Sample answers have no author to tell.
    if (!sub.is_seed) {
      const [authorGate] = await this.db.query(
        `SELECT ${AnswerWritingService.RECIPROCATED('$2')} AS reciprocated`,
        [sub.user_id, sub.question_id]
      );
      this.notifService.pushToUser(
        sub.user_id,
        '🤝 Peer Review Received!',
        authorGate?.reciprocated
          ? 'A fellow aspirant reviewed your answer — open the app to read it.'
          : 'A fellow aspirant reviewed your answer — review one answer on this question to unlock it.',
        { type: 'peer_review_received', screen: 'answer_writing', questionId: sub.question_id }
      ).catch(() => {});
    }

    // Did this review just unlock the reviewer's own feedback here?
    const unlockedOwn = await this.peerReviewUnlock(userId, sub.question_id);
    const [ownAnswer] = await this.db.query(
      `SELECT COALESCE(peer_review_count, 0)::int AS cnt
       FROM answer_submissions WHERE question_id = $1 AND user_id = $2`,
      [sub.question_id, userId]
    );
    const justUnlocked = unlockedOwn.reviewsGivenHere === 1 && Number(ownAnswer?.cnt) > 0;

    return successResponse({
      reviewCredits: Number(me[0]?.review_credits) || 0,
      coinsEarned,
      // Told, not silently withheld — the app shows why
      lowReputation:     reputation.lowReputation,
      reviewerRating:    reputation.reviewerRating,
      // true → the app pops "your reviews are now unlocked" and offers to open them
      unlockedMyReviews: justUnlocked,
      myReviewCount:     Number(ownAnswer?.cnt) || 0,
      questionId:        sub.question_id,
    }, reputation.lowReputation
      ? 'Review submitted. Your recent reviews were rated unhelpful, so this one earns no coins — more specific feedback earns them back.'
      : justUnlocked
      ? `Review submitted! Your own reviews on this question are now unlocked 🔓`
      : coinsEarned > 0
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

  /** GET /answer-writing/review/questions — questions with answers awaiting my review */
  @Get('review/questions')
  reviewQuestions(@Req() r: any) { return this.svc.reviewQuestions(r.user.id); }

  /** GET /answer-writing/review/list?questionId= — the anonymous pool to choose from */
  @Get('review/list')
  listToReview(@Req() r: any, @Query('questionId') questionId?: string) {
    return this.svc.listToReview(r.user.id, questionId);
  }

  /** POST /answer-writing/review/:submissionId — submit a structured peer review */
  @Post('review/:submissionId')
  @HttpCode(HttpStatus.OK)
  submitPeerReview(@Param('submissionId') submissionId: string, @Req() r: any, @Body() body: any) {
    return this.svc.submitPeerReview(submissionId, r.user.id, body);
  }

  /**
   * POST /answer-writing/review/vote/:reviewId — "was this review useful?"
   * Answered by the author of the reviewed answer. Body: { helpful: boolean }.
   */
  @Post('review/vote/:reviewId')
  @HttpCode(HttpStatus.OK)
  voteOnReview(@Param('reviewId') reviewId: string, @Req() r: any, @Body() body: any) {
    return this.svc.voteOnReview(reviewId, r.user.id, body);
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
    storage: answerFileStorage(),
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
    storage: answerFileStorage(),   // same uploads/answers/<y>/<m> layout
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
    private readonly config: ConfigService,
  ) {}

  // ── Questions ────────────────────────────────────────────────

  async listQuestions(query: any) {
    const { page = 1, limit = 20, status, search } = query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (status) { conditions.push(`q.status = $${params.length + 1}`);              params.push(status); }
    if (search) { conditions.push(`q.question_text ILIKE $${params.length + 1}`);   params.push(`%${search}%`); }

    // pending_count counts everything a mentor still has to grade —
    // 'peer_reviewed' answers are ungraded too, they've just been through
    // peer review. Counting only 'submitted' hid them from the queue.
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT q.*,
           (SELECT COUNT(*)::int FROM answer_submissions
              WHERE question_id = q.id AND is_seed = FALSE)                          AS submission_count,
           (SELECT COUNT(*)::int FROM answer_submissions
              WHERE question_id = q.id AND is_seed = FALSE
                AND status IN ('submitted', 'peer_reviewed'))                        AS pending_count,
           (SELECT COUNT(*)::int FROM answer_submissions
              WHERE question_id = q.id AND is_seed = TRUE)                           AS seed_count
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
    // A sample answer seeds peer review, but it isn't mandatory: if a student
    // has nothing to review, findOne auto-unlocks their own reviews. So a
    // question can be published straight away; the sample is a recommended
    // extra, nudged in the admin UI, not a hard gate.
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

  // ── Seed ("Sample") answers ──────────────────────────────────
  // Peer review is reciprocal per question: a student unlocks the reviews on
  // their own answer by reviewing someone else's answer to the same question.
  // A house-authored sample answer gives the first student something to
  // review. It's recommended but optional — if the pool is empty, findOne
  // auto-unlocks the student's reviews — so it no longer gates publishing.

  /** The reserved house account that owns every sample answer. */
  private async seedUserId(): Promise<string> {
    const [u] = await this.db.query(`SELECT id FROM users WHERE mobile = $1`, [SEED_USER_MOBILE]);
    if (!u) {
      throw new BadRequestException(
        'The sample-answer account is missing — run migration 1785000000000 on this database.'
      );
    }
    return u.id;
  }

  /**
   * Create (or replace) the sample answer for a question. Accepts the same
   * three formats a student can submit: typed text, up to 5 photos, or a
   * single PDF. One sample per question — posting again replaces it.
   */
  async createSeedAnswer(
    questionId: string,
    data: any,
    files: { images?: Express.Multer.File[]; pdf?: Express.Multer.File[] } | undefined,
  ) {
    const [q] = await this.db.query(
      `SELECT id FROM answer_questions WHERE id = $1`, [questionId]
    );
    if (!q) throw new NotFoundException('Question not found');

    const base = this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in';
    const images = (files?.images ?? []).map(f => answerFileUrl(f.path, base));
    const pdfFile = files?.pdf?.[0];
    const pdf = pdfFile ? answerFileUrl(pdfFile.path, base) : null;
    const text = (data?.answerText || '').trim() || null;

    if (!text && !images.length && !pdf) {
      throw new BadRequestException('A sample answer needs text, photos or a PDF');
    }

    const wordCount = text
      ? countWords(text)
      : Math.max(0, Math.floor(Number(data?.wordCount) || 0));
    const userId = await this.seedUserId();

    // UNIQUE(question_id, user_id) — one sample per question, so an upsert
    // lets an admin correct a sample without deleting it first.
    const rows = await this.db.query(
      `INSERT INTO answer_submissions
         (question_id, user_id, answer_text, answer_images, answer_pdf, word_count, is_seed)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (question_id, user_id) DO UPDATE SET
         answer_text   = EXCLUDED.answer_text,
         answer_images = EXCLUDED.answer_images,
         answer_pdf    = EXCLUDED.answer_pdf,
         word_count    = EXCLUDED.word_count,
         updated_at    = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [questionId, userId, text, images.length ? images : null, pdf, wordCount]
    );

    return successResponse(
      { seed: rows[0] },
      rows[0]?.inserted ? 'Sample answer added ✅' : 'Sample answer replaced ✅'
    );
  }

  async deleteSeedAnswer(questionId: string) {
    const [deleted] = await this.db.query(
      `DELETE FROM answer_submissions WHERE question_id = $1 AND is_seed = TRUE RETURNING id`,
      [questionId]
    );
    if (!deleted.length) throw new NotFoundException('No sample answer on this question');
    return successResponse(null, 'Sample answer removed');
  }

  // ── Submissions / review queue ───────────────────────────────

  async listSubmissions(query: any) {
    const { page = 1, limit = 20, status, questionId } = query;
    const offset = (page - 1) * limit;
    // Sample answers are house-authored — nobody is waiting on a grade for
    // them, so they never enter the mentor queue.
    const conditions = ['s.is_seed = FALSE'];
    const params: any[] = [];
    // 'pending' = everything a mentor still has to grade. An answer that has
    // been through peer review is still ungraded — filtering on 'submitted'
    // alone dropped it out of the queue the moment it hit two peer reviews.
    if (status === 'pending') {
      conditions.push(`s.status IN ('submitted', 'peer_reviewed')`);
    } else if (status) {
      conditions.push(`s.status = $${params.length + 1}`);      params.push(status);
    }
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
         ORDER BY (s.status <> 'reviewed') DESC, s.created_at DESC
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

  /**
   * POST /admin/answer-writing/questions/:id/seed — the sample answer that
   * seeds peer review. Same three formats a student can submit.
   */
  @Post('questions/:id/seed')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileFieldsInterceptor(
    [{ name: 'images', maxCount: MAX_IMAGES }, { name: 'pdf', maxCount: 1 }],
    {
      storage: answerFileStorage(),
      limits: { fileSize: MAX_PDF_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = file.fieldname === 'pdf'
          ? ANSWER_PDF_TYPES.includes(file.mimetype)
          : ANSWER_IMAGE_TYPES.includes(file.mimetype);
        if (ok) cb(null, true);
        else cb(new BadRequestException('Sample answers take JPG/PNG/WebP/HEIC photos or a PDF'), false);
      },
    },
  ))
  createSeedAnswer(
    @Param('id') id: string,
    @UploadedFiles() files: { images?: Express.Multer.File[]; pdf?: Express.Multer.File[] },
    @Body() dto: any,
  ) {
    return this.svc.createSeedAnswer(id, dto, files);
  }

  @Delete('questions/:id/seed')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.OK)
  deleteSeedAnswer(@Param('id') id: string) { return this.svc.deleteSeedAnswer(id); }

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
