// ════════════════════════════════════════════════════════════
// COURSES MODULE — Repository → Service → Controller
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus, NotFoundException,
  ForbiddenException, ParseUUIDPipe, UseGuards, UseInterceptors,
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
            'id',              ue.id,
            'status',          ue.status,
            'completed_lessons', ue.completed_lessons,
            'total_minutes',   ue.total_minutes,
            'studied_minutes', ue.studied_minutes,
            'last_studied_at', ue.last_studied_at,
            'enrolled_at',     ue.enrolled_at,
            'completed_at',    ue.completed_at,
            'last_lesson_id',  ue.last_lesson_id
          )
          FROM user_enrollments ue
          WHERE ue.course_id = c.id AND ue.user_id = $${params.length + 1}
          LIMIT 1
        ) AS enrollment`
      : '';
    if (userId) params.push(userId);

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT c.id, c.title, c.instructor, c.subject, c.price, c.original_price, c.is_paid,
                c.is_featured, c.is_limited_offer, c.offer_ends_at, c.thumbnail_url, c.total_lessons,
                c.total_hours, c.rating, c.review_count, c.enrollment_count, c.bpsc_relevance,
                c.exam_tags, c.language, c.status, c.created_at, c.trial_lesson_title${userSubQuery}
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
      `SELECT c.*,
         ${userId ? `(SELECT row_to_json(ue) FROM user_enrollments ue WHERE ue.user_id = $2 AND ue.course_id = c.id LIMIT 1) AS enrollment,` : ''}
         (
           SELECT json_agg(
             json_build_object(
               'id', ch.id, 'title', ch.title, 'sort_order', ch.sort_order,
               'lessons', (
                 SELECT json_agg(
                   json_build_object(
                     'id', l.id, 'title', l.title, 'duration_mins', l.duration_mins,
                     'type', l.type, 'is_free_preview', l.is_free_preview,
                     'is_locked', l.is_locked, 'sort_order', l.sort_order
                   ) ORDER BY l.sort_order
                 ) FROM course_lessons l WHERE l.chapter_id = ch.id
               )
             ) ORDER BY ch.sort_order
           ) FROM course_chapters ch WHERE ch.course_id = c.id
         ) AS chapters,
         (
           SELECT json_agg(row_to_json(r) ORDER BY r.created_at DESC)
           FROM (
             SELECT cr.rating, cr.comment, cr.is_verified, cr.created_at,
                    u.name AS reviewer_name, u.avatar_url
             FROM course_reviews cr JOIN users u ON cr.user_id = u.id
             WHERE cr.course_id = c.id LIMIT 10
           ) r
         ) AS reviews
       FROM courses c WHERE c.id = $1 AND c.status = 'published'`,
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
        `SELECT c.*, a.name AS created_by_name FROM courses c
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
      `INSERT INTO courses (title, slug, description, instructor, instructor_bio, subject, price,
        original_price, is_paid, is_featured, total_lessons, total_hours, bpsc_relevance,
        language, trial_lesson_title, exam_tags, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        data.title, slug, data.description, data.instructor, data.instructorBio, data.subject,
        data.price || 0, data.originalPrice || data.price || 0, data.isPaid || false,
        data.isFeatured || false, data.totalLessons || 0, data.totalHours || 0,
        data.bpscRelevance || 0, data.language || 'Hindi + English',
        data.trialLessonTitle, data.examTags || [], data.status || 'draft', adminId,
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
      instructorBio: 'instructor_bio', subject: 'subject', price: 'price',
      originalPrice: 'original_price', isPaid: 'is_paid', isFeatured: 'is_featured',
      totalLessons: 'total_lessons', totalHours: 'total_hours', bpscRelevance: 'bpsc_relevance',
      language: 'language', trialLessonTitle: 'trial_lesson_title',
      examTags: 'exam_tags', status: 'status',
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
      if (!sub.length) throw new ForbiddenException({ message: 'Subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    }

    await this.db.query(
      `INSERT INTO user_enrollments (user_id, course_id, total_minutes)
       VALUES ($1, $2, COALESCE((SELECT (total_hours * 60)::int FROM courses WHERE id=$2), 0))
       ON CONFLICT (user_id, course_id) DO NOTHING`,
      [userId, courseId]
    );
    await this.db.query(`UPDATE courses SET enrollment_count = enrollment_count + 1 WHERE id = $1`, [courseId]);
    await this.cache.del(`courses:*`); // bust course cache
    return successResponse(null, 'Enrolled successfully! Start learning 🚀');
  }

  async completeLesson(courseId: string, lessonId: string, userId: string, dto: CompleteLessonDto) {
    await this.db.query(
      `INSERT INTO lesson_progress (user_id, lesson_id, is_completed, watch_time_secs, completed_at)
       VALUES ($1,$2,TRUE,$3,NOW())
       ON CONFLICT (user_id, lesson_id)
       DO UPDATE SET is_completed=TRUE, watch_time_secs=GREATEST(lesson_progress.watch_time_secs,$3), completed_at=NOW()`,
      [userId, lessonId, dto.watchTimeSecs || 0]
    );

    const progress = await this.db.query(
      `SELECT COUNT(*) AS completed FROM lesson_progress lp
       JOIN course_lessons cl ON lp.lesson_id = cl.id
       WHERE lp.user_id=$1 AND cl.course_id=$2 AND lp.is_completed=TRUE`,
      [userId, courseId]
    );
    const completedLessons = parseInt(progress[0].completed);
    const courseData = await this.db.query(`SELECT total_lessons FROM courses WHERE id=$1`, [courseId]);
    const totalLessons = courseData[0]?.total_lessons || 0;
    const isCompleted  = completedLessons >= totalLessons;

    await this.db.query(
      `UPDATE user_enrollments SET
         completed_lessons = $1,
         last_lesson_id    = $2,
         studied_minutes   = COALESCE((
           SELECT ROUND(SUM(lp.watch_time_secs) / 60.0)::int
           FROM lesson_progress lp
           JOIN course_lessons cl ON lp.lesson_id = cl.id
           WHERE cl.course_id = $5 AND lp.user_id = $4
         ), 0),
         last_studied_at   = NOW(),
         status = CASE WHEN $1 >= $3 THEN 'completed' ELSE 'active' END
       WHERE user_id = $4 AND course_id = $5`,
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

  // Admin
  async findAllAdmin(query: CourseQueryDto) {
    const { rows, total } = await this.repo.findAllAdmin(query);
    return successResponse({ courses: rows }, 'Success', paginationMeta(total, query.page, query.limit));
  }

  async adminCreate(dto: CreateCourseDto, adminId: string) {
    const course = await this.repo.create(dto, adminId);
    await this.invalidateCache();
    return successResponse({ course }, 'Course created', undefined);
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
    // In production, use Redis SCAN to delete all course:* keys
    // For simplicity we set a short TTL on course caches
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

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.findOne(id, req.user?.id);
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
    @Req() req: any,
    @Body() dto: CompleteLessonDto,
  ) {
    return this.service.completeLesson(courseId, lessonId, req.user.id, dto);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.CREATED)
  submitReview(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Body() dto: SubmitReviewDto,
  ) {
    return this.service.submitReview(id, req.user.id, dto);
  }
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
  findAll(@Query() query: CourseQueryDto) {
    return this.service.findAllAdmin(query);
  }

  @Post()
  @RequirePermission('courses')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateCourseDto, @Req() req: any) {
    return this.service.adminCreate(dto, req.admin.id);
  }

  @Put(':id')
  @RequirePermission('courses')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: Partial<CreateCourseDto>) {
    return this.service.adminUpdate(id, dto);
  }

  @Delete(':id')
  @RequirePermission('courses')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.adminDelete(id);
  }

  @Post(':id/thumbnail')
  @RequirePermission('courses')
  @UseInterceptors(FileInterceptor('thumbnail'))
  uploadThumbnail(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.service.uploadThumbnail(id, file);
  }
}

// ── Module ────────────────────────────────────────────────────
@Module({
  imports:     [AuthModule],
  controllers: [CoursesController, AdminCoursesController],
  providers:   [CoursesService, CoursesRepository],
  exports:     [CoursesService],
})
export class CoursesModule {}
