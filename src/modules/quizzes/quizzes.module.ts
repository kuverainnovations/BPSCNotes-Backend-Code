// ── quizzes.module.ts — Complete production version ──────────────────────────
import {
  Module, Injectable, Controller, Get, Post, Put, Delete, Body,
  Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException,
  UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { AchievementsService, WeeklyChallengesService, AchievementsModule } from '../achievements/achievements.module';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthService } from '../auth/auth.module';

@Injectable()
class QuizzesService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly authService: AuthService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly achievementsService: AchievementsService,
    private readonly challengesService: WeeklyChallengesService,
  ) {}

  // ── GET /quizzes — list with is_attempted flag ──────────────
  async findAll(query: PaginationDto & any, userId: string) {
    const { page = 1, limit = 20, type, subject, exam } = query;
    const offset = (page - 1) * limit;
    const conditions = [`q.status = 'published'`];
    const params: any[] = [];

    if (type)    { conditions.push(`q.type=$${params.length + 1}`);            params.push(type); }
    if (subject) { conditions.push(`q.subject=$${params.length + 1}`);         params.push(subject); }
    if (exam)    { conditions.push(`$${params.length + 1}=ANY(q.exam_tags)`);  params.push(exam); }

    const where = conditions.join(' AND ');

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT
           q.id, q.title, q.description, q.subject, q.type, q.difficulty,
           q.total_questions, q.duration_mins, q.passing_score, q.coins_reward,
           q.exam_tags, q.scheduled_for, q.attempt_count, q.avg_score, q.status,
           -- is_attempted: true/false boolean (not a JSON object)
           (SELECT TRUE FROM quiz_attempts qa WHERE qa.user_id=$${params.length + 1} AND qa.quiz_id=q.id LIMIT 1) AS is_attempted,
           (SELECT qa.score FROM quiz_attempts qa WHERE qa.user_id=$${params.length + 1} AND qa.quiz_id=q.id ORDER BY qa.attempted_at DESC LIMIT 1) AS my_last_score
         FROM quizzes q
         WHERE ${where}
         ORDER BY q.created_at DESC
         LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
        [...params, userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM quizzes q WHERE ${where}`, params),
    ]);

    return successResponse(
      { quizzes: rows },
      'Success',
      paginationMeta(parseInt(countResult[0].count), page, limit)
    );
  }

  // ── GET /quizzes/:id — metadata ONLY, no questions ──────────
  // Questions are anti-cheat — only returned on POST /start
  async findOne(quizId: string, userId: string) {
    const cacheKey = `quiz_meta:${quizId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) {
      // Inject user-specific is_attempted dynamically (can't cache per-user)
      const data: any = cached;
      const attempted = await this.db.query(
        `SELECT score FROM quiz_attempts WHERE quiz_id=$1 AND user_id=$2 ORDER BY attempted_at DESC LIMIT 1`,
        [quizId, userId]
      );
      data.data.quiz.is_attempted  = attempted.length > 0;
      data.data.quiz.my_last_score = attempted[0]?.score ?? null;
      return data;
    }

    const quiz = await this.db.query(
      `SELECT id, title, description, subject, type, difficulty,
              total_questions, duration_mins, passing_score, coins_reward,
              exam_tags, scheduled_for, attempt_count, avg_score, status
       FROM quizzes WHERE id=$1 AND status='published'`,
      [quizId]
    );
    if (!quiz.length) throw new NotFoundException('Quiz not found');

    const attempted = await this.db.query(
      `SELECT score FROM quiz_attempts WHERE quiz_id=$1 AND user_id=$2 ORDER BY attempted_at DESC LIMIT 1`,
      [quizId, userId]
    );

    const quizData = {
      ...quiz[0],
      is_attempted:  attempted.length > 0,
      my_last_score: attempted[0]?.score ?? null,
    };

    const result = successResponse({ quiz: quizData });
    await this.cache.set(cacheKey, result, 120);
    return result;
  }

  // ── POST /quizzes/:id/start — creates attempt, returns questions ──
  async startQuiz(quizId: string, userId: string) {
    const quiz = await this.db.query(
      `SELECT * FROM quizzes WHERE id=$1 AND status='published'`,
      [quizId]
    );
    if (!quiz.length) throw new NotFoundException('Quiz not found or not published');

    const q = quiz[0];

    // Validate scheduled_for (quiz should be available now)
    if (q.scheduled_for && new Date(q.scheduled_for) > new Date()) {
      throw new BadRequestException('This quiz is not yet available');
    }

    // Fetch questions — THIS is the only place questions are returned
    const questions = await this.db.query(
      `SELECT id, question_text, option_a, option_b, option_c, option_d,
              subject, difficulty, sort_order
       FROM quiz_questions
       WHERE quiz_id=$1
       ORDER BY sort_order ASC`,
      [quizId]
    );

    if (!questions.length) {
      throw new BadRequestException('This quiz has no questions yet. Please contact admin.');
    }

    // Create an attempt record (startedAt only — submittedAt set on submit)
    await this.db.query(
      `INSERT INTO quiz_attempts (user_id, quiz_id, attempted_at)
       VALUES ($1, $2, NOW())
       `,  // FIX: removed ON CONFLICT — no unique constraint on quiz_attempts(user_id,quiz_id)
      [userId, quizId]
    );

    return successResponse({ quiz: q, questions });
  }

  // ── POST /quizzes/:id/submit ─────────────────────────────────
  async submit(quizId: string, userId: string, dto: any) {
    const quiz = await this.db.query(`SELECT * FROM quizzes WHERE id=$1`, [quizId]);
    if (!quiz.length) throw new NotFoundException('Quiz not found');
    const q = quiz[0];

    // Fetch correct answers + explanations
    const questions = await this.db.query(
      `SELECT id, correct_option, explanation, question_text,
              option_a, option_b, option_c, option_d
       FROM quiz_questions WHERE quiz_id=$1`,
      [quizId]
    );
    const qMap = Object.fromEntries(
      questions.map((qq: any) => [qq.id, {
        correct:     qq.correct_option,
        explanation: qq.explanation || '',
      }])
    );

    let correct = 0;
    const evaluated = dto.answers.map((a: any) => {
      const info      = qMap[a.questionId];
      const isCorrect = info?.correct === a.answer;
      if (isCorrect) correct++;
      return {
        questionId:    a.questionId,
        answer:        a.answer,
        isCorrect,
        correctAnswer: info?.correct     ?? '',
        explanation:   info?.explanation ?? '',
      };
    });

    const total    = questions.length;
    const score    = total > 0 ? Math.round((correct / total) * 100) : 0;
    const accuracy = score;
    const isPassed = score >= q.passing_score;

    const attempt = await this.db.query(
      `INSERT INTO quiz_attempts
         (user_id, quiz_id, score, total_questions, correct_answers, time_taken_secs, coins_earned, answers, is_passed, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       RETURNING id, attempted_at`,
      [userId, quizId, score, total, correct, dto.timeTakenSecs || 0, isPassed ? q.coins_reward : 0, JSON.stringify(evaluated), isPassed]
    );

    // Update quiz stats
    await this.db.query(
      `UPDATE quizzes SET
         attempt_count = attempt_count + 1,
         avg_score     = ROUND(((avg_score * (attempt_count)) + $1) / (attempt_count + 1), 1),
         updated_at    = NOW()
       WHERE id = $2`,
      [score, quizId]
    );

    // Update user stats
    await this.db.query(
      `UPDATE users SET
         quizzes_attempted    = quizzes_attempted + 1,
         accuracy             = ROUND(((accuracy * quizzes_attempted) + $1) / (quizzes_attempted + 1), 1),
         total_study_minutes  = total_study_minutes + $2,
         last_active_at       = NOW()
       WHERE id = $3`,
      [score, Math.ceil(q.duration_mins * 0.7), userId]
    );

    // Invalidate quiz cache
    await this.cache.del(`quiz_meta:${quizId}`);

    let coinsEarned = 0;
    if (isPassed) coinsEarned = await this.authService.awardCoins(userId, 'daily_quiz', attempt[0].id);

    // ── Async achievement + challenge checks (fire-and-forget) ──
    Promise.all([
      this.achievementsService.checkAndAward(userId, 'quiz_complete')
        .catch(e => console.error('quiz achievement:', e.message)),
      this.challengesService.updateProgress(userId, 'quiz_complete', 1)
        .catch(e => console.error('quiz challenge:', e.message)),
    ]);

    return successResponse({
      attemptId:    attempt[0].id,
      score,
      correct,
      total,
      wrong:        total - correct,
      accuracy,
      isPassed,
      coinsEarned,
      timeTakenSecs: dto.timeTakenSecs || 0,
      answers:      evaluated,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // ADMIN SERVICE METHODS
  // ═══════════════════════════════════════════════════════════

  async findAllAdmin(query: any) {
    const { page = 1, limit = 20, status, type } = query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (status) { conditions.push(`status=$${params.length + 1}`); params.push(status); }
    if (type)   { conditions.push(`type=$${params.length + 1}`);   params.push(type); }
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT q.*,
           (SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=q.id) AS question_count
         FROM quizzes q
         WHERE ${conditions.join(' AND ')}
         ORDER BY q.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM quizzes WHERE ${conditions.join(' AND ')}`, params),
    ]);
    return successResponse({ quizzes: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async create(data: any, adminId: string) {
    if (!data.title || !data.subject) throw new BadRequestException('Title and subject required');
    const result = await this.db.query(
      `INSERT INTO quizzes
         (title, description, subject, type, difficulty, total_questions,
          duration_mins, passing_score, coins_reward, exam_tags, scheduled_for, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        data.title, data.description || null, data.subject,
        data.type || 'daily', data.difficulty || 'medium',
        0,  // total_questions set after questions are added
        data.durationMins || 15, data.passingScore || 60,
        data.coinsReward || 10, data.examTags || [],
        data.scheduledFor || null,
        data.status || 'draft',
        adminId,
      ]
    );
    return successResponse({ quiz: result[0] }, 'Quiz created. Add questions next.');
  }

  async update(quizId: string, data: any) {
    const fields: string[] = [];
    const vals: any[]      = [];
    let i = 1;
    const map: any = {
      title: 'title', description: 'description', subject: 'subject',
      type: 'type', difficulty: 'difficulty', durationMins: 'duration_mins',
      passingScore: 'passing_score', coinsReward: 'coins_reward',
      status: 'status', scheduledFor: 'scheduled_for', examTags: 'exam_tags',
    };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push('updated_at=NOW()');
    await this.db.query(`UPDATE quizzes SET ${fields.join(',')} WHERE id=$${i}`, [...vals, quizId]);
    await this.cache.del(`quiz_meta:${quizId}`);
    return successResponse(null, 'Quiz updated ✅');
  }

  // ── GET /admin/quizzes/:id/questions ─────────────────────────
  async getQuestions(quizId: string) {
    const quiz = await this.db.query(`SELECT id, title FROM quizzes WHERE id=$1`, [quizId]);
    if (!quiz.length) throw new NotFoundException('Quiz not found');

    const questions = await this.db.query(
      `SELECT id, question_text, option_a, option_b, option_c, option_d,
              correct_option, explanation, subject, difficulty, sort_order
       FROM quiz_questions WHERE quiz_id=$1 ORDER BY sort_order ASC`,
      [quizId]
    );
    return successResponse({
      quiz:      quiz[0],
      questions,
      total:     questions.length,
    });
  }

  // ── POST /admin/quizzes/:id/questions — bulk add ──────────────
  async addQuestions(quizId: string, questions: any[]) {
    const quiz = await this.db.query(`SELECT id FROM quizzes WHERE id=$1`, [quizId]);
    if (!quiz.length) throw new NotFoundException('Quiz not found');

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new BadRequestException('Provide at least one question');
    }

    // Validate each question
    for (const q of questions) {
      if (!q.question && !q.questionText) throw new BadRequestException('Each question needs a question_text');
      if (!q.optionA || !q.optionB || !q.optionC || !q.optionD) throw new BadRequestException('Each question needs 4 options (optionA-D)');
      if (!['a','b','c','d'].includes(q.correctOption?.toLowerCase())) throw new BadRequestException(`correctOption must be a, b, c or d. Got: ${q.correctOption}`);
    }

    // Get current max sort_order
    const maxOrder = await this.db.query(`SELECT COALESCE(MAX(sort_order), -1) AS max FROM quiz_questions WHERE quiz_id=$1`, [quizId]);
    let sortOrder  = parseInt(maxOrder[0].max) + 1;

    const inserted: any[] = [];
    for (const q of questions) {
      const result = await this.db.query(
        `INSERT INTO quiz_questions
           (quiz_id, question_text, option_a, option_b, option_c, option_d,
            correct_option, explanation, subject, difficulty, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, question_text, sort_order`,
        [
          quizId,
          (q.question || q.questionText).trim(),
          q.optionA.trim(), q.optionB.trim(), q.optionC.trim(), q.optionD.trim(),
          q.correctOption.toLowerCase(),
          q.explanation?.trim() || null,
          q.subject?.trim() || null,
          q.difficulty || 'medium',
          sortOrder++,
        ]
      );
      inserted.push(result[0]);
    }

    // Sync total_questions count
    await this.db.query(
      `UPDATE quizzes SET total_questions=(SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=$1), updated_at=NOW() WHERE id=$1`,
      [quizId]
    );
    await this.cache.del(`quiz_meta:${quizId}`);

    return successResponse({ inserted, count: inserted.length }, `${inserted.length} question(s) added ✅`);
  }

  // ── PUT /admin/questions/:id — update single question ─────────
  async updateQuestion(questionId: string, data: any) {
    const existing = await this.db.query(`SELECT id, quiz_id FROM quiz_questions WHERE id=$1`, [questionId]);
    if (!existing.length) throw new NotFoundException('Question not found');

    const fields: string[] = [];
    const vals: any[]      = [];
    let i = 1;
    const map: any = {
      questionText: 'question_text',
      optionA:      'option_a',
      optionB:      'option_b',
      optionC:      'option_c',
      optionD:      'option_d',
      correctOption: 'correct_option',
      explanation:  'explanation',
      subject:      'subject',
      difficulty:   'difficulty',
      sortOrder:    'sort_order',
    };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) {
        // Validate correctOption
        if (key === 'correctOption' && !['a','b','c','d'].includes(data[key]?.toLowerCase())) {
          throw new BadRequestException('correctOption must be a, b, c or d');
        }
        fields.push(`${col}=$${i++}`);
        vals.push(key === 'correctOption' ? data[key].toLowerCase() : data[key]);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    await this.db.query(`UPDATE quiz_questions SET ${fields.join(',')} WHERE id=$${i}`, [...vals, questionId]);
    await this.cache.del(`quiz_meta:${existing[0].quiz_id}`);
    return successResponse(null, 'Question updated ✅');
  }

  // ── DELETE /admin/questions/:id ───────────────────────────────
  async deleteQuestion(questionId: string) {
    const existing = await this.db.query(`SELECT id, quiz_id FROM quiz_questions WHERE id=$1`, [questionId]);
    if (!existing.length) throw new NotFoundException('Question not found');

    await this.db.query(`DELETE FROM quiz_questions WHERE id=$1`, [questionId]);

    // Update question count
    const quizId = existing[0].quiz_id;
    await this.db.query(
      `UPDATE quizzes SET total_questions=(SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=$1), updated_at=NOW() WHERE id=$1`,
      [quizId]
    );
    await this.cache.del(`quiz_meta:${quizId}`);

    return successResponse(null, 'Question deleted ✅');
  }

  async deleteQuiz(quizId: string) {
    await this.db.query(`DELETE FROM quiz_questions WHERE quiz_id=$1`, [quizId]);
    await this.db.query(`DELETE FROM quizzes WHERE id=$1`, [quizId]);
    await this.cache.del(`quiz_meta:${quizId}`);
    return successResponse(null, 'Quiz deleted ✅');
  }
}

// ═════════════════════════════════════════════════════════════
// USER CONTROLLER
// ═════════════════════════════════════════════════════════════

@ApiTags('Quizzes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quizzes')
class QuizzesController {
  constructor(private s: QuizzesService) {}

  /** GET /quizzes?type=daily&subject=Polity */
  @Get()
  findAll(@Query() q: any, @Req() r: any) {
    return this.s.findAll(q, r.user.id);
  }

  /** GET /quizzes/:id — quiz info only, NO questions */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.findOne(id, r.user.id);
  }

  /**
   * POST /quizzes/:id/start
   * Creates attempt session, returns questions.
   * Called when user taps "Start Quiz" on the detail screen.
   */
  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  startQuiz(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.startQuiz(id, r.user.id);
  }

  /** POST /quizzes/:id/submit */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id', ParseUUIDPipe) id: string, @Req() r: any, @Body() dto: any) {
    return this.s.submit(id, r.user.id, dto);
  }
}

// ═════════════════════════════════════════════════════════════
// ADMIN CONTROLLER
// ═════════════════════════════════════════════════════════════

@ApiTags('Admin — Quizzes')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/quizzes')
class AdminQuizzesController {
  constructor(private s: QuizzesService) {}

  /** GET /admin/quizzes */
  @Get()
  @RequirePermission('quizzes')
  findAll(@Query() q: any) { return this.s.findAllAdmin(q); }

  /** POST /admin/quizzes — create quiz shell (no questions yet) */
  @Post()
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: any, @Req() r: any) { return this.s.create(dto, r.admin.id); }

  /** PUT /admin/quizzes/:id — update quiz metadata or publish */
  @Put(':id')
  @RequirePermission('quizzes')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.s.update(id, dto);
  }

  /** DELETE /admin/quizzes/:id */
  @Delete(':id')
  @RequirePermission('quizzes')
  deleteQuiz(@Param('id', ParseUUIDPipe) id: string) { return this.s.deleteQuiz(id); }

  /**
   * GET /admin/quizzes/:id/questions
   * Lists all questions for this quiz — used in admin panel question manager.
   */
  @Get(':id/questions')
  @RequirePermission('quizzes')
  getQuestions(@Param('id', ParseUUIDPipe) id: string) { return this.s.getQuestions(id); }

  /**
   * POST /admin/quizzes/:id/questions
   * Bulk add questions. Body: { questions: [{question, optionA-D, correctOption, explanation}] }
   */
  @Post(':id/questions')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.CREATED)
  addQuestions(@Param('id', ParseUUIDPipe) id: string, @Body() body: any) {
    return this.s.addQuestions(id, body.questions || [body]);
  }
}

/** Separate controller for individual question management */
@ApiTags('Admin — Questions')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/questions')
class AdminQuestionsController {
  constructor(private s: QuizzesService) {}

  /** PUT /admin/questions/:id — edit a question */
  @Put(':id')
  @RequirePermission('quizzes')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.s.updateQuestion(id, dto);
  }

  /** DELETE /admin/questions/:id — remove a question */
  @Delete(':id')
  @RequirePermission('quizzes')
  delete(@Param('id', ParseUUIDPipe) id: string) { return this.s.deleteQuestion(id); }
}

import { AuthModule } from '../auth/auth.module';

@Module({
  imports:     [AuthModule],
  controllers: [QuizzesController, AdminQuizzesController, AdminQuestionsController],
  providers:   [QuizzesService, AchievementsService, WeeklyChallengesService],
  exports:     [QuizzesService],
})
export class QuizzesModule {}
