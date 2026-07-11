import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Body, Param, Query, Req,
  UseGuards, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

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

// ════════════════════════════════════════════════════════════
// USER SERVICE
// ════════════════════════════════════════════════════════════
@Injectable()
export class AnswerWritingService {
  private readonly logger = new Logger(AnswerWritingService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly authService: AuthService,
  ) {}

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

  // ── GET /answer-writing/my — my submission history ────────────
  async mySubmissions(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const rows = await this.db.query(
      `SELECT s.id, s.question_id, s.word_count, s.status, s.score, s.feedback,
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
  // The model answer is anti-spoiler: only returned once this user
  // has submitted their own attempt.
  async findOne(questionId: string, userId: string) {
    const [q] = await this.db.query(
      `SELECT id, question_text, subject, marks, word_limit, tips,
              model_answer, scheduled_for, created_at
       FROM answer_questions WHERE id = $1 AND status = 'published'`,
      [questionId]
    );
    if (!q) throw new NotFoundException('Question not found');

    const [sub] = await this.db.query(
      `SELECT id, answer_text, word_count, time_taken_secs, status, score,
              feedback, created_at, reviewed_at
       FROM answer_submissions WHERE question_id = $1 AND user_id = $2`,
      [questionId, userId]
    );

    const { model_answer, ...rest } = q;
    return successResponse({
      question: {
        ...rest,
        // revealed only after the user's own attempt is in
        model_answer: sub ? model_answer : null,
      },
      submission: sub || null,
    });
  }

  // ── POST /answer-writing/:id/submit ───────────────────────────
  async submit(questionId: string, userId: string, body: { answerText?: string; timeTakenSecs?: number }) {
    const answerText = (body?.answerText || '').trim();
    if (!answerText) throw new BadRequestException('Answer text is required');
    if (answerText.length > 30000) throw new BadRequestException('Answer is too long');

    const [q] = await this.db.query(
      `SELECT id, question_text, marks, word_limit, model_answer
       FROM answer_questions WHERE id = $1 AND status = 'published'`,
      [questionId]
    );
    if (!q) throw new NotFoundException('Question not found');

    const wordCount    = countWords(answerText);
    const timeTaken    = Math.max(0, Math.floor(Number(body?.timeTakenSecs) || 0)) || null;

    let submission: any;
    try {
      const rows = await this.db.query(
        `INSERT INTO answer_submissions (question_id, user_id, answer_text, word_count, time_taken_secs)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, answer_text, word_count, time_taken_secs, status, score, feedback, created_at`,
        [questionId, userId, answerText, wordCount, timeTaken]
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
      // model answer unlocks right away so they can self-compare
      modelAnswer: q.model_answer || null,
    }, coinsEarned > 0
      ? `Answer submitted! 🪙 +${coinsEarned} coins — compare it with the model answer.`
      : 'Answer submitted! Compare it with the model answer.');
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

  /** GET /answer-writing/:id */
  @Get(':id')
  findOne(@Param('id') id: string, @Req() r: any) {
    return this.svc.findOne(id, r.user.id);
  }

  /** POST /answer-writing/:id/submit */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id') id: string, @Req() r: any, @Body() body: any) {
    return this.svc.submit(id, r.user.id, body);
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
         (question_text, subject, marks, word_limit, model_answer, tips, scheduled_for, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
        `SELECT s.id, s.question_id, s.answer_text, s.word_count, s.time_taken_secs,
                s.status, s.score, s.feedback, s.created_at, s.reviewed_at,
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
