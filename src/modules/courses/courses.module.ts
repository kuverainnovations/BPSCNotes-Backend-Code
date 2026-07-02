import * as CashfreeUtil from '../../common/utils/cashfree.util';
// ════════════════════════════════════════════════════════════
// COURSES MODULE — Repository → Service → Controller
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, HttpException, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus, NotFoundException,
  ForbiddenException, BadRequestException, ParseUUIDPipe, UseGuards, UseInterceptors,
  UploadedFile, Header,
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
import { ActivityLogService, ACTIONS } from '../../common/activity/activity-log.service';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthService } from '../auth/auth.module';
import { AuthModule } from '../auth/auth.module';
import * as cloudinary from 'cloudinary';
import { NotificationService, NotificationsModule } from '@modules/combined-modules-1.module';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { generateCertificatePdf } from '../../common/utils/certificate-generator.util';

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
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() syllabusCoverage?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() language?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() trialLessonTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['draft','published','review']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() whatYouLearn?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasCertificate?: boolean;
  // Per-course override for how many coins a buyer may redeem as a
  // discount on this course. Null/omitted -> falls back to the global
  // app_settings.max_coins_per_purchase setting.
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() maxCoinsRedeemable?: number;
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
    if (exam)    {
      // A course with no exam_tags is "general" — relevant to everyone.
      // `$X = ANY(exam_tags)` alone is FALSE for an empty array, which
      // would silently hide every untagged course once a user has an
      // exam selected. Match either: tagged for this exam, OR untagged.
      conditions.push(`($${params.length + 1} = ANY(c.exam_tags) OR c.exam_tags IS NULL OR c.exam_tags = '{}')`);
      params.push(exam);
    }
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
                c.is_featured, c.is_limited_offer, c.offer_ends_at, c.thumbnail_url,
                c.max_coins_redeemable, (
   SELECT COUNT(*)
   FROM course_lessons cl
   WHERE cl.course_id = c.id
) AS total_lessons,
                c.total_hours, c.rating, c.review_count,
                (
   SELECT COUNT(*)
   FROM user_enrollments ue2
   WHERE ue2.course_id = c.id
) AS enrollment_count,
                c.bpsc_relevance,
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
         c.max_coins_redeemable,
         (
   SELECT COUNT(*)
   FROM course_lessons cl
   WHERE cl.course_id = c.id
) AS total_lessons, c.total_hours, c.rating, c.review_count,
         (
   SELECT COUNT(*)
   FROM user_enrollments ue2
   WHERE ue2.course_id = c.id
) AS enrollment_count, c.bpsc_relevance, c.syllabus_coverage,
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
                     'is_locked',      (l.is_locked AND NOT ${userId
                       ? `EXISTS (SELECT 1 FROM user_enrollments ue WHERE ue.user_id=$2 AND ue.course_id=c.id)`
                       : 'FALSE'}),
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
        bpsc_relevance, syllabus_coverage, language, trial_lesson_title, exam_tags, status,
        what_you_learn, has_certificate, created_by, max_coins_redeemable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [
        data.title, slug, data.description, data.instructor, data.instructorBio,
        data.instructorStudents || '0', data.instructorCourses || 1,
        data.subject, data.price || 0, data.originalPrice || data.price || 0,
        data.isPaid || false, data.isFeatured || false, data.totalLessons || 0,
        data.totalHours || 0, data.bpscRelevance || 0, data.syllabusCoverage || 0,
        data.language || 'Hindi + English',
        data.trialLessonTitle, data.examTags || [], data.status || 'draft',
        data.whatYouLearn || [], data.hasCertificate !== false, adminId,
        data.maxCoinsRedeemable ?? null,
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
      syllabusCoverage: 'syllabus_coverage',
      language: 'language', trialLessonTitle: 'trial_lesson_title',
      examTags: 'exam_tags', status: 'status',
      whatYouLearn: 'what_you_learn', hasCertificate: 'has_certificate',
      rejection_reason: 'rejection_reason',
      maxCoinsRedeemable: 'max_coins_redeemable',
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
    private readonly activityLog?: ActivityLogService,
  ) {}

  // Reads a numeric value from app_settings (e.g. coin_to_inr_rate,
  // max_coins_per_purchase), falling back to a default if unset/invalid.
  private async getSettingNumber(key: string, fallback: number): Promise<number> {
    const [row] = await this.db.query(
      `SELECT value FROM app_settings WHERE key=$1 LIMIT 1`, [key]
    ).catch(() => []);
    const n = parseFloat(row?.value);
    return isNaN(n) ? fallback : n;
  }

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

  async enroll(courseId: string, userId: string, coinsToApply = 0) {
    const course = await this.db.query(`SELECT id, is_paid, price, title, max_coins_redeemable FROM courses WHERE id=$1 AND status='published'`, [courseId]);
    if (!course.length) throw new NotFoundException('Course not found');

    // Idempotency: already enrolled → return success immediately, no coin deduction.
    const existing = await this.db.query(
      `SELECT id FROM user_enrollments WHERE user_id=$1 AND course_id=$2`, [userId, courseId]
    );
    if (existing.length > 0) return successResponse(null, 'Already enrolled');

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
        // Coin-discount tracking columns — added separately so existing
        // deployments with the table already created still pick them up.
        await this.db.query(`ALTER TABLE course_purchases ADD COLUMN IF NOT EXISTS coins_applied INTEGER NOT NULL DEFAULT 0`);
        await this.db.query(`ALTER TABLE course_purchases ADD COLUMN IF NOT EXISTS coin_discount_inr INTEGER NOT NULL DEFAULT 0`);

        const individualPurchase = await this.db.query(
          `SELECT id, amount FROM course_purchases WHERE user_id=$1 AND course_id=$2 AND status='completed'`,
          [userId, courseId]
        );
        const coursePrice = Math.floor(Number(course[0].price) || 0);
        // A "completed" purchase recorded at ₹0 for a course that now has a
        // real price is a stale row from before the price-fetch bug was
        // fixed — it doesn't represent a genuine payment. Treat it as if no
        // purchase exists so the user is correctly asked to pay.
        const hasValidPurchase = individualPurchase.length > 0 &&
          !(coursePrice > 0 && Number(individualPurchase[0].amount) === 0);

        if (!hasValidPurchase) {
          // ── Coin discount — capped at maxCoinDiscountPctCourse % of course price ──
          const maxPct        = await this.getSettingNumber('max_coin_discount_pct_course', 10);
          const coinToInrRate = await this.getSettingNumber('coin_to_inr_rate', 1);
          const maxCoins      = coinToInrRate > 0 ? Math.floor(coursePrice * maxPct / 100 / coinToInrRate) : 0;
          const coinsApplied  = Math.max(0, Math.min(Math.floor(coinsToApply || 0), maxCoins));

          if (coinsApplied > 0) {
            const [userRow] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
            if (!userRow || userRow.coins < coinsApplied) {
              throw new BadRequestException(`You only have ${userRow?.coins ?? 0} coins.`);
            }
          }

          const coinDiscountInr = Math.min(coursePrice, Math.floor(coinsApplied * coinToInrRate));
          const amountDueInr    = coursePrice - coinDiscountInr;

          // ── Fully covered by coins — no gateway call needed ──
          if (amountDueInr <= 0) {
            if (coinsApplied > 0) {
              // Atomic deduction: only succeeds if user still has enough coins.
              // Prevents double-deduction from concurrent requests.
              const deducted = await this.db.query(
                `UPDATE users SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING coins`,
                [coinsApplied, userId]
              );
              if (!deducted.length) throw new BadRequestException('Insufficient coins.');
              const [u] = deducted;
              await this.db.query(
                `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
                 VALUES ($1,'spent',$2,'Course purchase discount: '||$3,'course_purchase_discount',$4)`,
                [userId, coinsApplied, course[0].title, Math.floor(Number(u.coins))]
              );
            }
            await this.db.query(
              `INSERT INTO course_purchases (user_id, course_id, amount, coins_applied, coin_discount_inr, status)
               VALUES ($1,$2,$3,$4,$5,'completed')
               ON CONFLICT (user_id, course_id) DO UPDATE
                 SET amount=$3, coins_applied=$4, coin_discount_inr=$5, status='completed', updated_at=NOW()`,
              [userId, courseId, coursePrice, coinsApplied, coinDiscountInr]
            );
            // Fall through to grant enrollment below.
          } else {
            // ── Create Cashfree order for the remaining ₹ balance ──
            let paymentSessionId: string | null = null;
            let cfOrderId:        string | null = null;
            let paymentEnvironment: 'sandbox' | 'production' = 'sandbox';
            try {
              const { createCashfreeOrder, buildCashfreeCredentials, cashfreeReceiptId } = CashfreeUtil;
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
              // Expose environment so Android SDK uses the matching endpoint
              paymentEnvironment = creds.env;
              const [userRow] = await this.db.query(
                `SELECT name, email, mobile FROM users WHERE id=$1`, [userId]
              );
              const order = await createCashfreeOrder(creds, {
                orderId:       cashfreeReceiptId('course', courseId, userId),
                orderAmount:   amountDueInr,
                orderCurrency: 'INR',
                customerId:    userId,
                customerPhone: userRow?.mobile || '9999999999',
                customerEmail: userRow?.email  || `${userId}@bpscnotes.app`,
                customerName:  userRow?.name   || 'BPSCNotes User',
                orderNote:     `Course: ${course[0].title}`,
                orderMeta:     { courseId, type: 'course_purchase' },
              });
              paymentSessionId = order.paymentSessionId;
              cfOrderId        = order.orderId;

              await this.db.query(
                `INSERT INTO course_purchases
                   (user_id, course_id, amount, coins_applied, coin_discount_inr,
                    provider_order_id, payment_provider, status)
                 VALUES ($1,$2,$3,$4,$5,$6,'cashfree','pending')
                 ON CONFLICT (user_id, course_id) DO UPDATE
                   SET amount=$3, coins_applied=$4, coin_discount_inr=$5,
                       provider_order_id=$6, payment_provider='cashfree',
                       status='pending', updated_at=NOW()`,
                [userId, courseId, amountDueInr, coinsApplied, coinDiscountInr, cfOrderId]
              );
            } catch (err: any) {
              console.error('Course Cashfree order creation failed:', err.message);
            }

            throw new HttpException({
              message:          'Purchase required to enroll in this course',
              code:             'PURCHASE_REQUIRED',
              price:            amountDueInr,
              coursePrice,
              coinsApplied,
              coinDiscountInr,
              paymentSessionId,
              providerOrderId:  cfOrderId,
              paymentEnvironment,           // → Android SDK: 'sandbox' | 'production'
              courseTitle:      course[0].title,
              courseId,
            }, HttpStatus.PAYMENT_REQUIRED);
          }
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

  // ─────────────────────────────────────────────────────────────
  // POST /courses/:id/purchase/confirm
  // Called by Android after Cashfree payment succeeds.
  // Verifies signature, marks purchase completed, grants enrollment.
  // ─────────────────────────────────────────────────────────────
  async confirmCoursePurchase(
    courseId: string,
    userId: string,
    dto: {
      cfPaymentId:   string;   // from Cashfree SDK after payment
      paymentMethod?: string;
    }
  ) {
    // 1. Idempotency — already completed purchase
    const [alreadyDone] = await this.db.query(
      `SELECT id FROM course_purchases WHERE user_id=$1 AND course_id=$2 AND status='completed'`,
      [userId, courseId]
    );
    if (alreadyDone) {
      await this.db.query(
        `INSERT INTO user_enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING`,
        [userId, courseId]
      );
      return successResponse(null, 'Course already purchased');
    }

    // 2. Find pending purchase row created by enroll()
    // FIX: was missing provider_order_id, so purchase.provider_order_id below was
    // always undefined and every confirm call failed with "Missing provider order
    // ID" before Cashfree verification (and the enrollment insert) ever ran.
    const [purchase] = await this.db.query(
      `SELECT id, amount, coins_applied, provider_order_id FROM course_purchases
       WHERE user_id=$1 AND course_id=$2 AND status='pending'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, courseId]
    );
    if (!purchase) {
      throw new NotFoundException('No pending purchase found. Please go back and try again.');
    }

    // 3. Verify payment with Cashfree (server-side — client cannot tamper)
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
    const providerOrderId = purchase.provider_order_id;
    if (!providerOrderId) {
      throw new BadRequestException('Missing provider order ID. Contact support.');
    }
    const payment = await verifyCashfreePayment(creds, providerOrderId);
    if (payment.paymentStatus !== 'SUCCESS') {
      console.error(
        `COURSE PAYMENT NOT SUCCESS: user=${userId} course=${courseId} ` +
        `order=${providerOrderId} status=${payment.paymentStatus}`
      );
      throw new BadRequestException(`Payment not successful (status: ${payment.paymentStatus}). Contact support.`);
    }

    // 4. Mark purchase as completed
    await this.db.query(
      `UPDATE course_purchases
       SET status='completed', provider_payment_id=$1, payment_provider='cashfree',
           payment_method=$2, updated_at=NOW()
       WHERE id=$3`,
      [payment.cfPaymentId, payment.paymentMethod || 'upi', purchase.id]
    );

    // 4b. Deduct any coins that were reserved as a discount for this order.
    // FIX: wrapped in try/catch — the payment is already verified SUCCESS and
    // course_purchases is already marked completed at this point, so a failure
    // in this side-effect (e.g. a corrupted/NaN coin balance for this user,
    // which Postgres NUMERIC tolerates but INTEGER columns like coin_transactions
    // .amount/.balance reject) must not abort the whole request and block
    // enrollment — that was crashing the entire confirm call with a 500 and
    // leaving the user with a captured payment but no access.
    if (purchase.coins_applied > 0) {
      try {
        const coinsToDeduct = Math.floor(Number(purchase.coins_applied));
        const deducted = await this.db.query(
          `UPDATE users SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING coins`,
          [coinsToDeduct, userId]
        );
        const [u] = deducted.length ? deducted : await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
        const [courseRow] = await this.db.query(`SELECT title FROM courses WHERE id=$1`, [courseId]);
        const balanceAfter = Math.floor(Number(u?.coins));
        await this.db.query(
          `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
           VALUES ($1,'spent',$2,'Course purchase discount: '||$3,'course_purchase_discount',$4)`,
          [userId, coinsToDeduct, courseRow?.title ?? '', Number.isFinite(balanceAfter) ? balanceAfter : 0]
        );
      } catch (err: any) {
        console.error(
          `Course purchase coin-deduction failed (non-fatal — enrollment still granted): ` +
          `user=${userId} course=${courseId} err=${err.message}`
        );
      }
    }

    // 5. Grant enrollment
    await this.db.query(
      `INSERT INTO user_enrollments (user_id, course_id)
       VALUES ($1,$2) ON CONFLICT (user_id, course_id) DO NOTHING`,
      [userId, courseId]
    );
    await this.db.query(
      `UPDATE courses SET enrollment_count = enrollment_count + 1 WHERE id=$1`,
      [courseId]
    );

    // 6. Invalidate cached course list
    try {
      const keys = await (this.cache.store as any).keys?.('courses:*') ?? [];
      for (const k of keys) await this.cache.del(k);
    } catch (_) {}

    // 7. Send push notification
    this.notifService?.pushToUser(
      userId,
      'Course Unlocked!',
      'You now have full access. Start your first lesson!',
      { type: 'course_purchased', courseId, screen: 'my_courses' }
    ).catch(() => {});

    return successResponse(null, 'Course purchased successfully! Start learning');
  }

  async completeLesson(courseId: string, lessonId: string, userId: string, dto: CompleteLessonDto) {
    // FIX: lesson watch time was recorded in lesson_progress but NEVER
    // added to users.total_study_minutes — so course-lesson study time
    // was invisible both to the Study Heatmap and to the Group Study
    // tier system's "Study Hours" requirement. watch_time_secs only ever
    // increases (kept as a running max), so compute the DELTA from the
    // previous value and add just that to the global counter — avoids
    // double-counting on repeat completions.
    const prevRow = await this.db.query(
      `SELECT watch_time_secs FROM lesson_progress WHERE user_id=$1 AND lesson_id=$2`,
      [userId, lessonId]
    );
    const prevWatchSecs = prevRow[0]?.watch_time_secs || 0;
    const newWatchSecs  = dto.watchTimeSecs || 0;
    const deltaSecs     = Math.max(0, newWatchSecs - prevWatchSecs);

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

    if (deltaSecs > 0) {
      await this.db.query(
        `UPDATE users SET total_study_minutes = total_study_minutes + $1 WHERE id=$2`,
        [Math.ceil(deltaSecs / 60), userId]
      );
      // Group Study tier stats (Study Hours requirement / StatPills) are
      // cached and otherwise wouldn't reflect this change.
      await this.cache.del(`user_tier:${userId}`);
    }

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

    if (isCompleted && totalLessons > 0) {
      const [certRow] = await this.db.query(
        `INSERT INTO certificates (user_id, course_id) VALUES ($1,$2)
         ON CONFLICT (user_id, course_id) DO UPDATE SET user_id=EXCLUDED.user_id
         RETURNING id, certificate_url`,
        [userId, courseId]
      );

      // Generate the PDF only if it doesn't exist yet (idempotent —
      // re-completing/re-syncing won't regenerate it every time)
      if (certRow && !certRow.certificate_url) {
        try {
          const [userRow] = await this.db.query(`SELECT name FROM users WHERE id=$1`, [userId]);
          const [courseRow] = await this.db.query(`SELECT title, instructor FROM courses WHERE id=$1`, [courseId]);

          const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
          const relativePath = await generateCertificatePdf(uploadDir, {
            userName: userRow?.name || 'Student',
            courseTitle: courseRow?.title || 'BPSCNotes Course',
            instructor: courseRow?.instructor,
            completedAt: new Date(),
            certificateId: certRow.id,
          });

          const baseUrl = this.config.get<string>('BASE_URL') ?? 'https://api.bpscnotes.in';
          const certificateUrl = `${baseUrl}/uploads/${relativePath}`;

          await this.db.query(
            `UPDATE certificates SET certificate_url=$1 WHERE id=$2`,
            [certificateUrl, certRow.id]
          );
        } catch (err) {
          // Don't fail lesson completion if certificate generation fails —
          // log and let the lazy-generation fallback in getCertificates() retry later
          console.error('Certificate generation failed:', err);
        }
      }
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

    // Lock status is per-lesson and independent of whether the course
    // itself is free or paid — a locked lesson always requires enrollment
    // (free-enroll for free courses, paid-enroll for paid courses).
    // Defaults to locked unless the admin explicitly marks it free preview.
    const shouldLock = data.isFreePreview ? false : (data.isLocked !== false);

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

  // ── Admin: all student reviews/ratings for a course ─────────
  async getCourseReviewsAdmin(courseId: string) {
    const [course] = await this.db.query(
      `SELECT id, title, rating, review_count FROM courses WHERE id=$1`, [courseId]
    );
    if (!course) throw new NotFoundException('Course not found');

    const reviews = await this.db.query(
      `SELECT cr.id, cr.rating, cr.comment, cr.is_verified, cr.created_at,
              u.name AS reviewer_name, u.avatar_url, u.id AS user_id
       FROM course_reviews cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.course_id = $1
       ORDER BY cr.created_at DESC`,
      [courseId]
    );

    const [distribution] = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE rating = 5) AS "5",
         COUNT(*) FILTER (WHERE rating = 4) AS "4",
         COUNT(*) FILTER (WHERE rating = 3) AS "3",
         COUNT(*) FILTER (WHERE rating = 2) AS "2",
         COUNT(*) FILTER (WHERE rating = 1) AS "1"
       FROM course_reviews WHERE course_id = $1`,
      [courseId]
    );

    return successResponse({
      course: { id: course.id, title: course.title, rating: course.rating, reviewCount: course.review_count },
      reviews,
      ratingDistribution: distribution,
    });
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

    // ── Access control: a locked lesson requires enrollment,
    // regardless of whether the course itself is free or paid.
    // Free preview lessons (is_locked=false) are always accessible.
    const [enroll] = await this.db.query(
      `SELECT id FROM user_enrollments WHERE user_id=$1 AND course_id=$2`,[userId,courseId]
    );
    const isEnrolled = !!enroll;

    if (lesson.is_locked) {
      if (!isEnrolled) throw new ForbiddenException('Enroll to access this lesson');
      // Enrolled user → unlock
      lesson.is_locked = false;
    }

    return successResponse({ lesson, isEnrolled });
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
  // saveCourse/unsaveCourse are each idempotent — calling POST /save
  // twice in a row (retry, double-tap, client/server state drift) always
  // leaves it saved; calling DELETE /save twice always leaves it unsaved.
  // They must NOT flip based on current DB state (that was the previous
  // bug: a single blind toggle meant any desync between what the client
  // thought was saved and what the server had would flip it the wrong
  // way — visible as tapping "Save" instantly un-saving it).
  private async ensureCourseSavesTable() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS course_saves (
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        saved_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, course_id)
      )
    `);
  }

  async saveCourse(courseId: string, userId: string) {
    await this.ensureCourseSavesTable();
    await this.db.query(
      `INSERT INTO course_saves (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, courseId]
    );
    return successResponse({ isSaved: true }, 'Course saved');
  }

  async unsaveCourse(courseId: string, userId: string) {
    await this.ensureCourseSavesTable();
    await this.db.query(`DELETE FROM course_saves WHERE user_id=$1 AND course_id=$2`, [userId, courseId]);
    return successResponse({ isSaved: false }, 'Removed from saved');
  }

  async getSavedCourses(userId: string) {
    await this.ensureCourseSavesTable();
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
      const notifTitle = `📚 New Course: ${title}`;
      const notifBody  = `${subject} course now available! ${isPaid ? 'Premium' : 'Free'}.`;

      // FIX Issue 2: Save to notifications + user_notifications tables so the
      // in-app notification list shows the course notification.
      const [notifRow] = await this.db.query(
        `INSERT INTO notifications (title, body, type, target, data, status, sent_at, created_by)
         VALUES ($1,$2,'new_course','all',$3,'sent',NOW(),'system') RETURNING id`,
        [notifTitle, notifBody, JSON.stringify({ courseId, screen: 'courses' })]
      ).catch(() => [null]);

      if (notifRow?.id) {
        // Insert user_notifications rows in chunks of 1000
        const users = await this.db.query(
          `SELECT id FROM users WHERE notification_enabled=TRUE AND status='active'`
        ).catch(() => []);
        for (let i = 0; i < users.length; i += 1000) {
          const chunk = users.slice(i, i + 1000);
          const vals  = chunk.map((_: any, j: number) => `($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4})`).join(',');
          const flat  = chunk.flatMap((u: any) => [u.id, notifRow.id, notifTitle, notifBody]);
          await this.db.query(`INSERT INTO user_notifications (user_id, notification_id, title, body) VALUES ${vals}`, flat).catch(() => {});
        }
      }

      // FCM push with courseId in data payload for deep-link
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
          notification: { title: notifTitle, body: notifBody },
          // FIX Issue 2: include courseId so tapping the notification deep-links to the course
          data: { type: 'new_course', courseId, screen: 'courses' },
          android: { priority: 'high' },
        }).catch(() => {});
      }
    } catch (_) {}
  }

  async adminUpdate(courseId: string, dto: Partial<CreateCourseDto>) {
    // Ensure rejection_reason column exists (migration-safe — matches library_notes pattern)
    await this.db.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS rejection_reason TEXT`).catch(() => {});
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
  async uploadLessonFile(file: Express.Multer.File) {
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
  // no-store: per-user, mutates on every save/unsave — must never be
  // served stale by an intermediate cache (CDN/proxy) or the client's HTTP cache.
  @Get('saved')
  @Header('Cache-Control', 'no-store')
  getSaved(@Req() r: any) { return this.service.getSavedCourses(r.user.id); }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    // No ParseUUIDPipe — prevents 'saved' from hitting 400 if routing mismatch
    return this.service.findOne(id, req.user?.id);
  }

  @Post(':id/save')
  @HttpCode(200)
  saveCourse(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.service.saveCourse(id, r.user.id);
  }

  @Delete(':id/save')
  @HttpCode(200)
  unsaveCourse(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.service.unsaveCourse(id, r.user.id);
  }

  @Post(':id/enroll')
  @HttpCode(HttpStatus.CREATED)
  enroll(@Param('id', ParseUUIDPipe) id: string, @Body() body: { coinsToApply?: number }, @Req() req: any) {
    return this.service.enroll(id, req.user.id, body?.coinsToApply ?? 0);
  }

  @Post(':id/purchase/confirm')
  @HttpCode(HttpStatus.OK)
  confirmCoursePurchase(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Body() dto: {
      cfPaymentId:   string;   // from Cashfree SDK
      paymentMethod?: string;
    }
  ) {
    return this.service.confirmCoursePurchase(id, req.user.id, dto);
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

  // ── Student reviews/ratings for a course — admin view ───────
  @Get(':id/reviews')
  @RequirePermission('courses')
  getReviews(@Param('id', ParseUUIDPipe) id: string) { return this.service.getCourseReviewsAdmin(id); }

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

  /**
   * POST /admin/courses/:id/lessons/upload-file
   * MUST be before :id/lessons/:lessonId — NestJS matches top-down and
   * "upload-file" would otherwise be captured as lessonId → UUID parse fail → 404.
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

  @Put(':id/lessons/:lessonId')
  @RequirePermission('courses')
  updateLesson(@Param('lessonId', ParseUUIDPipe) lessonId: string, @Body() dto: any) { return this.service.updateLesson(lessonId, dto); }

  @Delete(':id/lessons/:lessonId')
  @RequirePermission('courses')
  @HttpCode(HttpStatus.OK)
  deleteLesson(@Param('lessonId', ParseUUIDPipe) lessonId: string) { return this.service.deleteLesson(lessonId); }
}

// ── Module ────────────────────────────────────────────────────
@Module({
  imports:     [AuthModule, NotificationsModule],
  controllers: [CoursesController, AdminCoursesController],
  providers:   [CoursesService, CoursesRepository, NotificationService],
  exports:     [CoursesService],
})
export class CoursesModule {}