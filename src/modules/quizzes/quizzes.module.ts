// ── quizzes.module.ts — Complete production version ──────────────────────────
import {
  Module, Injectable, Controller, Get, Post, Put, Delete, Body,
  Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, ForbiddenException,
  UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { AchievementsService, WeeklyChallengesService, AchievementsModule } from '../achievements/achievements.module';
import { NotificationsModule, NotificationService } from '../combined-modules-1.module';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { ActivityLogService, ACTIONS } from '../../common/activity/activity-log.service';
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
    private readonly notifService: NotificationService,
  ) {}

  // ── GET /quizzes — list with is_attempted flag ──────────────
  async findAll(query: PaginationDto & any, userId: string) {
    const { page = 1, limit = 20, type, subject, exam } = query;
    const offset = (page - 1) * limit;
    const conditions = [`q.status = 'published'`];
    const params: any[] = [];

    if (type)    { conditions.push(`q.type=$${params.length + 1}`);            params.push(type); }
    if (subject) { conditions.push(`q.subject=$${params.length + 1}`);         params.push(subject); }
    if (exam)    {
      // A quiz with an empty/null exam_tags array is a "general" quiz
      // meant for everyone. Filtering with `$X = ANY(exam_tags)` alone
      // evaluates to FALSE for an empty array in Postgres, which would
      // silently hide every untagged quiz (e.g. the daily Sunday Quiz)
      // as soon as a user has an exam selected. Match either: tagged
      // for this exam, OR untagged (general).
      conditions.push(`($${params.length + 1}=ANY(q.exam_tags) OR q.exam_tags IS NULL OR q.exam_tags = '{}')`);
      params.push(exam);
    }

    const where = conditions.join(' AND ');

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT
           q.id, q.title, q.description, q.subject, q.type,
           q.total_questions, q.duration_mins, q.coins_reward,
           q.exam_tags, q.scheduled_for, q.attempt_count, q.avg_score, q.status,
           q.negative_marking_enabled, q.marks_per_correct, q.marks_per_wrong,
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
      `SELECT id, title, description, subject, type,
              total_questions, duration_mins, coins_reward,
              exam_tags, scheduled_for, attempt_count, avg_score, status,
              negative_marking_enabled, marks_per_correct, marks_per_wrong
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
    // if (q.scheduled_for && new Date(q.scheduled_for) > new Date()) {
    //   throw new BadRequestException('This quiz is not yet available');
    // }

    const now = new Date();

if (q.scheduled_for) {
  // Use ISO date-string comparison — completely timezone-safe
  // Compares 'YYYY-MM-DD' strings which are lexicographically ordered
  const today     = new Date().toISOString().split('T')[0];
  const scheduled = new Date(q.scheduled_for).toISOString().split('T')[0];
  if (scheduled > today) {
    throw new BadRequestException('This quiz is not yet available');
  }
}

    // Fetch questions — correct_option and explanation deliberately excluded
    // to prevent cheating. They are only returned in the /submit response.
    const questions = await this.db.query(
      `SELECT id, question_text, option_a, option_b, option_c, option_d,
       question_type, question_image_url, option_type,
       option_a_image, option_b_image, option_c_image, option_d_image,
       subject, sort_order,
              COALESCE(question_type, 'text')   AS question_type,
              COALESCE(option_type, 'text')     AS option_type
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
    // Postgres raw queries return numeric columns as strings — parse to avoid NaN
    const durationMins = parseInt(q.duration_mins, 10) || 15;
    const coinsReward  = parseInt(q.coins_reward,  10) || 0;
    // Negative marking config (admin-set per quiz, see NegativeMarkingConfig migration)
    const negEnabled       = q.negative_marking_enabled === true;
    const marksPerCorrect  = parseFloat(q.marks_per_correct) || 1;
    const marksPerWrong    = negEnabled ? (parseFloat(q.marks_per_wrong) || 0) : 0;
    // Prevents direct API submit without loading questions first
    const startedAttempt = await this.db.query(
      `SELECT id, attempted_at FROM quiz_attempts
       WHERE user_id=$1 AND quiz_id=$2
       ORDER BY attempted_at DESC LIMIT 1`,
      [userId, quizId]
    );
    if (!startedAttempt.length) {
      throw new BadRequestException('You must start the quiz before submitting answers.');
    }

    // Validate answers array
    if (!Array.isArray(dto.answers)) {
      throw new BadRequestException('answers must be an array.');
    }

    // Fetch correct answers + explanations
    const questions = await this.db.query(
      `SELECT id, correct_option, explanation, question_text,
              option_a, option_b, option_c, option_d,
              COALESCE(question_type, 'text')   AS question_type,
              question_image_url,
              COALESCE(option_type, 'text')     AS option_type,
              option_a_image, option_b_image, option_c_image, option_d_image
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
    // ANTI-CHEAT: Only evaluate answers for questionIds that belong to THIS quiz
    // Filters out any injected fake questionIds from the payload
    const validAnswers = dto.answers.filter((a: any) => qMap[a.questionId]);
    const evaluated = validAnswers.map((a: any) => {
      const info      = qMap[a.questionId];
      const isCorrect = info?.correct === a.answer;
      if (isCorrect) correct++;
      return {
        questionId:    a.questionId,
        answer:        a.answer,
        isCorrect,
        correctAnswer: info?.correct     ?? '',
        explanation:   info?.explanation ?? '',
        // +marksPerCorrect if right, -marksPerWrong if wrong (0 if negative
        // marking is off for this quiz)
        marks: isCorrect ? marksPerCorrect : -marksPerWrong,
      };
    });

    // Include skipped questions in the result so Android can show correct answers for ALL
    // questions in the review screen, not just submitted ones
    const submittedIds = new Set(validAnswers.map((a: any) => a.questionId));
    const skippedResults = questions
      .filter((q: any) => !submittedIds.has(q.id))
      .map((q: any) => ({
        questionId:    q.id,
        answer:        '',       // empty = skipped
        isCorrect:     false,
        correctAnswer: qMap[q.id]?.correct ?? '',
        explanation:   qMap[q.id]?.explanation ?? '',
        // Skipped questions never lose marks, even with negative marking on
        marks: 0,
      }));
    const allAnswers = [...evaluated, ...skippedResults];
    const total    = questions.length;


    // wrongCount excludes skipped questions on purpose — standard
    // competitive-exam convention is skip = 0 marks, wrong attempt = lose
    // marks. Using total-correct here would incorrectly penalize skips too.
    const wrongCount      = evaluated.filter((e: any) => !e.isCorrect).length;
    const unansweredCount = skippedResults.length;
    const totalMarks      = total * marksPerCorrect;
    const marksObtained   = correct * marksPerCorrect;
    const negativeMarks   = negEnabled ? wrongCount * marksPerWrong : 0;
    const finalScore      = marksObtained - negativeMarks;

    // ANTI-CHEAT: Calculate time server-side — don't trust client timeTakenSecs
    // Use attempted_at from the start record vs NOW()
    const serverTimeSecs = Math.round(
      (Date.now() - new Date(startedAttempt[0].attempted_at).getTime()) / 1000
    );
    // Cap at quiz duration * 60 + 30s grace period to handle network delays
    const maxSecs = durationMins * 60 + 30;
    const timeTakenSecs = Math.min(serverTimeSecs, maxSecs);

    const score    = total > 0 ? Math.round((correct / total) * 100) : 0;
    const accuracy = score;

    // Anti-farming: coins are only awarded on the user's FIRST completed
    // attempt for this quiz. "Completed" = total_questions > 0, which only
    // ever gets set on a submit insert — distinguishes it from the bare
    // start-stub row inserted by startQuiz() above.
    const priorCompleted = await this.db.query(
      `SELECT id FROM quiz_attempts WHERE user_id=$1 AND quiz_id=$2 AND total_questions > 0 LIMIT 1`,
      [userId, quizId]
    );
    const isFirstAttempt = priorCompleted.length === 0;

    const attempt = await this.db.query(
      `INSERT INTO quiz_attempts
         (user_id, quiz_id, score, total_questions, correct_answers, time_taken_secs, coins_earned, answers, submitted_at,
          wrong_answers, unanswered_questions, marks_obtained, negative_marks, final_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12,$13)
       RETURNING id, attempted_at`,
      [
        userId, quizId, score, total, correct, timeTakenSecs, isFirstAttempt ? coinsReward : 0, JSON.stringify(allAnswers),
        wrongCount, unansweredCount, marksObtained, negativeMarks, finalScore,
      ]
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
    // quizzes_attempted counts unique quizzes completed, not total attempts
    // accuracy updates on every attempt so it reflects real performance
    await this.db.query(
      `UPDATE users SET
         quizzes_attempted    = quizzes_attempted + ${isFirstAttempt ? 1 : 0},
         accuracy             = ROUND(((accuracy * quizzes_attempted) + $1) / (quizzes_attempted + 1), 1),
         total_study_minutes  = total_study_minutes + $2,
         last_active_at       = NOW()
       WHERE id = $3`,
      [score, Math.ceil(durationMins * 0.7), userId]
    );

    // Invalidate quiz cache
    await this.cache.del(`quiz_meta:${quizId}`);

    // FIX: quizzes_attempted/accuracy/total_study_minutes just changed
    // above, but the Group Study "My Tier" stats (StatPills + Progress
    // to next tier) are cached under user_tier:<userId> with no
    // invalidation hook here — so they kept showing stale (often 0)
    // values until that cache happened to expire on its own.
    await this.cache.del(`user_tier:${userId}`);

    // ANTI-CHEAT: Only award coins on the FIRST completed attempt for this quiz
    let coinsEarned = 0;
    if (isFirstAttempt) {
        const quizType = q.type || 'daily';
        const coinAction = quizType === 'mock'  ? 'mock_quiz'
                         : quizType === 'topic' ? 'topic_quiz'
                         : 'daily_quiz';
        const quizCoinsReward = coinsReward;
        coinsEarned = await this.authService.awardCoins(
          userId, coinAction, attempt[0].id, quizCoinsReward
        );
    }

    // ── Async achievement + challenge checks (fire-and-forget) ──
    Promise.all([
      this.achievementsService.checkAndAward(userId, 'quiz_complete')
        .catch(e => console.error('quiz achievement:', e.message)),
      this.challengesService.updateProgress(userId, 'quiz_complete', 1)
        .catch(e => console.error('quiz challenge:', e.message)),
    ]);

    // ── Rank + Percentile Calculation ──────────────────────────

// Total attempts for this quiz
const totalAttemptsResult = await this.db.query(
  `SELECT COUNT(*)::int AS count
   FROM quiz_attempts
   WHERE quiz_id=$1`,
  [quizId]
);

const totalAttempts = totalAttemptsResult[0]?.count || 1;

// Number of users who scored higher
const higherScoresResult = await this.db.query(
  `SELECT COUNT(*)::int AS count
   FROM quiz_attempts
   WHERE quiz_id=$1
   AND score > $2`,
  [quizId, score]
);

const higherScores = higherScoresResult[0]?.count || 0;

// Rank
const rank = higherScores + 1;

// Percentile
const percentile = Number(
  (((totalAttempts - rank) / totalAttempts) * 100).toFixed(2)
);
// 🔔 First-time completion notification
    if (isFirstAttempt && coinsEarned > 0) {
      this.notifService.pushToUser(
        userId,
        '🎉 Quiz Completed!',
        `You scored ${score}% on "${q.title}" · 🪙 +${coinsEarned} coins!`,
        { type: 'quiz_result', quizId, screen: 'quiz_list' }
      ).catch(() => {});
    }

    // ── Referral milestone 3 — active: friend completed 5th quiz ──
    try {
      const attemptCount = await this.db.query(
        `SELECT COUNT(*) FROM quiz_attempts WHERE user_id=$1`, [userId]
      );
      if (parseInt(attemptCount[0].count) === 5) {
        this.authService?.awardReferralMilestone?.(userId, 'active').catch(() => {});
      }
    } catch (_) {}

    // ── Invalidate leaderboard cache so rank reflects new score ──
    // Users check the leaderboard after a quiz; stale cache made it
    // appear their rank hadn't changed even after a high-scoring attempt.
    await this.cache.del('leaderboard:global:0:coins').catch(() => {});
    await this.cache.del(`leaderboard:user:${userId}`).catch(() => {});

return successResponse({
  attemptId: attempt[0].id,
  score,
  correct,
  total,
  wrong: wrongCount,
  unanswered: unansweredCount,
  accuracy,
  coinsEarned,
  timeTakenSecs,

  rank,
  percentile,

  // ── Negative marking breakdown ──────────────────────────
  negativeMarkingEnabled: negEnabled,
  marksPerCorrect,
  marksPerWrong,
  totalMarks,
  marksObtained,
  negativeMarks,
  finalScore,

  answers: allAnswers,
});
  }

  // ═══════════════════════════════════════════════════════════
  // ADMIN SERVICE METHODS
  // ═══════════════════════════════════════════════════════════

  async findAllAdmin(query: any) {
    const { page = 1, limit = 20, status, type, search } = query;
    const offset = (page - 1) * limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (status) { conditions.push(`status=$${params.length + 1}`); params.push(status); }
    if (type)   { conditions.push(`type=$${params.length + 1}`);   params.push(type); }
    if (search) { conditions.push(`title ILIKE $${params.length + 1}`); params.push(`%${search}%`); }
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
         (title, description, subject, type, total_questions,
          duration_mins, coins_reward, exam_tags, scheduled_for, status, created_by,
          negative_marking_enabled, marks_per_correct, marks_per_wrong)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        data.title, data.description || null, data.subject,
        data.type || 'daily',
        0,  // total_questions set after questions are added
        data.durationMins || 15,
        data.coinsReward || 10, data.examTags || [],
        data.scheduledFor || null,
        data.status || 'draft',
        adminId,
        data.negativeMarkingEnabled === true,
        data.marksPerCorrect != null ? +data.marksPerCorrect : 1,
        data.marksPerWrong   != null ? +data.marksPerWrong   : 0,
      ]
    );
    return successResponse({ quiz: result[0] }, 'Quiz created. Add questions next.');
  }

  async bulkImport(data: any, adminId: string) {
    const { quiz: quizMeta, questions } = data;
    if (!quizMeta?.title)   throw new BadRequestException('quiz.title is required');
    if (!quizMeta?.subject) throw new BadRequestException('quiz.subject is required');
    if (!Array.isArray(questions) || questions.length === 0)
      throw new BadRequestException('Provide at least one question');
    if (questions.length > 500)
      throw new BadRequestException('Maximum 500 questions per bulk import');

    // mode: 'merge' (default, append to existing) | 'replace' (delete existing questions
    // first, then insert) | 'create' (always make a brand-new quiz even if title matches)
    const mode = quizMeta.importMode === 'replace' || quizMeta.importMode === 'create'
      ? quizMeta.importMode : 'merge';

    const LETTERS = ['a','b','c','d'];
    const normalised = questions.map((q: any, idx: number) => {
      const qText = (q.question || q.question_text || q.questionText || '').trim();
      if (!qText) throw new BadRequestException(`Row ${idx + 2}: question text is empty`);
      const opts: string[] = [];
      ['option_a','option_b','option_c','option_d','option_e'].forEach(k => {
        const v = (q[k] || '').toString().trim();
        if (v) opts.push(v);
      });
      if (opts.length < 2) throw new BadRequestException(`Row ${idx + 2}: need at least 2 options`);
      if (opts.length > 4) opts.length = 4;
      while (opts.length < 4) opts.push('');
      let co = String(q.correct_option || q.correctOption || q.answer || 'a').trim().toLowerCase();
      if (/^[1-4]$/.test(co)) co = LETTERS[parseInt(co) - 1];
      else if (/^[0-3]$/.test(co)) co = LETTERS[parseInt(co)];
      if (!LETTERS.includes(co)) throw new BadRequestException(`Row ${idx + 2}: correct_option must be a-d`);
      return {
        questionText: qText,
        optionA: opts[0], optionB: opts[1], optionC: opts[2], optionD: opts[3],
        correctOption: co,
        explanation: (q.explanation || '').toString().trim() || null,
        subject: (q.subject || quizMeta.subject || '').toString().trim() || null,
      };
    });

    await this.db.query('BEGIN');
    try {
      // Upsert: find existing quiz by title+subject+type, or create new one
      let quiz: any;
      let action: 'created' | 'appended' | 'replaced' = 'created';
      const existing = mode === 'create' ? [] : await this.db.query(
        `SELECT id, title, total_questions FROM quizzes WHERE title=$1 AND subject=$2 AND type=$3 AND status IN ('draft','review','published') ORDER BY created_at DESC LIMIT 1`,
        [quizMeta.title.trim(), quizMeta.subject.trim(), quizMeta.type || 'topic']
      );
      if (existing.length && mode === 'replace') {
        // Replace: wipe existing questions, keep the quiz row, re-insert fresh
        quiz = existing[0];
        await this.db.query(`DELETE FROM quiz_questions WHERE quiz_id=$1`, [quiz.id]);
        action = 'replaced';
      } else if (existing.length) {
        // Merge (default): append to existing quiz — don't overwrite
        quiz = existing[0];
        action = 'appended';
      } else {
        // Create new quiz
        const [created] = await this.db.query(
          `INSERT INTO quizzes (title, description, subject, type, total_questions, duration_mins, coins_reward, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [quizMeta.title.trim(), quizMeta.description?.trim() || null, quizMeta.subject.trim(),
           quizMeta.type || 'topic', normalised.length, quizMeta.durationMins || 15,
           quizMeta.coinsReward || 10,
           quizMeta.status || 'published', adminId]
        );
        quiz = created;
        action = 'created';
      }

      // Get current max sort_order for this quiz to avoid collisions
      const [maxRow] = await this.db.query(
        `SELECT COALESCE(MAX(sort_order), -1) AS max FROM quiz_questions WHERE quiz_id=$1`, [quiz.id]
      );
      let sortBase = (maxRow?.max ?? -1) + 1;
      for (let i = 0; i < normalised.length; i++) {
        const q = normalised[i];
        await this.db.query(
          `INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, subject, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [quiz.id, q.questionText, q.optionA, q.optionB, q.optionC, q.optionD, q.correctOption, q.explanation, q.subject, sortBase + i]
        );
      }
      // Update total_questions count
      await this.db.query(
        `UPDATE quizzes SET total_questions=(SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=$1), updated_at=NOW() WHERE id=$1`,
        [quiz.id]
      );
      await this.db.query('COMMIT');
      const verb = action === 'created' ? 'Imported' : action === 'replaced' ? 'Replaced questions in' : 'Appended';
      return successResponse({ quizId: quiz.id, title: quiz.title, questionsInserted: normalised.length, action },
        `✅ ${verb} ${normalised.length} questions ${action === 'replaced' ? 'into' : action === 'appended' ? 'into existing' : 'into'} "${quiz.title}"`);
    } catch (e) {
      await this.db.query('ROLLBACK');
      throw e;
    }
  }

  // ── Check for existing quizzes by title — used by the bulk import
  // preview to warn the admin BEFORE import instead of silently merging.
  async checkExistingTitles(titles: string[]) {
    if (!titles.length) return successResponse({ existing: [] });
    const rows = await this.db.query(
      `SELECT title, subject, type, total_questions, id FROM quizzes
       WHERE title = ANY($1) AND status IN ('draft','review','published')`,
      [titles]
    );
    return successResponse({ existing: rows });
  }

  async bulkImportMulti(groups: any[], adminId: string) {
    if (!Array.isArray(groups) || groups.length === 0)
      throw new BadRequestException('Provide at least one quiz group');
    if (groups.length > 50)
      throw new BadRequestException('Maximum 50 quizzes per bulk import');
    const results = [];
    for (const group of groups) {
      const res = await this.bulkImport({ quiz: group.quiz, questions: group.questions }, adminId);
      results.push(res.data);
    }
    return successResponse(
      { quizzes: results, totalQuizzes: results.length, totalQuestions: results.reduce((s: number, r: any) => s + (r.questionsInserted || 0), 0) },
      `✅ Imported ${results.length} quizzes`
    );
  }

  async update(quizId: string, data: any) {
    const fields: string[] = [];
    const vals: any[]      = [];
    let i = 1;
    const map: any = {
      title: 'title', description: 'description', subject: 'subject',
      type: 'type', durationMins: 'duration_mins',
      coinsReward: 'coins_reward',
      status: 'status', scheduledFor: 'scheduled_for', examTags: 'exam_tags',
      negativeMarkingEnabled: 'negative_marking_enabled',
      marksPerCorrect: 'marks_per_correct',
      marksPerWrong: 'marks_per_wrong',
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
       correct_option, explanation,
       question_type, question_image_url, option_type,
       option_a_image, option_b_image, option_c_image, option_d_image,
       subject, sort_order
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

    // Validate each question — supports 2-5 options (admin can choose)
    for (const q of questions) {
      if (!q.question && !q.questionText) throw new BadRequestException('Each question needs a question_text');

      const opType = q.optionType || q.option_type || 'text';

      if (opType === 'text') {
        // Build options array from either:
        //   (a) options[] array sent by new admin UI
        //   (b) legacy optionA/optionB/optionC/optionD keys
        const optsFromArray  = Array.isArray(q.options) ? q.options.filter((o: any) => typeof o === 'string' && o.trim()) : [];
        const optsFromLegacy = [q.optionA, q.optionB, q.optionC, q.optionD, q.optionE].filter((o: any) => typeof o === 'string' && o.trim());
        const effectiveOpts  = optsFromArray.length >= 2 ? optsFromArray : optsFromLegacy;

        if (effectiveOpts.length < 2) {
          throw new BadRequestException('Each question needs at least 2 options');
        }
        if (effectiveOpts.length > 4) {
          throw new BadRequestException('Maximum 4 options allowed per question (DB schema limit)');
        }

        // Normalise: fill optionA-D from the array
        const LABELS = ['A','B','C','D'];
        LABELS.forEach((l, i) => {
          (q as any)[`option${l}`] = effectiveOpts[i]?.trim() || '';  // empty string for missing options
        });
      } else if (opType === 'image') {
        if (!q.optionAImage && !q.option_a_image) throw new BadRequestException('Image options require option images');
      }

      // correctOption: accept letter ('a'-'d') or number index (0-3)
      // DB schema uses CHAR(1) CHECK IN ('a','b','c','d') — max 4 options
      let co = q.correctOption;
      if (typeof co === 'number') {
        co = ['a','b','c','d'][Math.min(co, 3)]; // cap at d
      }
      if (!co || !['a','b','c','d'].includes(String(co).toLowerCase())) {
        throw new BadRequestException(`correctOption must be a-d or 0-3. Got: ${q.correctOption}`);
      }
      q.correctOption = String(co).toLowerCase();
    }

    // Get current max sort_order
    const maxOrder = await this.db.query(`SELECT COALESCE(MAX(sort_order), -1) AS max FROM quiz_questions WHERE quiz_id=$1`, [quizId]);
    let sortOrder  = parseInt(maxOrder[0].max) + 1;

    const inserted: any[] = [];
    for (const q of questions) {
      const questionType = q.questionType || q.question_type || 'text';
      const optionType   = q.optionType   || q.option_type   || 'text';
      const result = await this.db.query(
        `INSERT INTO quiz_questions
           (quiz_id, question_text, option_a, option_b, option_c, option_d,
            correct_option, explanation, subject, sort_order,
            question_type, question_image_url, option_type,
            option_a_image, option_b_image, option_c_image, option_d_image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id, question_text, sort_order, question_type, option_type`,
        [
          quizId,
          (q.question || q.questionText).trim(),
          q.optionA?.trim() || '',   // NOT NULL in schema
          q.optionB?.trim() || '',   // NOT NULL in schema
          q.optionC?.trim() || '',   // empty string = no option C (client hides if empty)
          q.optionD?.trim() || '',   // empty string = no option D
          q.correctOption.toLowerCase(),
          q.explanation?.trim() || null,
          q.subject?.trim() || null,
          sortOrder++,
          questionType,
          q.questionImageUrl || q.question_image_url || null,
          optionType,
          q.optionAImage || q.option_a_image || null,
          q.optionBImage || q.option_b_image || null,
          q.optionCImage || q.option_c_image || null,
          q.optionDImage || q.option_d_image || null,
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
      questionText:     'question_text',
      questionType:     'question_type',
      questionImageUrl: 'question_image_url',
      optionType:       'option_type',
      optionA:          'option_a',
      optionAImage:     'option_a_image',
      optionBImage:     'option_b_image',
      optionCImage:     'option_c_image',
      optionDImage:     'option_d_image',
      optionB:      'option_b',
      optionC:      'option_c',
      optionD:      'option_d',
      correctOption: 'correct_option',
      explanation:  'explanation',
      subject:      'subject',
      // difficulty removed — not required by client
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

  async getLeaderboard(quizId: string, currentUserId: string) {
    const rows = await this.db.query(
      `WITH best_attempts AS (
         SELECT DISTINCT ON (qa.user_id)
           qa.user_id,
           qa.score,
           qa.correct_answers,
           qa.total_questions,
           qa.time_taken_secs
         FROM quiz_attempts qa
         WHERE qa.quiz_id     = $1
           AND qa.total_questions > 0
           AND qa.score        > 0
         ORDER BY qa.user_id, qa.score DESC, qa.time_taken_secs ASC
       )
       SELECT
         RANK() OVER (ORDER BY ba.score DESC, ba.time_taken_secs ASC) AS rank_position,
         u.id   AS user_id,
         u.name AS user_name,
         ba.score,
         ba.correct_answers,
         ba.total_questions,
         ba.time_taken_secs,
         (u.id = $2) AS is_current_user
       FROM best_attempts ba
       JOIN users u ON u.id = ba.user_id
       ORDER BY ba.score DESC, ba.time_taken_secs ASC
       LIMIT 50`,
      [quizId, currentUserId]
    );
    const leaderboard = rows.map((r: any) => ({
      rank_position:   parseInt(r.rank_position),
      user_id:         r.user_id,
      user_name:       r.user_name,
      score:           parseFloat(r.score),
      correct_answers: parseInt(r.correct_answers),
      total_questions: parseInt(r.total_questions),
      time_taken_secs: parseInt(r.time_taken_secs),
      is_current_user: r.user_id === currentUserId,
    }));
    return successResponse({ leaderboard });
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
  @Throttle({ default: { limit: 5, ttl: 60000 } })  // ANTI-CHEAT: max 5 submits/min
  @HttpCode(HttpStatus.OK)
  submit(@Param('id', ParseUUIDPipe) id: string, @Req() r: any, @Body() dto: any) {
    return this.s.submit(id, r.user.id, dto);
  }

  /** GET /quizzes/:id/leaderboard — top quiz scores */
  @Get(':id/leaderboard')
  leaderboard(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.s.getLeaderboard(id, r.user.id);
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

  /** POST /admin/quizzes/bulk-import-multi — MUST be before :id routes */
  @Post('bulk-import-multi')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.CREATED)
  bulkImportMulti(@Body() dto: any, @Req() r: any) { return this.s.bulkImportMulti(dto.groups || [], r.admin.id); }

  /** POST /admin/quizzes/check-titles — duplicate detection before bulk import.
   *  MUST be before :id routes. Body: { titles: string[] } */
  @Post('check-titles')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.OK)
  checkTitles(@Body() dto: any) { return this.s.checkExistingTitles(dto.titles || []); }

  /** POST /admin/quizzes/bulk-import — MUST be before :id routes */
  @Post('bulk-import')
  @RequirePermission('quizzes')
  @HttpCode(HttpStatus.CREATED)
  bulkImport(@Body() dto: any, @Req() r: any) { return this.s.bulkImport(dto, r.admin.id); }

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
  imports:     [AuthModule, NotificationsModule],
  controllers: [QuizzesController, AdminQuizzesController, AdminQuestionsController],
  providers:   [QuizzesService, AchievementsService, WeeklyChallengesService, NotificationService],
  exports:     [QuizzesService],
})
export class QuizzesModule {}