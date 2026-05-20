import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Patch,
  Body, Param, Query, Req, Res, UploadedFile,
  UseGuards, UseInterceptors, HttpCode, HttpStatus,
  ParseUUIDPipe, BadRequestException, Logger,
  NotFoundException, StreamableFile,
} from '@nestjs/common';
import { FileInterceptor }        from '@nestjs/platform-express';
import { InjectDataSource }       from '@nestjs/typeorm';
import { DataSource }             from 'typeorm';
import { CACHE_MANAGER }          from '@nestjs/cache-manager';
import { Cache }                  from 'cache-manager';
import { Inject }                 from '@nestjs/common';
import { ConfigService }          from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { diskStorage }            from 'multer';
import { extname, join }          from 'path';
import * as fs                    from 'fs';
import * as crypto                from 'crypto';
import { Response }               from 'express';
import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthModule }             from '../auth/auth.module';

// ════════════════════════════════════════════════════════════
// LOCAL STORAGE — No AWS required
//
// Files are stored at: /var/www/bpscnotes/uploads/  (configurable via UPLOAD_DIR)
// Served at:           https://api.bpscnotes.in/uploads/<file>
//
// Nginx config needed (add to your site config):
//   location /uploads/ {
//     alias /var/www/bpscnotes/uploads/;
//     add_header Content-Disposition "attachment";
//     expires 1y;
//   }
// ════════════════════════════════════════════════════════════

const TYPES = ['pdf', 'pyq', 'book', 'video', 'notes', 'image'] as const;
type MaterialType = typeof TYPES[number];

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// ─────────────────────────────────────────────────────────────
// Multer disk-storage config
// ─────────────────────────────────────────────────────────────
function buildMulterStorage(uploadDir: string) {
  // Create nested directory: /uploads/materials/<year>/<month>/
  const now   = new Date();
  const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dest   = join(uploadDir, 'materials', subDir);
  fs.mkdirSync(dest, { recursive: true });

  return diskStorage({
    destination: (_req, _file, cb) => cb(null, dest),
    filename: (_req, file, cb) => {
      const uniqueId   = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const safeExt    = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
      const safeName   = `${Date.now()}_${uniqueId}${safeExt}`;
      cb(null, safeName);
    },
  });
}

// ─────────────────────────────────────────────────────────────
// StudyMaterialsService
// ─────────────────────────────────────────────────────────────
@Injectable()
export class StudyMaterialsService {
  private readonly logger    = new Logger(StudyMaterialsService.name);
  private readonly uploadDir: string;
  private readonly baseUrl:   string;

  constructor(
    @InjectDataSource()    private readonly db:     DataSource,
    @Inject(CACHE_MANAGER) private readonly cache:  Cache,
    private readonly config: ConfigService,
  ) {
    // UPLOAD_DIR defaults to <project-root>/uploads — change in .env for production
    this.uploadDir = './uploads';

    // BASE_URL for building file URLs returned to clients
    this.baseUrl = this.config.get<string>('BASE_URL')
      ?? 'https://api.bpscnotes.in';

    // Ensure upload directory exists on startup
    try {
      fs.mkdirSync(join(this.uploadDir, 'materials'), { recursive: true });
    } catch (e) {
      this.logger.error('Upload directory creation failed', e);
    }
    this.logger.log(`📁 File storage: ${this.uploadDir}`);
  }

  // ── Build public URL for a stored file key ────────────────
  private fileUrl(fileKey: string): string {
    return `${this.baseUrl}/uploads/${fileKey}`;
  }

  // ── Extract subpath from absolute path ───────────────────
  private toFileKey(absolutePath: string): string {
    return absolutePath.replace(this.uploadDir + '/', '').replace(/\\/g, '/');
  }

  // ── GET: list approved materials ──────────────────────────
  async listApproved(query: {
    type?: string; subject?: string; search?: string;
    page?: number; limit?: number; sort?: string;
    bookmarkedOnly?: boolean | String; userId?: string;
  }) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(50, Math.max(1, +(query.limit ?? 20)));
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
    // FIX: bookmarkedOnly comes from query string as "false"/"true" (string, not boolean)
    // In JS: "false" is TRUTHY → the old code always applied bookmark filter → empty results
    const wantsBookmarks = query.bookmarkedOnly === true || query.bookmarkedOnly === 'true';
    if (wantsBookmarks && query.userId) {
      conditions.push(`EXISTS (SELECT 1 FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id=$${pi++})`);
      params.push(query.userId);
    }

    const sortMap: Record<string, string> = {
      newest:    'sm.created_at DESC',
      downloads: 'sm.download_count DESC',
    };
    const orderBy = sortMap[query.sort ?? 'downloads'] ?? sortMap.downloads;

    const bookmarkSubq = query.userId
      ? `(SELECT TRUE FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id='${query.userId}') AS is_bookmarked,`
      : `FALSE AS is_bookmarked,`;

    const where   = conditions.join(' AND ');
    const [rows, [countRow]] = await Promise.all([
      this.db.query(
        `SELECT sm.id, sm.title, sm.description, sm.subject, sm.material_type,
                sm.author, sm.tags, sm.file_key, sm.file_size_bytes, sm.page_count,
                sm.download_count, sm.is_featured, sm.is_trending,
                sm.created_at, sm.uploader_id,
                ${bookmarkSubq}
                sm.status
         FROM study_materials sm WHERE ${where}
         ORDER BY ${orderBy} LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM study_materials sm WHERE ${where}`, params),
    ]);

    // Attach public URLs
    const materials = rows.map((m: any) => ({
      ...m,
      fileUrl:      m.file_key       ? this.fileUrl(m.file_key)       : null,
      // thumbnailUrl: m.thumbnail_key  ? this.fileUrl(m.thumbnail_key)  : null,
      fileSizeMb:   m.file_size_bytes ? +(m.file_size_bytes / 1024 / 1024).toFixed(2) : 0,
    }));

    const total = parseInt(countRow.count ?? '0', 10);
    return successResponse({ materials, meta: paginationMeta(total, page, limit) });
  }

  // ── GET: stats ────────────────────────────────────────────
  async getStats(userId?: string) {
    const [stats] = await this.db.query(`
      SELECT
        COUNT(*)                                          FILTER (WHERE status='approved')::int AS total,
        COUNT(DISTINCT subject)                           FILTER (WHERE status='approved')::int AS subjects,
        COUNT(*)                                          FILTER (WHERE material_type='pdf')::int AS pdfs,
        COUNT(*)                                          FILTER (WHERE material_type='pyq')::int AS pyqs,
        COALESCE(SUM(download_count),0)::int                                                    AS totalDownloads,
        COUNT(DISTINCT uploader_id)                                                             AS contributors,
        COUNT(*)                                          FILTER (WHERE is_featured)::int       AS featured
      FROM study_materials WHERE status='approved'
    `);

    const myUploadsCount = userId ? (await this.db.query(
      `SELECT COUNT(*) FROM study_materials WHERE uploader_id=$1`, [userId]
    ))[0].count : '0';

    return successResponse({
      ...stats,
      myUploads: parseInt(myUploadsCount, 10),
    });
  }

  // ── GET: distinct subjects ────────────────────────────────
  async getSubjects() {
    const rows = await this.db.query(
      `SELECT DISTINCT subject FROM study_materials WHERE status='approved' ORDER BY subject`
    );
    return successResponse({ subjects: ['All', ...rows.map((r: any) => r.subject)] });
  }

  // ── GET: single material detail ───────────────────────────
  async getMaterial(id: string, userId?: string) {
    const [row] = await this.db.query(`
      SELECT sm.*,
             u.name AS uploader_name,
             (SELECT TRUE FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id=$2) AS is_bookmarked
      FROM study_materials sm
      LEFT JOIN users u ON u.id = sm.uploader_id
      WHERE sm.id = $1 AND sm.status = 'approved'
    `, [id, userId ?? '00000000-0000-0000-0000-000000000000']);
    if (!row) throw new NotFoundException('Material not found');
    return successResponse({
      ...row,
      fileUrl:      row.file_key      ? this.fileUrl(row.file_key)      : null,
      thumbnailUrl: row.thumbnail_key ? this.fileUrl(row.thumbnail_key) : null,
    });
  }

  // ── POST: direct multipart upload (replaces presigned URL flow) ──
  // Android now POSTs directly to this endpoint — no AWS needed.
  async uploadFile(
    userId: string,
    file:   Express.Multer.File,
    dto:    {
      title: string; description?: string; subject: string;
      materialType: MaterialType; author?: string; tags?: string;
      pageCount?: number;
    }
  ) {
    if (!file) throw new BadRequestException('File is required');
    if (!dto.title?.trim())   throw new BadRequestException('Title is required');
    if (!dto.subject?.trim()) throw new BadRequestException('Subject is required');

    const matType = (dto.materialType ?? 'pdf') as MaterialType;
    if (!TYPES.includes(matType)) throw new BadRequestException(`Invalid type. Allowed: ${TYPES.join(', ')}`);

    const fileKey     = this.toFileKey(file.path);
    const fileSizeBytes = file.size;
    const tags        = dto.tags ? JSON.parse(dto.tags) : [];

    const [result] = await this.db.query(`
      INSERT INTO study_materials
        (title, description, subject, material_type, author, tags,
         file_key, file_size_bytes, page_count, uploader_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
      RETURNING id, title, status, created_at
    `, [
      dto.title.trim(),
      dto.description?.trim() ?? '',
      dto.subject.trim(),
      matType,
      dto.author?.trim() ?? '',
      tags,
      fileKey,
      fileSizeBytes,
      dto.pageCount ?? 0,
      userId,
    ]);

    this.logger.log(`📤 Material uploaded: ${result.id} by user ${userId} — file: ${fileKey}`);
    return successResponse({
      id:       result.id,
      title:    result.title,
      status:   result.status,
      fileUrl:  this.fileUrl(fileKey),
      fileKey,
    }, '📤 Uploaded! Will be published after admin review.');
  }

  // ── GET: presigned-compatible URL for legacy clients ──────
  // Returns a token-based upload URL so old Android clients that
  // use the two-step flow still work without changes.
  async getUploadUrl(userId: string, fileName: string, mimeType: string) {
    // Generate a one-time upload token valid for 15 minutes
    const token   = crypto.randomUUID();
    const ext     = extname(fileName).toLowerCase() || '.pdf';
    const fileKey = `pending/${userId}/${Date.now()}${ext}`;
    // Store token in cache so the confirm step can verify it
    await this.cache.set(`upload_token:${token}`, { userId, fileKey, mimeType }, 900);
    // Return same shape as S3 presigned URL response — Android code unchanged
    const uploadUrl = `${this.baseUrl}/api/v1/study-materials/upload-local?token=${token}`;
    return successResponse({ uploadUrl, fileKey, token });
  }

  // ── PUT: receive file for the legacy two-step flow ────────
  async receiveLocalUpload(token: string, file: Express.Multer.File) {
    const meta = await this.cache.get<{ userId: string; fileKey: string; mimeType: string }>(`upload_token:${token}`);
    if (!meta) throw new BadRequestException('Upload token expired or invalid');
    await this.cache.del(`upload_token:${token}`);
    // Move file to the correct path
    const destDir = join(this.uploadDir, 'materials');
    fs.mkdirSync(destDir, { recursive: true });
    const ext     = extname(file.originalname).toLowerCase() || '.pdf';
    const finalKey = `materials/${meta.userId}/${Date.now()}${ext}`;
    const dest    = join(this.uploadDir, finalKey);
    fs.renameSync(file.path, dest);
    return successResponse({ fileKey: finalKey, fileUrl: this.fileUrl(finalKey) });
  }

  // ── POST: record download and return file URL ─────────────
  async recordDownload(id: string, userId: string) {
    const [row] = await this.db.query(
      `UPDATE study_materials SET download_count=download_count+1 WHERE id=$1 AND status='approved' RETURNING file_key, title`,
      [id]
    );
    if (!row) throw new NotFoundException('Material not found');
    return successResponse({ downloadUrl: this.fileUrl(row.file_key), title: row.title });
  }

  // ── POST: toggle bookmark ─────────────────────────────────
  async toggleBookmark(materialId: string, userId: string) {
    const exists = await this.db.query(
      `SELECT 1 FROM material_bookmarks WHERE material_id=$1 AND user_id=$2`,
      [materialId, userId]
    );
  
    if (exists.length) {
      await this.db.query(
        `DELETE FROM material_bookmarks WHERE material_id=$1 AND user_id=$2`,
        [materialId, userId]
      );
  
      return successResponse({ bookmarked: false });
    } else {
      await this.db.query(
        `INSERT INTO material_bookmarks (material_id, user_id)
         VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [materialId, userId]
      );
  
      return successResponse({ bookmarked: true });
    }
  }

  // ── GET: my uploads ───────────────────────────────────────
  async myUploads(userId: string) {
    const uploads = await this.db.query(
      `SELECT id, title, subject, material_type, status, download_count, rating, created_at, file_key
       FROM study_materials WHERE uploader_id=$1 ORDER BY created_at DESC`,
      [userId]
    );
    return successResponse({
      uploads: uploads.map((u: any) => ({ ...u, fileUrl: u.file_key ? this.fileUrl(u.file_key) : null }))
    });
  }

  // ── Admin methods ─────────────────────────────────────────
  async adminList(query: any) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let pi = 1;
    if (query.status)  { conditions.push(`sm.status=$${pi++}`);      params.push(query.status); }
    if (query.subject) { conditions.push(`sm.subject=$${pi++}`);      params.push(query.subject); }
    if (query.search)  { conditions.push(`sm.title ILIKE $${pi++}`);  params.push(`%${query.search}%`); }
    const where = conditions.join(' AND ');
    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT sm.*, u.name AS uploader_name FROM study_materials sm LEFT JOIN users u ON u.id=sm.uploader_id
         WHERE ${where} ORDER BY sm.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM study_materials sm WHERE ${where}`, params),
    ]);
    return successResponse({
      materials: rows.map((m: any) => ({ ...m, fileUrl: m.file_key ? this.fileUrl(m.file_key) : null })),
      meta: paginationMeta(parseInt(cnt.count, 10), page, limit),
    });
  }

  async adminApprove(id: string) {
    await this.db.query(`UPDATE study_materials SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
    return successResponse(null, '✅ Approved — now visible to students');
  }

  async adminReject(id: string, reason?: string) {
    await this.db.query(`UPDATE study_materials SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    return successResponse(null, `Rejected${reason ? ': ' + reason : ''}`);
  }

  async adminToggleFeature(id: string) {
    const [row] = await this.db.query(`SELECT is_featured FROM study_materials WHERE id=$1`, [id]);
    if (!row) throw new NotFoundException();
    await this.db.query(`UPDATE study_materials SET is_featured=$2 WHERE id=$1`, [id, !row.is_featured]);
    return successResponse({ isFeatured: !row.is_featured });
  }

  async adminDelete(id: string) {
    const [row] = await this.db.query(`SELECT file_key FROM study_materials WHERE id=$1`, [id]);
    if (row?.file_key) {
      const absPath = join(this.uploadDir, row.file_key);
      try { fs.unlinkSync(absPath); } catch (_) { /* file may not exist */ }
    }
    await this.db.query(`DELETE FROM study_materials WHERE id=$1`, [id]);
    return successResponse(null, 'Deleted');
  }

  async adminGetUrl(id: string) {
    const [row] = await this.db.query(`SELECT file_key FROM study_materials WHERE id=$1`, [id]);
    if (!row?.file_key) throw new NotFoundException('File not found');
    return successResponse({ url: this.fileUrl(row.file_key) });
  }

  async adminStats() {
    const [stats] = await this.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')::int  AS pending,
        COUNT(*) FILTER (WHERE status='approved')::int AS approved,
        COUNT(*) FILTER (WHERE status='rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE is_featured)::int       AS featured,
        COALESCE(SUM(download_count),0)::int           AS totalDownloads,
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
@UseGuards(JwtAuthGuard)
@Controller('study-materials')
export class StudyMaterialsController {
  constructor(private readonly svc: StudyMaterialsService, private readonly config: ConfigService) {}

  @Get('stats')
  getStats(@Req() r: any) { return this.svc.getStats(r.user?.id); }

  @Get('subjects')
  getSubjects() { return this.svc.getSubjects(); }

  @Get()
  list(@Query() q: any, @Req() r: any) {
    return this.svc.listApproved({ ...q, userId: r.user?.id });
  }

  @Get('my-uploads')
  myUploads(@Req() r: any) { return this.svc.myUploads(r.user.id); }

  // ── LEGACY: get pre-signed-style upload URL (token-based) ──
  @Get('upload-url')
  getUploadUrl(
    @Query('fileName') fileName: string,
    @Query('mimeType') mimeType: string,
    @Req() r: any,
  ) {
    return this.svc.getUploadUrl(r.user.id, fileName, mimeType ?? 'application/pdf');
  }

  // ── LEGACY: receive file after two-step token flow ─────────
  @Put('upload-local')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: join(process.cwd(), 'uploads', 'temp'),
      filename: (_req, file, cb) => cb(null, `${Date.now()}_${crypto.randomUUID()}${extname(file.originalname)}`),
    }),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
  }))
  receiveLocalUpload(@Query('token') token: string, @UploadedFile() file: Express.Multer.File) {
    return this.svc.receiveLocalUpload(token, file);
  }

  // ── NEW: single-step direct multipart upload ───────────────
  // Android sends: POST /study-materials/upload  (multipart/form-data)
  // Fields: file (binary), title, subject, materialType, description, author, tags (JSON), pageCount
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const uploadDir = './uploads';
      
        const now = new Date();
      
        const subDir = join(
          uploadDir,
          'materials',
          `${now.getFullYear()}`,
          String(now.getMonth() + 1).padStart(2, '0')
        );
      
        try {
          fs.mkdirSync(subDir, { recursive: true });
          cb(null, subDir);
        } catch (e) {
          console.error('Upload dir creation failed:', e);
          cb(e as Error, subDir);
        }
      },
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase() || '.pdf';
        cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
      },
    }),
    limits:   { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new BadRequestException(`File type not allowed. Allowed: PDF, images, Word docs`), false);
    },
  }))
  uploadMaterial(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Req() r: any,
  ) {
    return this.svc.uploadFile(r.user.id, file, body);
  }

  // ── POST: create record AFTER legacy S3/token upload ──────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createMaterial(@Body() dto: any, @Req() r: any) {
    return this.svc.uploadFile(r.user.id, null as any, dto);
  }

  @Get(':id')
  getMaterial(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.getMaterial(id, r.user?.id);
  }

  @Post(':id/download')
  @HttpCode(HttpStatus.OK)
  recordDownload(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.recordDownload(id, r.user.id);
  }

  @Post(':id/bookmark')
  @HttpCode(HttpStatus.OK)
  toggleBookmark(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
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

  @Get('stats')
  @RequirePermission('study-materials')
  adminStats() { return this.svc.adminStats(); }

  @Get()
  @RequirePermission('study-materials')
  adminList(@Query() q: any) { return this.svc.adminList(q); }

  @Patch(':id/approve')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminApprove(id); }

  @Patch(':id/reject')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() b: any) { return this.svc.adminReject(id, b.reason); }

  @Patch(':id/feature')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  toggleFeature(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminToggleFeature(id); }

  @Delete(':id')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  adminDelete(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminDelete(id); }

  @Get(':id/url')
  @RequirePermission('study-materials')
  getUrl(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminGetUrl(id); }
}

// ════════════════════════════════════════════════════════════
// MODULE
// ════════════════════════════════════════════════════════════
@Module({
  imports:     [AuthModule],
  controllers: [StudyMaterialsController, AdminStudyMaterialsController],
  providers:   [StudyMaterialsService],
  exports:     [StudyMaterialsService],
})
export class StudyMaterialsModule {}