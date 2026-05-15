import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Patch,
  Body, Param, Query, Req, UploadedFile,
  UseGuards, UseInterceptors, HttpCode, HttpStatus,
  ParseUUIDPipe, BadRequestException, Logger,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor }        from '@nestjs/platform-express';
import { InjectDataSource }       from '@nestjs/typeorm';
import { DataSource }             from 'typeorm';
import { CACHE_MANAGER }          from '@nestjs/cache-manager';
import { Cache }                  from 'cache-manager';
import { Inject }                 from '@nestjs/common';
import { ConfigService }          from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import * as AWS                   from '@aws-sdk/client-s3';
import { getSignedUrl }           from '@aws-sdk/s3-request-presigner';
import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthModule }             from '../auth/auth.module';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/study-materials/study-materials.module.ts
// Complete Study Materials module — upload, approval, download, bookmark
// ════════════════════════════════════════════════════════════

const TYPES = ['pdf', 'pyq', 'book', 'video'] as const;
type MaterialType = typeof TYPES[number];

// ── StudyMaterialsService ─────────────────────────────────────
@Injectable()
export class StudyMaterialsService {
  private readonly logger = new Logger(StudyMaterialsService.name);
  private readonly s3: AWS.S3Client;
  private readonly bucket: string;

  constructor(
    @InjectDataSource()           private readonly db: DataSource,
    @Inject(CACHE_MANAGER)        private readonly cache: Cache,
    private readonly config: ConfigService,
  ) {
    this.bucket = this.config.get('AWS_S3_BUCKET') ?? 'bpscnotes-materials';
    this.s3 = new AWS.S3Client({
      region:      this.config.get('AWS_REGION') ?? 'ap-south-1',
      credentials: {
        accessKeyId:     this.config.get('AWS_ACCESS_KEY_ID') ?? '',
        secretAccessKey: this.config.get('AWS_SECRET_ACCESS_KEY') ?? '',
      },
    });
  }

  // ── GET: presigned upload URL (called before file is chosen) ─
  async getUploadUrl(userId: string, fileName: string, mimeType: string) {
    const ext     = fileName.split('.').pop()?.toLowerCase() ?? 'pdf';
    const fileKey = `uploads/${userId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const command = new AWS.PutObjectCommand({
      Bucket:      this.bucket,
      Key:         fileKey,
      ContentType: mimeType,
    });
    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 900 }); // 15 min
    return successResponse({ uploadUrl, fileKey });
  }

  // ── POST: create material record AFTER file upload ───────────
  async createMaterial(userId: string, dto: {
    title: string; description?: string; subject: string;
    materialType: MaterialType; author?: string; tags?: string[];
    fileKey: string; fileSizeMb?: number; pageCount?: number;
  }) {
    if (!dto.title?.trim())    throw new BadRequestException('Title is required');
    if (!dto.subject?.trim())  throw new BadRequestException('Subject is required');
    if (!TYPES.includes(dto.materialType)) throw new BadRequestException('Invalid material type');
    if (!dto.fileKey?.trim())  throw new BadRequestException('fileKey is required');

    const result = await this.db.query(`
      INSERT INTO study_materials
        (title, description, subject, material_type, author, tags,
         file_key, file_size_bytes, page_count, uploader_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
      RETURNING id, title, status, created_at
    `, [
      dto.title.trim(),
      dto.description?.trim() ?? '',
      dto.subject.trim(),
      dto.materialType,
      dto.author?.trim() ?? '',
      dto.tags ?? [],
      dto.fileKey,
      Math.round((dto.fileSizeMb ?? 0) * 1024 * 1024),
      dto.pageCount ?? 0,
      userId,
    ]);
    return successResponse(result[0], '📤 Submitted for review! It will be published after admin approval.');
  }

  // ── GET: list approved materials (public) ────────────────────
  async listApproved(query: {
    type?: string; subject?: string; search?: string;
    page?: number; limit?: number; sort?: string;
    bookmarkedOnly?: boolean; userId?: string;
  }) {
    const page  = Math.max(1, +(query.page  ?? 1));
    const limit = Math.min(50, Math.max(1, +(query.limit ?? 20)));
    const offset = (page - 1) * limit;

    const conditions: string[] = [`sm.status = 'approved'`];
    const params: any[] = [];
    let pi = 1;

    if (query.type    && TYPES.includes(query.type as any)) { conditions.push(`sm.material_type = $${pi++}`); params.push(query.type); }
    if (query.subject && query.subject !== 'All')           { conditions.push(`sm.subject = $${pi++}`);       params.push(query.subject); }
    if (query.search?.trim()) {
      conditions.push(`(sm.title ILIKE $${pi} OR $${pi} = ANY(sm.tags) OR sm.subject ILIKE $${pi})`);
      params.push(`%${query.search.trim()}%`); pi++;
    }
    if (query.bookmarkedOnly && query.userId) {
      conditions.push(`EXISTS (SELECT 1 FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id=$${pi++})`);
      params.push(query.userId);
    }

    const orderMap: Record<string, string> = {
      newest:    'sm.approved_at DESC',
      downloads: 'sm.download_count DESC',
      rating:    '(CASE WHEN sm.rating_count>0 THEN sm.rating_sum/sm.rating_count ELSE 0 END) DESC',
    };
    const orderBy = orderMap[query.sort ?? ''] ?? 'sm.is_featured DESC, sm.download_count DESC';

    const where = conditions.join(' AND ');

    const [rows, count] = await Promise.all([
      this.db.query(`
        SELECT
          sm.id, sm.title, sm.description, sm.subject, sm.material_type AS "materialType",
          sm.author, sm.tags, sm.file_size_bytes AS "fileSizeBytes",
          sm.page_count AS "pageCount", sm.is_premium AS "isPremium",
          sm.is_featured AS "isFeatured", sm.is_trending AS "isTrending",
          sm.is_new AS "isNew", sm.download_count AS "downloadCount",
          sm.view_count AS "viewCount", sm.approved_at AS "uploadedDate",
          CASE WHEN sm.rating_count > 0 THEN ROUND(sm.rating_sum/sm.rating_count, 1) ELSE 0 END AS rating,
          u.name AS "uploaderName",
          ${query.userId ? `EXISTS (SELECT 1 FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id='${query.userId}')` : 'FALSE'} AS "isBookmarked"
        FROM study_materials sm
        LEFT JOIN users u ON u.id = sm.uploader_id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${pi} OFFSET $${pi+1}
      `, [...params, limit, offset]),
      this.db.query(`SELECT COUNT(*)::int FROM study_materials sm WHERE ${where}`, params),
    ]);

    return successResponse({
      materials: rows,
      meta:      paginationMeta(count[0].count, page, limit),
    });
  }

  // ── GET: single material with signed download URL ─────────────
  async getMaterial(id: string, userId?: string) {
    const rows = await this.db.query(`
      SELECT sm.*, u.name AS "uploaderName",
        ${userId ? `EXISTS (SELECT 1 FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id='${userId}')` : 'FALSE'} AS "isBookmarked"
      FROM study_materials sm LEFT JOIN users u ON u.id=sm.uploader_id
      WHERE sm.id=$1 AND sm.status='approved'
    `, [id]);
    if (!rows.length) throw new NotFoundException('Material not found');

    const m = rows[0];
    // increment view count
    await this.db.query(`UPDATE study_materials SET view_count=view_count+1 WHERE id=$1`, [id]);

    // generate signed URL valid 1 hour
    let downloadUrl = m.file_url;
    if (m.file_key) {
      const cmd = new AWS.GetObjectCommand({ Bucket: this.bucket, Key: m.file_key });
      downloadUrl = await getSignedUrl(this.s3, cmd, { expiresIn: 3600 });
    }

    return successResponse({ ...m, downloadUrl });
  }

  // ── POST: record download + increment count ───────────────────
  async recordDownload(materialId: string, userId: string) {
    await Promise.all([
      this.db.query(`UPDATE study_materials SET download_count=download_count+1 WHERE id=$1`, [materialId]),
      this.db.query(`INSERT INTO material_downloads (user_id, material_id) VALUES ($1,$2)`, [userId, materialId]),
    ]);
    // re-generate signed URL
    const rows = await this.db.query(`SELECT file_key FROM study_materials WHERE id=$1`, [materialId]);
    if (!rows.length) throw new NotFoundException('Material not found');
    const fileKey = rows[0].file_key;
    let downloadUrl = '';
    if (fileKey) {
      const cmd = new AWS.GetObjectCommand({ Bucket: this.bucket, Key: fileKey });
      downloadUrl = await getSignedUrl(this.s3, cmd, { expiresIn: 3600 });
    }
    return successResponse({ downloadUrl }, 'Download started');
  }

  // ── POST/DELETE: bookmark ─────────────────────────────────────
  async toggleBookmark(materialId: string, userId: string) {
    const exists = await this.db.query(
      `SELECT 1 FROM material_bookmarks WHERE user_id=$1 AND material_id=$2`, [userId, materialId]
    );
    if (exists.length) {
      await this.db.query(`DELETE FROM material_bookmarks WHERE user_id=$1 AND material_id=$2`, [userId, materialId]);
      return successResponse({ bookmarked: false }, 'Removed from saved');
    } else {
      await this.db.query(`INSERT INTO material_bookmarks (user_id, material_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, materialId]);
      return successResponse({ bookmarked: true }, '🔖 Saved to bookmarks');
    }
  }

  // ── GET: user's own uploads ───────────────────────────────────
  async myUploads(userId: string) {
    const rows = await this.db.query(`
      SELECT id, title, subject, material_type AS "materialType", status,
             rejection_reason AS "rejectionReason", download_count AS "downloadCount",
             created_at AS "createdAt"
      FROM study_materials WHERE uploader_id=$1 ORDER BY created_at DESC LIMIT 50
    `, [userId]);
    return successResponse({ uploads: rows });
  }

  // ── GET: subjects list ────────────────────────────────────────
  async getSubjects() {
    const rows = await this.db.query(`
      SELECT DISTINCT subject FROM study_materials WHERE status='approved' ORDER BY subject
    `);
    return successResponse({ subjects: ['All', ...rows.map((r: any) => r.subject)] });
  }

  // ── GET: stats for header ─────────────────────────────────────
  async getStats() {
    const [stats] = await this.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='approved')::int              AS total,
        COUNT(*) FILTER (WHERE status='approved' AND material_type='pdf')::int  AS pdfs,
        COUNT(*) FILTER (WHERE status='approved' AND material_type='pyq')::int  AS pyqs,
        COUNT(*) FILTER (WHERE status='approved' AND material_type='book')::int AS books,
        SUM(download_count) FILTER (WHERE status='approved')::int   AS totalDownloads
      FROM study_materials
    `);
    return successResponse(stats);
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN METHODS
  // ════════════════════════════════════════════════════════════

  async adminList(query: { status?: string; page?: number; limit?: number }) {
    const page  = Math.max(1, +(query.page  ?? 1));
    const limit = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;
    const status = query.status ?? 'pending';

    const [rows, count] = await Promise.all([
      this.db.query(`
        SELECT sm.id, sm.title, sm.subject, sm.material_type AS "materialType",
               sm.status, sm.file_size_bytes AS "fileSizeBytes",
               sm.download_count AS "downloadCount", sm.is_featured AS "isFeatured",
               sm.created_at AS "createdAt", sm.approved_at AS "approvedAt",
               u.name AS "uploaderName", u.mobile AS "uploaderMobile",
               sm.file_key AS "fileKey"
        FROM study_materials sm LEFT JOIN users u ON u.id=sm.uploader_id
        WHERE sm.status=$1 ORDER BY sm.created_at DESC LIMIT $2 OFFSET $3
      `, [status, limit, offset]),
      this.db.query(`SELECT COUNT(*)::int FROM study_materials WHERE status=$1`, [status]),
    ]);
    return successResponse({ materials: rows, meta: paginationMeta(count[0].count, page, limit) });
  }

  async adminApprove(id: string, adminId: string) {
    await this.db.query(`
      UPDATE study_materials
      SET status='approved', approved_at=NOW(), approved_by=$2, rejection_reason=NULL
      WHERE id=$1
    `, [id, adminId]);
    return successResponse(null, '✅ Material approved and published');
  }

  async adminReject(id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Rejection reason required');
    await this.db.query(`
      UPDATE study_materials SET status='rejected', rejection_reason=$2 WHERE id=$1
    `, [id, reason.trim()]);
    return successResponse(null, 'Material rejected');
  }

  async adminToggleFeature(id: string) {
    const rows = await this.db.query(`SELECT is_featured FROM study_materials WHERE id=$1`, [id]);
    if (!rows.length) throw new NotFoundException('Not found');
    const newVal = !rows[0].is_featured;
    await this.db.query(`UPDATE study_materials SET is_featured=$2 WHERE id=$1`, [id, newVal]);
    return successResponse({ isFeatured: newVal });
  }

  async adminToggleTrending(id: string) {
    const rows = await this.db.query(`SELECT is_trending FROM study_materials WHERE id=$1`, [id]);
    if (!rows.length) throw new NotFoundException('Not found');
    const newVal = !rows[0].is_trending;
    await this.db.query(`UPDATE study_materials SET is_trending=$2 WHERE id=$1`, [id, newVal]);
    return successResponse({ isTrending: newVal });
  }

  async adminDelete(id: string) {
    const rows = await this.db.query(`SELECT file_key FROM study_materials WHERE id=$1`, [id]);
    if (rows.length && rows[0].file_key) {
      // delete from S3
      try { await this.s3.send(new AWS.DeleteObjectCommand({ Bucket: this.bucket, Key: rows[0].file_key })); } catch {}
    }
    await this.db.query(`DELETE FROM study_materials WHERE id=$1`, [id]);
    return successResponse(null, 'Deleted');
  }

  async adminGetSignedUrl(id: string) {
    const rows = await this.db.query(`SELECT file_key FROM study_materials WHERE id=$1`, [id]);
    if (!rows.length || !rows[0].file_key) throw new NotFoundException('File not found');
    const cmd = new AWS.GetObjectCommand({ Bucket: this.bucket, Key: rows[0].file_key });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 3600 });
    return successResponse({ url });
  }

  async adminStats() {
    const [stats] = await this.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')::int  AS pending,
        COUNT(*) FILTER (WHERE status='approved')::int AS approved,
        COUNT(*) FILTER (WHERE status='rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE is_featured)::int       AS featured,
        SUM(download_count)::int                       AS totalDownloads,
        COUNT(DISTINCT uploader_id)::int               AS contributors
      FROM study_materials
    `);
    return successResponse(stats);
  }
}

// ════════════════════════════════════════════════════════════
// USER CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Study Materials')
@ApiBearerAuth()
@Controller('study-materials')
export class StudyMaterialsController {
  constructor(private readonly svc: StudyMaterialsService) {}

  /** GET /study-materials/stats */
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  getStats() { return this.svc.getStats(); }

  /** GET /study-materials/subjects */
  @Get('subjects')
  @Public()
  getSubjects() { return this.svc.getSubjects(); }

  /** GET /study-materials?type=pdf&subject=Polity&search=...&page=1 */
  @Get()
  @UseGuards(JwtAuthGuard)
  list(@Query() q: any, @Req() r: any) {
    return this.svc.listApproved({ ...q, userId: r.user?.id });
  }

  /** GET /study-materials/my-uploads */
  @Get('my-uploads')
  @UseGuards(JwtAuthGuard)
  myUploads(@Req() r: any) { return this.svc.myUploads(r.user.id); }

  /** GET /study-materials/upload-url?fileName=...&mimeType=... */
  @Get('upload-url')
  @UseGuards(JwtAuthGuard)
  getUploadUrl(
    @Query('fileName') fileName: string,
    @Query('mimeType') mimeType: string,
    @Req() r: any
  ) {
    if (!fileName) throw new BadRequestException('fileName required');
    return this.svc.getUploadUrl(r.user.id, fileName, mimeType ?? 'application/pdf');
  }

  /** POST /study-materials — create record after S3 upload */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: any, @Req() r: any) {
    return this.svc.createMaterial(r.user.id, dto);
  }

  /** GET /study-materials/:id */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  getOne(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.getMaterial(id, r.user?.id);
  }

  /** POST /study-materials/:id/download */
  @Post(':id/download')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  download(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.recordDownload(id, r.user.id);
  }

  /** POST /study-materials/:id/bookmark */
  @Post(':id/bookmark')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  bookmark(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.toggleBookmark(id, r.user.id);
  }
}

// ════════════════════════════════════════════════════════════
// ADMIN CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Admin — Study Materials')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtGuard, PermissionGuard)
@Controller('admin/study-materials')
export class AdminStudyMaterialsController {
  constructor(private readonly svc: StudyMaterialsService) {}

  @Get('stats') adminStats() { return this.svc.adminStats(); }

  @Get()
  @RequirePermission('library')
  adminList(@Query() q: any) { return this.svc.adminList(q); }

  @Post(':id/approve')
  @RequirePermission('library')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.adminApprove(id, r.user?.id ?? 'admin');
  }

  @Post(':id/reject')
  @RequirePermission('library')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: { reason: string }) {
    return this.svc.adminReject(id, dto.reason);
  }

  @Post(':id/toggle-featured')
  @RequirePermission('library')
  @HttpCode(HttpStatus.OK)
  toggleFeatured(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminToggleFeature(id);
  }

  @Post(':id/toggle-trending')
  @RequirePermission('library')
  @HttpCode(HttpStatus.OK)
  toggleTrending(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminToggleTrending(id);
  }

  @Delete(':id')
  @RequirePermission('library')
  @HttpCode(HttpStatus.OK)
  delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminDelete(id);
  }

  @Get(':id/signed-url')
  @RequirePermission('library')
  signedUrl(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminGetSignedUrl(id);
  }
}

// ════════════════════════════════════════════════════════════
// MODULE
// ════════════════════════════════════════════════════════════
@Module({
  imports: [AuthModule],
  controllers: [StudyMaterialsController, AdminStudyMaterialsController],
  providers: [StudyMaterialsService],
  exports: [StudyMaterialsService],
})
export class StudyMaterialsModule {}
