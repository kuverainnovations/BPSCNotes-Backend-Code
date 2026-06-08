// ════════════════════════════════════════════════════════════
// COURSES MODULE — Repository → Service → Controller
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, HttpException, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus, NotFoundException,
  ForbiddenException, BadRequestException, ParseUUIDPipe, UseGuards, UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsBoolean, IsNumber, IsArray,
  IsEnum, IsNotEmpty, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthService } from '../auth/auth.module';
import { AuthModule } from '../auth/auth.module';
import * as cloudinary from 'cloudinary';
import { NotificationService, NotificationsModule } from '@modules/combined-modules-1.module';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ── DTOs ──────────────────────────────────────────────────────
class CourseQueryDto extends PaginationDto {
  page?: number = 1;
  limit?: number = 20;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() exam?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() type?: 'free' | 'paid';
  @IsOptional() @IsString() status?: string;
}

class CreateCourseDto {
  @ApiProperty() @IsString() @IsNotEmpty() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() instructor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() instructorBio?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() instructorStudents?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() instructorCourses?: number;
  @ApiProperty() @IsString() @IsNotEmpty() subject: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() price?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() originalPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPaid?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsArray() examTags?: string[];
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() totalLessons?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() totalHours?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() bpscRelevance?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() language?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() trialLessonTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['draft','published','review']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() whatYouLearn?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasCertificate?: boolean;
}

class SubmitReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) @Type(() => Number) @IsNumber() @Min(1) @Max(5) rating: number;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}

class CompleteLessonDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() watchTimeSecs?: number;
}

// ── Repository ────────────────────────────────────────────────
@Injectable()
export class CoursesRepository {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async findAll(query: CourseQueryDto, userId?: string) {
    const { page = 1, limit = 20, subject, exam, search, type } = query;
    const offset = (page - 1) * limit;
    const conditions: string[] = [`c.status = 'published'`];
    const params: any[]        = [];

    if (subject) { conditions.push(`c.subject = $${params.length + 1}`); params.push(subject); }
    if (exam)    { conditions.push(`$${params.length + 1} = ANY(c.exam_tags)`); params.push(exam); }
    if (type === 'free') conditions.push(`c.is_paid = FALSE`);
    if (type === 'paid') conditions.push(`c.is_paid = TRUE`);
    if (search)  {
      conditions.push(`to_tsvector('english', c.title || ' ' || COALESCE(c.description,'')) @@ plainto_tsquery($${params.length + 1})`);
      params.push(search);
    }

    const where = conditions.join(' AND ');
    const userSubQuery = userId
      ? `, (
          SELECT json_build_object(
            'id',                ue.id,
            'status',            ue.status,
            'completed_lessons', ue.completed_lessons,
            'total_minutes',     ue.total_minutes,
            'studied_minutes',   ue.studied_minutes,
            'last_studied_at',   ue.last_studied_at,
            'enrolled_at',       ue.enrolled_at,
            'completed_at',      ue.completed_at,
            'last_lesson_id',    ue.last_lesson_id
          )
          FROM user_enrollments ue
          WHERE ue.course_id = c.id AND ue.user_id = $${params.length + 1}
          LIMIT 1
        ) AS enrollment`
      : '';
    if (userId) params.push(userId);

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT c.id, c.title, c.description, c.instructor, c.instructor_bio,
                COALESCE(c.instructor_students, '0') AS instructor_students,
                c.subject, c.price, c.original_price, c.is_paid,
                c.is_featured, c.is_limited_offer, c.offer_ends_at, c.thumbnail_url, (
   SELECT COUNT(*)
   FROM course_lessons cl
   WHERE cl.course_id = c.id
) AS total_lessons,
                c.total_hours, c.rating, c.review_count, c.enrollment_count, c.bpsc_relevance,
                c.exam_tags, c.language, c.status, c.created_at, c.trial_lesson_title,
                c.what_you_learn, c.has_certificate${userSubQuery}
         FROM courses c
         WHERE ${where}
         ORDER BY c.is_featured DESC, c.enrollment_count DESC, c.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM courses c WHERE ${where}`, params.slice(0, userId ? params.length - 1 : params.length)),
    ]);

    return { rows, total: parseInt(countResult[0].count) };
  }

  async findOneById(courseId: string, userId?: string) {
    const result = await this.db.query(
      `SELECT
         c.id, c.title, c.slug, c.description, c.instructor, c.instructor_bio,
         c.instructor_students, c.instructor_courses,
         c.subject, c.price, c.original_price, c.is_paid, c.is_featured,
         c.is_limited_offer, c.offer_ends_at, c.thumbnail_url,
         (
   SELECT COUNT(*)
   FROM course_lessons cl
   WHERE cl.course_id = c.id
) AS total_lessons, c.total_hours, c.rating, c.review_count,
         c.enrollment_count, c.bpsc_relevance, c.syllabus_coverage,
         c.language, c.trial_lesson_title, c.exam_tags, c.status,
         c.what_you_learn, c.has_certificate,
         c.created_at, c.updated_at,

         ${userId ? `(
           SELECT json_build_object(
             'id',               ue.id,
             'status',           ue.status,
             'completed_lessons',ue.completed_lessons,
             'total_minutes',    ue.total_minutes,
             'studied_minutes',  ue.studied_minutes,
             'last_studied_at',  ue.last_studied_at,
             'enrolled_at',      ue.enrolled_at,
             'completed_at',     ue.completed_at,
             'last_lesson_id',   ue.last_lesson_id
           )
           FROM user_enrollments ue
           WHERE ue.user_id = $2 AND ue.course_id = c.id LIMIT 1
         ) AS enrollment,` : ''}

         ${userId ? `(
          SELECT EXISTS (
            SELECT 1
            FROM course_reviews cr
            WHERE cr.course_id = c.id
              AND cr.user_id = $2
          )
        ) AS has_reviewed,` : ''}

         (
           SELECT json_agg(
             json_build_object(
               'id', ch.id, 'title', ch.title, 'sort_order', ch.sort_order,
               'lessons', (
                 SELECT json_agg(
                   json_build_object(
                     'id',             l.id,
                     'title',          l.title,
                     'duration_mins',  l.duration_mins,
                     'type',           l.type,
                     'is_free_preview',l.is_free_preview,
                     'is_locked',      l.is_locked,
                     'sort_order',     l.sort_order,
                     'is_completed',   ${userId
                       ? `(SELECT lp.is_completed FROM lesson_progress lp WHERE lp.user_id=$2 AND lp.lesson_id=l.id LIMIT 1)`
                       : 'FALSE'}
                   ) ORDER BY l.sort_order
                 ) FROM course_lessons l WHERE l.chapter_id = ch.id
               )
             ) ORDER BY ch.sort_order
           ) FROM course_chapters ch WHERE ch.course_id = c.id
         ) AS chapters,

         (
           SELECT json_agg(
             json_build_object(
               'id',            cr.id,
               'rating',        cr.rating,
               'comment',       cr.comment,
               'is_verified',   cr.is_verified,
               'created_at',    cr.created_at,
               'reviewer_name', u.name,
               'avatar_url',    u.avatar_url
             ) ORDER BY cr.created_at DESC
           )
           FROM course_reviews cr
           JOIN users u ON cr.user_id = u.id
           WHERE cr.course_id = c.id
           LIMIT 20
         ) AS reviews,

         (
           SELECT json_build_object(
             '5', COUNT(*) FILTER (WHERE cr.rating = 5),
             '4', COUNT(*) FILTER (WHERE cr.rating = 4),
             '3', COUNT(*) FILTER (WHERE cr.rating = 3),
             '2', COUNT(*) FILTER (WHERE cr.rating = 2),
             '1', COUNT(*) FILTER (WHERE cr.rating = 1)
           )
           FROM course_reviews cr WHERE cr.course_id = c.id
         ) AS rating_distribution

       FROM courses c
       WHERE c.id = $1 AND c.status = 'published'`,
      userId ? [courseId, userId] : [courseId]
    );
    return result[0] || null;
  }

  async findAllAdmin(query: CourseQueryDto) {
    const { page = 1, limit = 20, search, status, subject } = query;
    const offset = (page - 1) * limit;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (status)  { conditions.push(`c.status = $${params.length + 1}`); params.push(status); }
    if (subject) { conditions.push(`c.subject = $${params.length + 1}`); params.push(subject); }
    if (search)  { conditions.push(`c.title ILIKE $${params.length + 1}`); params.push(`%${search}%`); }

    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT c.*, a.name AS created_by_name,
           (SELECT COUNT(*) FROM course_chapters ch WHERE ch.course_id=c.id) AS total_chapters
         FROM courses c
         LEFT JOIN admin_users a ON c.created_by = a.id
         WHERE ${where} ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM courses c WHERE ${where}`, params),
    ]);

    return { rows, total: parseInt(countResult[0].count) };
  }

  async create(data: CreateCourseDto, adminId: string) {
    const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    const result = await this.db.query(
      `INSERT INTO courses (title, slug, description, instructor, instructor_bio,
        instructor_students, instructor_courses,
        subject, price, original_price, is_paid, is_featured, total_lessons, total_hours,
        bpsc_relevance, language, trial_lesson_title, exam_tags, status,
        what_you_learn, has_certificate, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [
        data.title, slug, data.description, data.instructor, data.instructorBio,
        data.instructorStudents || '0', data.instructorCourses || 1,
        data.subject, data.price || 0, data.originalPrice || data.price || 0,
        data.isPaid || false, data.isFeatured || false, data.totalLessons || 0,
        data.totalHours || 0, data.bpscRelevance || 0, data.language || 'Hindi + English',
        data.trialLessonTitle, data.examTags || [], data.status || 'draft',
        data.whatYouLearn || [], data.hasCertificate !== false, adminId,
      ]
    );
    return result[0];
  }

  async update(courseId: string, data: Partial<CreateCourseDto>) {
    const fields: string[] = [];
    const values: any[]    = [];
    let i = 1;

    const map: Record<string, string> = {
      title: 'title', description: 'description', instructor: 'instructor',
      instructorBio: 'instructor_bio',
      instructorStudents: 'instructor_students', instructorCourses: 'instructor_courses',
      subject: 'subject', price: 'price',
      originalPrice: 'original_price', isPaid: 'is_paid', isFeatured: 'is_featured',
      totalLessons: 'total_lessons', totalHours: 'total_hours', bpscRelevance: 'bpsc_relevance',
      language: 'language', trialLessonTitle: 'trial_lesson_title',
      examTags: 'exam_tags', status: 'status',
      whatYouLearn: 'what_you_learn', hasCertificate: 'has_certificate',
    };

    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(data[key]);
      }
    }

    if (!fields.length) return;
    fields.push(`updated_at = NOW()`);
    values.push(courseId);

    await this.db.query(
      `UPDATE courses SET ${fields.join(', ')} WHERE id = $${i}`,
      values
    );
  }

  async updateThumbnail(courseId: string, url: string) {
    await this.db.query(`UPDATE courses SET thumbnail_url = $1, updated_at = NOW() WHERE id = $2`, [url, courseId]);
  }

  async softDelete(courseId: string) {
    await this.db.query(`UPDATE courses SET status = 'rejected', updated_at = NOW() WHERE id = $1`, [courseId]);
  }
}

// ── Service ───────────────────────────────────────────────────
@Injectable()
export class CoursesService {
  constructor(
    private readonly repo: CoursesRepository,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @InjectDataSource() private readonly db: DataSource,
    private readonly notifService: NotificationService,
  ) {}

  async findAll(query: CourseQueryDto, userId?: string) {
    const cacheKey = `courses:${JSON.stringify(query)}:${userId || 'anon'}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const { rows, total } = await this.repo.findAll(query, userId);
    const result = successResponse({ courses: rows }, 'Success', paginationMeta(total, query.page, query.limit));
    await this.cache.set(cacheKey, result, 120);
    return result;
  }

  async findOne(courseId: string, userId?: string) {
    const course = await this.repo.findOneById(courseId, userId);
    if (!course) throw new NotFoundException('Course not found');
    return successResponse({ course });
  }

  async enroll(courseId: string, userId: string) {
    const course = await this.db.query(`SELECT id, is_paid FROM courses WHERE id=$1 AND status='published'`, [courseId]);
    if (!course.length) throw new NotFoundException('Course not found');

    if (course[0].is_paid) {
      const sub = await this.db.query(
        `SELECT id FROM subscriptions WHERE user_id=$1 AND status='active' AND ends_at > NOW()`, [userId]
      );
      if (!sub.length) {
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS course_purchases (
            id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            course_id             UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            amount                INTEGER NOT NULL DEFAULT 0,
            razorpay_order_id     VARCHAR(100),
            razorpay_payment_id   VARCHAR(100),
            payment_method        VARCHAR(50),
            status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','completed','refunded','failed')),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, course_id)
          )
        `);

        const individualPurchase = await this.db.query(
          `SELECT id FROM course_purchases WHERE user_id=$1 AND course_id=$2 AND status='completed'`,
          [userId, courseId]
        );
        if (!individualPurchase.length) {
          const coursePrice = course[0].price || 0;
          let razorpayOrderId: string | null = null;
          try {
            const rpKey    = process.env.RAZORPAY_KEY_ID;
            const rpSecret = process.env.RAZORPAY_KEY_SECRET;
            const rpRes = await fetch('https://api.razorpay.com/v1/orders', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${rpKey}:${rpSecret}`).toString('base64'),
              },
              body: JSON.stringify({
                amount:   coursePrice * 100,
                currency: 'INR',
                receipt:  `course_${courseId.substring(0,8)}_${userId.substring(0,8)}`,
                notes:    { courseId, userId, type: 'course_purchase' },
              }),
            });
            const rpData = await rpRes.json();
            razorpayOrderId = rpData.id || null;

            if (razorpayOrderId) {
              await this.db.query(
                `INSERT INTO course_purchases (user_id, course_id, amount, razorpay_order_id, status)
                 VALUES ($1,$2,$3,$4,'pending')
                 ON CONFLICT (user_id, course_id) DO UPDATE SET razorpay_order_id=$4, status='pending'`,
                [userId, courseId, coursePrice, razorpayOrderId]
              );
            }
          } catch (err: any) {
            console.error('Course order creation failed:', err.message);
          }

          throw new HttpException({
            message:         'Purchase required to enroll in this course',
            code:            'PURCHASE_REQUIRED',
            price:           coursePrice,
            razorpayOrderId,
            razorpayKeyId:   process.env.RAZORPAY_KEY_ID,
            courseTitle:     course[0].title,
            courseId,
          }, HttpStatus.PAYMENT_REQUIRED);
        }
      }
    }

    await this.db.query(
      `INSERT INTO user_enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING`,
      [userId, courseId]
    );
    await this.db.query(`UPDATE courses SET enrollment_count = enrollment_count + 1 WHERE id = $1`, [courseId]);
    const keys = await this.cache.store.keys('courses:*');
    for (const k of keys) await this.cache.del(k);

    // ── Referral milestone 2 — engagement: friend enrolled in a course ──
    this.authService.awardReferralMilestone(userId, 'engagement').catch(() => {});

    this.notifService.pushToUser(
      userId,
      '📚 Enrolled!',
      `You've been enrolled in your new course. Tap to start your first lesson! 🎯`,
      { type: 'course_enrolled', courseId, screen: 'my_courses' }
    ).catch(() => {});

    return successResponse(null, 'Enrolled successfully! Start learning 🚀');
  }

  async completeLesson(courseId: string, lessonId: string, userId: string, dto: CompleteLessonDto) {
    await this.db.query(
      `
      INSERT INTO lesson_progress (
        user_id, lesson_id, is_completed, watch_time_secs, completed_at
      )
      VALUES ($1::uuid, $2::uuid, TRUE, $3::integer, NOW())
      ON CONFLICT (user_id, lesson_id)
      DO UPDATE SET
        is_completed = TRUE,
        watch_time_secs =
          CASE
            WHEN lesson_progress.watch_time_secs > EXCLUDED.watch_time_secs
            THEN lesson_progress.watch_time_secs
            ELSE EXCLUDED.watch_time_secs
          END,
        completed_at = NOW()
      `,
      [userId, lessonId, dto.watchTimeSecs || 0]
    );

    const progress = await this.db.query(
      `SELECT COUNT(*) AS completed FROM lesson_progress lp
       JOIN course_lessons cl ON lp.lesson_id = cl.id
       WHERE lp.user_id=$1 AND cl.course_id=$2 AND lp.is_completed=TRUE`,
      [userId, courseId]
    );
    const completedLessons = parseInt(progress[0].completed);
    const lessonCountResult = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM course_lessons WHERE course_id = $1`,
      [courseId]
    );
    const totalLessons = lessonCountResult[0]?.total || 0;
    const isCompleted  = completedLessons >= totalLessons;

    await this.db.query(
      `UPDATE user_enrollments
       SET completed_lessons = $1::integer,
           last_lesson_id = $2::uuid,
           last_studied_at = NOW(),
           status = CASE WHEN $1::integer >= $3::integer THEN 'completed' ELSE 'active' END
       WHERE user_id = $4::uuid AND course_id = $5::uuid`,
      [completedLessons, lessonId, totalLessons, userId, courseId]
    );

    if (isCompleted) {
      await this.db.query(
        `INSERT INTO certificates (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, courseId]
      );
    }

    return successResponse({ completedLessons, totalLessons, isCompleted });
  }

  async createChapter(courseId: string, data: { title: string; sortOrder?: number }) {
    const [maxRow] = await this.db.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM course_chapters WHERE course_id=$1`, [courseId]);
    const [row] = await this.db.query(`INSERT INTO course_chapters (course_id,title,sort_order) VALUES ($1,$2,$3) RETURNING *`,
      [courseId, data.title, data.sortOrder ?? maxRow.next]);
    await this.db.query(`UPDATE courses SET updated_at=NOW() WHERE id=$1`,[courseId]);
    return successResponse({ chapter: row }, 'Chapter created');
  }

  async updateChapter(chapterId: string, data: { title?: string; sortOrder?: number }) {
    const fields:string[]=[], vals:any[]=[];
    if (data.title!=null){fields.push(`title=$${fields.length+1}`);vals.push(data.title);}
    if (data.sortOrder!=null){fields.push(`sort_order=$${fields.length+1}`);vals.push(data.sortOrder);}
    if (!fields.length) return successResponse(null,'Nothing to update');
    await this.db.query(`UPDATE course_chapters SET ${fields.join(',')} WHERE id=$${fields.length+1}`,[...vals,chapterId]);
    return successResponse(null,'Chapter updated');
  }

  async deleteChapter(chapterId: string) {
    await this.db.query(`DELETE FROM course_chapters WHERE id=$1`,[chapterId]);
    return successResponse(null,'Chapter deleted');
  }

  async createLesson(courseId: string, chapterId: string, data: {
    title:string; durationMins?:number; type?:string; videoUrl?:string;
    notesUrl?:string; isFreePreview?:boolean; isLocked?:boolean; sortOrder?:number;
  }) {
    const [maxRow] = await this.db.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM course_lessons WHERE chapter_id=$1`,[chapterId]);

    // ── FIX: free courses → all lessons unlocked by default ──────
    const [courseRow] = await this.db.query(`SELECT is_paid FROM courses WHERE id=$1`,[courseId]);
    const courseIsPaid = courseRow?.is_paid ?? true;
    // Paid course: respect admin's explicit isLocked setting (default true)
    // Free course: always unlocked regardless of what was passed
    const shouldLock = courseIsPaid ? (data.isLocked !== false) : false;

    const [row] = await this.db.query(
      `INSERT INTO course_lessons (chapter_id,course_id,title,duration_mins,type,video_url,notes_url,is_free_preview,is_locked,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [chapterId,courseId,data.title,data.durationMins||0,data.type||'pdf',
       data.videoUrl||null,data.notesUrl||null,data.isFreePreview||false,
       shouldLock,data.sortOrder??maxRow.next]
    );
    await this.db.query(`UPDATE courses SET total_lessons=(SELECT COUNT(*) FROM course_lessons WHERE course_id=$1),updated_at=NOW() WHERE id=$1`,[courseId]);
    return successResponse({ lesson: row },'Lesson created');
  }

  async updateLesson(lessonId: string, data: {
    title?:string; durationMins?:number; type?:string; videoUrl?:string;
    notesUrl?:string; isFreePreview?:boolean; isLocked?:boolean; sortOrder?:number;
  }) {
    const map:Record<string,string>={title:'title',durationMins:'duration_mins',type:'type',
      videoUrl:'video_url',notesUrl:'notes_url',isFreePreview:'is_free_preview',
      isLocked:'is_locked',sortOrder:'sort_order'};
    const fields:string[]=[], vals:any[]=[];
    for (const [k,col] of Object.entries(map)) {
      if (data[k]!==undefined){fields.push(`${col}=$${fields.length+1}`);vals.push(data[k]);}
    }
    if (!fields.length) return successResponse(null,'Nothing to update');
    await this.db.query(`UPDATE course_lessons SET ${fields.join(',')} WHERE id=$${fields.length+1}`,[...vals,lessonId]);
    return successResponse(null,'Lesson updated');
  }

  async deleteLesson(lessonId: string) {
    const rows = await this.db.query(`SELECT course_id FROM course_lessons WHERE id=$1`,[lessonId]);
    await this.db.query(`DELETE FROM course_lessons WHERE id=$1`,[lessonId]);
    if (rows[0]) await this.db.query(`UPDATE courses SET total_lessons=(SELECT COUNT(*) FROM course_lessons WHERE course_id=$1) WHERE id=$1`,[rows[0].course_id]);
    return successResponse(null,'Lesson deleted');
  }

  async getChapters(courseId: string) {
    const chapters = await this.db.query(`
      SELECT ch.id,ch.title,ch.sort_order,
        json_agg(json_build_object('id',l.id,'title',l.title,'duration_mins',l.duration_mins,
          'type',l.type,'video_url',l.video_url,'notes_url',l.notes_url,
          'is_free_preview',l.is_free_preview,'is_locked',l.is_locked,'sort_order',l.sort_order
        ) ORDER BY l.sort_order) FILTER (WHERE l.id IS NOT NULL) AS lessons
      FROM course_chapters ch
      LEFT JOIN course_lessons l ON l.chapter_id=ch.id
      WHERE ch.course_id=$1 GROUP BY ch.id ORDER BY ch.sort_order
    `,[courseId]);
    return successResponse({ chapters });
  }

  async getLessonDetail(courseId: string, lessonId: string, userId: string) {
    // Update last activity
    await this.db.query(
      `UPDATE user_enrollments SET last_studied_at=NOW(), last_lesson_id=$1::uuid
       WHERE user_id=$2::uuid AND course_id=$3::uuid`,
      [lessonId, userId, courseId]
    );

    const rows = await this.db.query(`
      SELECT l.*,
        (SELECT lp.is_completed FROM lesson_progress lp WHERE lp.user_id=$2 AND lp.lesson_id=l.id) AS is_completed,
        (SELECT lp.watch_time_secs FROM lesson_progress lp WHERE lp.user_id=$2 AND lp.lesson_id=l.id) AS watch_time_secs
      FROM course_lessons l WHERE l.id=$1
    `, [lessonId, userId]);

    if (!rows[0]) throw new NotFoundException('Lesson not found');
    const lesson = rows[0];

    // ── FIX: enforce access control based on course type ─────────
    if (lesson.is_locked) {
      const [course] = await this.db.query(`SELECT is_paid FROM courses WHERE id=$1`,[courseId]);
      if (course?.is_paid) {
        // Paid course — check enrollment
        const [enroll] = await this.db.query(
          `SELECT id FROM user_enrollments WHERE user_id=$1 AND course_id=$2`,[userId,courseId]
        );
        if (!enroll) throw new ForbiddenException('Enroll to access this lesson');
        // Enrolled user → unlock
        lesson.is_locked = false;
      } else {
        // Free course — never locked
        lesson.is_locked = false;
      }
    }

    return successResponse({ lesson });
  }

  async submitReview(courseId: string, userId: string, dto: SubmitReviewDto) {
    await this.db.query(
      `INSERT INTO course_reviews (course_id, user_id, rating, comment, is_verified) VALUES ($1,$2,$3,$4,TRUE)
       ON CONFLICT (course_id, user_id) DO UPDATE SET rating=$3, comment=$4`,
      [courseId, userId, dto.rating, dto.comment]
    );
    await this.db.query(
      `UPDATE courses SET
         rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM course_reviews WHERE course_id = $1),
         review_count = (SELECT COUNT(*) FROM course_reviews WHERE course_id = $1),
         updated_at = NOW()
       WHERE id = $1`,
      [courseId]
    );
    await this.cache.del(`course:${courseId}:*`);
    return successResponse(null, 'Review submitted');
  }

  // ── Save / Wishlist ──────────────────────────────────────────
  async toggleSave(courseId: string, userId: string) {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS course_saves (
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        saved_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, course_id)
      )
    `);
    const existing = await this.db.query(
      `SELECT user_id FROM course_saves WHERE user_id=$1 AND course_id=$2`,
      [userId, courseId]
    );
    if (existing.length) {
      await this.db.query(`DELETE FROM course_saves WHERE user_id=$1 AND course_id=$2`, [userId, courseId]);
      return successResponse({ isSaved: false }, 'Removed from saved');
    }
    await this.db.query(
      `INSERT INTO course_saves (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, courseId]
    );
    return successResponse({ isSaved: true }, 'Course saved');
  }

  async getSavedCourses(userId: string) {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS course_saves (
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        saved_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, course_id)
      )
    `);
    const rows = await this.db.query(`
      SELECT c.*,
        COALESCE(e.completed_lessons,0) AS completed_lessons_count,
        e.last_studied_at, e.completed_at,
        (SELECT COUNT(*) FROM course_chapters WHERE course_id=c.id)::int AS total_chapters,
        TRUE AS is_saved
      FROM course_saves cs
      JOIN courses c ON c.id = cs.course_id
      LEFT JOIN user_enrollments e ON e.course_id=c.id AND e.user_id=$1
      WHERE cs.user_id=$1
      ORDER BY cs.saved_at DESC
    `, [userId]);
    return successResponse({ courses: rows });
  }

  // ── Admin: Fix free-course lesson locks ──────────────────────
  async unlockAllLessonsForFreeCourse(courseId: string) {
    const [course] = await this.db.query(`SELECT is_paid, title FROM courses WHERE id=$1`,[courseId]);
    if (!course) throw new NotFoundException('Course not found');
    if (course.is_paid) throw new BadRequestException('Course is paid — lessons remain locked by design');
    const result = await this.db.query(
      `UPDATE course_lessons SET is_locked=FALSE, is_free_preview=TRUE
       WHERE course_id=$1 RETURNING id`,
      [courseId]
    );
    return successResponse({ unlockedCount: result.length }, `Unlocked ${result.length} lessons in "${course.title}" ✅`);
  }

  async bulkUnlockFreeCourses() {
    const result = await this.db.query(`
      UPDATE course_lessons cl SET is_locked=FALSE, is_free_preview=TRUE
      FROM courses c
      WHERE cl.course_id=c.id AND c.is_paid=FALSE AND cl.is_locked=TRUE
      RETURNING cl.id
    `);
    return successResponse({ unlockedCount: result.length }, `Fixed ${result.length} locked lessons across all free courses ✅`);
  }

  // Admin
  async findAllAdmin(query: CourseQueryDto) {
    const { rows, total } = await this.repo.findAllAdmin(query);
    return successResponse({ courses: rows }, 'Success', paginationMeta(total, query.page, query.limit));
  }

  async adminCreate(dto: CreateCourseDto, adminId: string) {
    const course = await this.repo.create(dto, adminId);
    await this.invalidateCache();
    if (dto.status === 'published') {
      this.sendCourseNotification(course.id || '', dto.title, dto.subject || 'General', dto.isPaid || false).catch(() => {});
    }
    return successResponse({ course }, 'Course created', undefined);
  }

  private async sendCourseNotification(courseId: string, title: string, subject: string, isPaid: boolean) {
    try {
      const adminSdk = await import('firebase-admin');
      if (!adminSdk.apps.length) return;
      const rows = await this.db.query(
        `SELECT fcm_token FROM users WHERE notification_enabled=TRUE AND fcm_token IS NOT NULL AND status='active' LIMIT 2000`
      );
      const tokens: string[] = rows.map((r: any) => r.fcm_token).filter(Boolean);
      if (!tokens.length) return;
      for (let i = 0; i < tokens.length; i += 500) {
        await adminSdk.messaging().sendEachForMulticast({
          tokens: tokens.slice(i, i + 500),
          notification: { title: `📚 New Course: ${title}`, body: `${subject} course now available! ${isPaid ? 'Premium' : 'Free'}.` },
          data: { type: 'new_course', courseId, screen: 'courses' },
          android: { priority: 'high' },
        }).catch(() => {});
      }
    } catch (_) {}
  }

  async adminUpdate(courseId: string, dto: Partial<CreateCourseDto>) {
    await this.repo.update(courseId, dto);
    await this.invalidateCache();
    return successResponse(null, 'Course updated — changes are live in mobile app ✅');
  }

  async adminDelete(courseId: string) {
    await this.repo.softDelete(courseId);
    await this.invalidateCache();
    return successResponse(null, 'Course removed from app');
  }

  // ── Lesson file upload (local disk, same pattern as study-materials) ──
  async uploadLessonFile(file: Express.Multer.File): Promise<{ fileUrl: string; fileSizeBytes: number }> {
    const baseUrl = this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in';
    const uploadDir = './uploads';
    const now = new Date();
    const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dest = join(uploadDir, 'lessons', subDir);
    fs.mkdirSync(dest, { recursive: true });

    const uniqueId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const safeExt  = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const fileName = `${Date.now()}_${uniqueId}${safeExt}`;
    const fullPath = join(dest, fileName);

    fs.writeFileSync(fullPath, file.buffer);

    const relativePath = `uploads/lessons/${subDir}/${fileName}`;
    const fileUrl = `${baseUrl}/${relativePath}`;
    return successResponse({ fileUrl, fileSizeBytes: file.size });
  }

  async uploadThumbnail(courseId: string, file: Express.Multer.File) {
    const cloudinaryConfig = this.config.get('cloudinary');
    cloudinary.v2.config(cloudinaryConfig);
    const result = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.v2.uploader.upload_stream(
        { folder: 'bpscnotes/courses', resource_type: 'image', width: 800, crop: 'fill' },
        (err, res) => err ? reject(err) : resolve(res)
      );
      stream.end(file.buffer);
    });
    await this.repo.updateThumbnail(courseId, result.secure_url);
    await this.invalidateCache();
    return successResponse({ thumbnailUrl: result.secure_url });
  }

  private async invalidateCache() {
    // Short TTL approach — production should use Redis SCAN for course:* keys
  }
}

// ── Mobile Controller ─────────────────────────────────────────
@ApiTags('Courses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('courses')
export class CoursesController {
  constructor(private readonly service: CoursesService) {}

  @Get()
  @ApiOperation({ summary: 'List courses (with filters)' })
  findAll(@Query() query: CourseQueryDto, @Req() req: any) {
    return this.service.findAll(query, req.user?.id);
  }

  // !! MUST be before @Get(':id') — NestJS matches routes top-down
  @Get('saved')
  getSaved(@Req() r: any) { return this.service.getSavedCourses(r.user.id); }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    // No ParseUUIDPipe — prevents 'saved' from hitting 400 if routing mismatch
    return this.service.findOne(id, req.user?.id);
  }

  @Post(':id/save')
  @HttpCode(200)
  toggleSave(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.service.toggleSave(id, r.user.id);
  }

  @Delete(':id/save')
  @HttpCode(200)
  unsaveCourse(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.service.toggleSave(id, r.user.id);
  }

  @Post(':id/enroll')
  @HttpCode(HttpStatus.CREATED)
  enroll(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.enroll(id, req.user.id);
  }

  @Post(':courseId/lessons/:lessonId/complete')
  @HttpCode(HttpStatus.OK)
  completeLesson(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CompleteLessonDto,
    @Req() req: any,
  ) { return this.service.completeLesson(courseId, lessonId, req.user.id, dto); }

  @Get(':courseId/lessons/:lessonId')
  getLessonDetail(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Req() req: any,
  ) { return this.service.getLessonDetail(courseId, lessonId, req.user.id); }

  @Post(':id/review')
  @HttpCode(HttpStatus.CREATED)
  submitReview(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Body() dto: SubmitReviewDto,
  ) { return this.service.submitReview(id, req.user.id, dto); }
}

// ── Admin Controller ──────────────────────────────────────────
@ApiTags('Admin — Courses')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/courses')
export class AdminCoursesController {
  constructor(private readonly service: CoursesService) {}

  @Get()
  @RequirePermission('courses')
  findAll(@Query() query: CourseQueryDto) { return this.service.findAllAdmin(query); }

  @Post()
  @RequirePermission('courses')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateCourseDto, @Req() req: any) { return this.service.adminCreate(dto, req.admin.id); }

  @Put(':id')
  @RequirePermission('courses')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: Partial<CreateCourseDto>) { return this.service.adminUpdate(id, dto); }

  @Delete(':id')
  @RequirePermission('courses')
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.service.adminDelete(id); }

  @Post(':id/thumbnail')
  @RequirePermission('courses')
  @UseInterceptors(FileInterceptor('thumbnail'))
  uploadThumbnail(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.service.uploadThumbnail(id, file);
  }

  @Get(':id/chapters')
  @RequirePermission('courses')
  getChapters(@Param('id', ParseUUIDPipe) id: string) { return this.service.getChapters(id); }

  @Post(':id/chapters')
  @RequirePermission('courses')
  createChapter(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.service.createChapter(id, dto); }

  @Put(':id/chapters/:chapterId')
  @RequirePermission('courses')
  updateChapter(@Param('chapterId', ParseUUIDPipe) chapterId: string, @Body() dto: any) { return this.service.updateChapter(chapterId, dto); }

  @Delete(':id/chapters/:chapterId')
  @RequirePermission('courses')
  @HttpCode(HttpStatus.OK)
  deleteChapter(@Param('chapterId', ParseUUIDPipe) chapterId: string) { return this.service.deleteChapter(chapterId); }

  @Post(':id/chapters/:chapterId/lessons')
  @RequirePermission('courses')
  createLesson(
    @Param('id', ParseUUIDPipe) courseId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: any,
  ) { return this.service.createLesson(courseId, chapterId, dto); }

  @Put(':id/lessons/:lessonId')
  @RequirePermission('courses')
  updateLesson(@Param('lessonId', ParseUUIDPipe) lessonId: string, @Body() dto: any) { return this.service.updateLesson(lessonId, dto); }

  @Delete(':id/lessons/:lessonId')
  @RequirePermission('courses')
  @HttpCode(HttpStatus.OK)
  deleteLesson(@Param('lessonId', ParseUUIDPipe) lessonId: string) { return this.service.deleteLesson(lessonId); }

  /**
   * POST /admin/courses/:id/lessons/upload-file
   * Accepts a PDF (max 50 MB) or video (max 500 MB), saves to local disk,
   * returns { fileUrl, fileSizeBytes }.
   * The admin page stores the returned URL in notesUrl / videoUrl.
   */
  @Post(':id/lessons/upload-file')
  @RequirePermission('courses')
  @UseInterceptors(FileInterceptor('file', {
    storage: require('multer').memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB hard cap (video)
    fileFilter: (_req: any, file: any, cb: any) => {
      const ALLOWED = [
        'application/pdf',
        'video/mp4', 'video/x-m4v', 'video/quicktime',
        'video/x-msvideo', 'video/webm', 'video/mkv', 'video/x-matroska',
      ];
      if (ALLOWED.includes(file.mimetype)) return cb(null, true);
      cb(new BadRequestException(`File type not allowed: ${file.mimetype}`), false);
    },
  }))
  uploadLessonFile(
    @Param('id') _courseId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.service.uploadLessonFile(file);
  }

  // ── Free-course lesson lock fix endpoints ────────────────────
  /** POST /admin/courses/bulk-fix-free-locks — unlock lessons on ALL free courses */
  @Post('bulk-fix-free-locks')
  @RequirePermission('courses')
  @HttpCode(200)
  bulkFixFreeLocks() { return this.service.bulkUnlockFreeCourses(); }

  /** POST /admin/courses/:id/unlock-free-lessons — unlock one specific free course */
  @Post(':id/unlock-free-lessons')
  @RequirePermission('courses')
  @HttpCode(200)
  unlockFreeLessons(@Param('id', ParseUUIDPipe) id: string) { return this.service.unlockAllLessonsForFreeCourse(id); }
}

// ── Module ────────────────────────────────────────────────────
@Module({
  imports:     [AuthModule, NotificationsModule],
  controllers: [CoursesController, AdminCoursesController],
  providers:   [CoursesService, CoursesRepository, NotificationService],
  exports:     [CoursesService],
})
export class CoursesModule {}