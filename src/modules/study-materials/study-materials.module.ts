import * as CashfreeUtil from '../../common/utils/cashfree.util';
import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Patch,
  Body, Param, Query, Req, Res, UploadedFile,
  UseGuards, UseInterceptors, HttpCode, HttpStatus,
  ParseUUIDPipe, BadRequestException, Logger,
  NotFoundException, StreamableFile, HttpException,
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
import * as admin                 from 'firebase-admin';
import { ensureFirebaseAdmin }    from '../../common/firebase/firebase-admin';
import { Response }               from 'express';
import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { ActivityLogService, ACTIONS } from '../../common/activity/activity-log.service';
import { successResponse, paginationMeta } from '../../common/utils/response.util';
import { AuthModule }             from '../auth/auth.module';
import { CoinsModule, CoinsService } from '../coins/coins.module';

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
    private readonly coinsService: CoinsService,

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
    return `${this.baseUrl}/${fileKey}`;
  }

  // ── Extract subpath from absolute path ───────────────────
  private toFileKey(absolutePath: string): string {
    return absolutePath.replace(this.uploadDir + '/', '').replace(/\\/g, '/');
  }

  // ── GET: all pinned/featured materials, unpaginated ────────
  // Used by the dedicated /pinned endpoint so the app's Pinned section
  // always shows every featured item, regardless of where it would
  // rank in the main downloads-sorted, 20-item-paginated list.
  async listPinned(userId?: string) {
    const bookmarkSubq = userId
      ? `(SELECT TRUE FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id='${userId}') AS is_bookmarked,`
      : `FALSE AS is_bookmarked,`;
    const purchaseSubq = userId
      ? `EXISTS (SELECT 1 FROM material_purchases mp WHERE mp.material_id=sm.id AND mp.user_id='${userId}') AS is_purchased,`
      : `FALSE AS is_purchased,`;

    const rows = await this.db.query(
      `SELECT sm.id, sm.title, sm.description, sm.subject, sm.material_type,
              sm.author, sm.tags, sm.file_key, sm.file_size_bytes, sm.page_count,
              sm.download_count, sm.is_featured, sm.is_trending,
              sm.created_at, sm.uploader_id, sm.thumbnail_key,
              COALESCE(sm.language, 'English') AS language,
              COALESCE(sm.price, 0)          AS price,
              COALESCE(sm.free_pages, 3)     AS free_pages,
              COALESCE(sm.is_premium, false) AS is_premium,
              ${bookmarkSubq}
              ${purchaseSubq}
              sm.status
       FROM study_materials sm
       WHERE sm.status='approved' AND sm.is_featured=TRUE
       ORDER BY sm.created_at DESC`
    );

    const materials = rows.map((m: any) => ({
      ...m,
      fileUrl: m.file_key ? this.fileUrl(m.file_key) : null,
    }));
    return successResponse({
      materials,
      meta: paginationMeta(materials.length, 1, Math.max(materials.length, 1)),
    });
  }

  // ── GET: list approved materials ──────────────────────────
  async listApproved(query: {
    type?: string; subject?: string; search?: string; language?: string;
    page?: number; limit?: number; sort?: string;
    bookmarkedOnly?: boolean | String; userId?: string;
  }) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(50, Math.max(1, +(query.limit ?? 20)));
    const offset = (page - 1) * limit;

    const conditions: string[] = [`sm.status = 'approved'`];
    // Note: own uploads ARE shown in explore so stats and list stay consistent.
    // Users can still see their uploads in My Uploads tab with full access.
    const params: any[] = [];
    let pi = 1;

    if (query.type    && TYPES.includes(query.type as any)) { conditions.push(`sm.material_type = $${pi++}`); params.push(query.type); }
    if (query.subject && query.subject !== 'All')           { conditions.push(`sm.subject = $${pi++}`);       params.push(query.subject); }
    if (query.language && query.language !== 'All')         { conditions.push(`COALESCE(sm.language,'English') = $${pi++}`); params.push(query.language); }
    if (query.search?.trim()) {
      conditions.push(`(sm.title ILIKE $${pi} OR $${pi} = ANY(sm.tags) OR sm.subject ILIKE $${pi})`);
      params.push(`%${query.search.trim()}%`); pi++;
    }
    // FIX: bookmarkedOnly arrives as string "false"/"true" from query params.
    // In JS, the string "false" is TRUTHY → always applied bookmark filter → empty list.
    const wantsBookmarks = query.bookmarkedOnly === true || query.bookmarkedOnly === 'true';
    if (wantsBookmarks && query.userId) {
      conditions.push(`EXISTS (SELECT 1 FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id=$${pi++})`);
      params.push(query.userId);
    }

    const sortMap: Record<string, string> = {
      newest:    'sm.created_at DESC',
      downloads: 'sm.download_count DESC',
      rating:    'sm.rating DESC',
    };
    const orderBy = sortMap[query.sort ?? 'downloads'] ?? sortMap.downloads;

    const bookmarkSubq = query.userId
      ? `(SELECT TRUE FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id='${query.userId}') AS is_bookmarked,`
      : `FALSE AS is_bookmarked,`;

    // FIX: Include is_purchased so Android knows if user already bought premium material
    // Without this, isPurchased is always false → Unlock button always shown → triggers download
    const purchaseSubq = query.userId
      ? `EXISTS (SELECT 1 FROM material_purchases mp WHERE mp.material_id=sm.id AND mp.user_id='${query.userId}') AS is_purchased,`
      : `FALSE AS is_purchased,`;

    // Buyer count — social proof badge ("12 students bought this")
    const buyerCountSubq = `(SELECT COUNT(*) FROM material_purchases mp WHERE mp.material_id=sm.id AND mp.price_paid > 0) AS buyer_count,`;

    const where   = conditions.join(' AND ');
    const [rows, [countRow]] = await Promise.all([
      this.db.query(
        `SELECT sm.id, sm.title, sm.description, sm.subject, sm.material_type,
                sm.author, sm.tags, sm.file_key, sm.file_size_bytes, sm.page_count,
                sm.download_count, sm.is_featured, sm.is_trending,
                sm.created_at, sm.uploader_id, sm.thumbnail_key,
                COALESCE(sm.language, 'English') AS language,
                -- Marketplace / locking fields (COALESCE guards missing columns)
                COALESCE(sm.price, 0)          AS price,
                COALESCE(sm.free_pages, 3)     AS free_pages,
                COALESCE(sm.is_premium, false) AS is_premium,
                ${bookmarkSubq}
                ${purchaseSubq}
                ${buyerCountSubq}
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
      thumbnailUrl: m.thumbnail_key  ? this.fileUrl(m.thumbnail_key)  : null,
      // FIX: file_size_bytes from Postgres is a string — must parseInt before math
      fileSizeMb:   m.file_size_bytes ? +(parseInt(m.file_size_bytes, 10) / 1024 / 1024).toFixed(2) : 0,
      price:      parseInt(m.price ?? '0', 10),
      free_pages: parseInt(m.free_pages ?? '3', 10),   // snake_case — matches Android @SerializedName("free_pages")
      is_premium: m.is_premium ?? false,               // snake_case — matches Android @SerializedName("is_premium")
      buyer_count: parseInt(m.buyer_count ?? '0', 10),
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

  // ── GET: subjects from master table (admin-controlled) ────
  // Previously: DISTINCT from study_materials rows — showed only subjects
  // that happened to have approved uploads, hardcoded in the seed.
  // Now: reads from the subjects master table so admin can add/enable/disable
  // subjects independently of whether any materials exist yet.
  async getSubjects() {
    const rows = await this.db.query(
      `SELECT name FROM subjects WHERE is_active = TRUE ORDER BY sort_order, name`
    );
    return successResponse({ subjects: ['All', ...rows.map((r: any) => r.name)] });
  }

  // ── GET: single material detail ───────────────────────────
  async getMaterial(id: string, userId?: string) {
    const [row] = await this.db.query(`
      SELECT sm.*,
             u.name AS uploader_name,
             (SELECT TRUE FROM material_bookmarks mb WHERE mb.material_id=sm.id AND mb.user_id=$2) AS is_bookmarked,
             (SELECT COUNT(*) FROM material_purchases mp WHERE mp.material_id=sm.id AND mp.price_paid > 0) AS buyer_count
      FROM study_materials sm
      LEFT JOIN users u ON u.id = sm.uploader_id
      WHERE sm.id = $1 AND sm.status = 'approved'
    `, [id, userId ?? '00000000-0000-0000-0000-000000000000']);
    if (!row) throw new NotFoundException('Material not found');
    return successResponse({
      ...row,
      fileUrl:      row.file_key      ? this.fileUrl(row.file_key)      : null,
      thumbnailUrl: row.thumbnail_key ? this.fileUrl(row.thumbnail_key) : null,
      buyer_count:  parseInt(row.buyer_count ?? '0', 10),
    });
  }

  // ── GET: anonymized buyer list for social proof ────────────
  // Returns up to `limit` buyer display names (first name + last
  // initial, e.g. "Rahul K.") plus the total buyer count, so the
  // detail screen can show "Rahul K. and 11 others bought this".
  async getBuyers(materialId: string, limit = 5) {
    const rows = await this.db.query(
      `SELECT u.name
       FROM material_purchases mp
       JOIN users u ON u.id = mp.user_id
       WHERE mp.material_id=$1 AND mp.price_paid > 0
       ORDER BY mp.created_at DESC
       LIMIT $2`,
      [materialId, limit]
    );
    const [countRow] = await this.db.query(
      `SELECT COUNT(*) FROM material_purchases WHERE material_id=$1 AND price_paid > 0`,
      [materialId]
    );

    // Anonymize: "Rahul Kumar" -> "Rahul K." ; single-word names kept as-is
    const anonymize = (fullName: string): string => {
      const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return 'A student';
      if (parts.length === 1) return parts[0];
      return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
    };

    return successResponse({
      buyers: rows.map((r: any) => anonymize(r.name)),
      totalBuyers: parseInt(countRow.count ?? '0', 10),
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
      isPremium?: string | boolean;   // "true"/"false" from multipart form
      freePages?: string | number;    // how many pages visible before paywall
      price?: string | number;        // coins required (0 = free)
      language?: string;              // e.g. "Hindi", "English", "Hindi + English"
    }
  ) {
    if (!file) throw new BadRequestException('File is required');
    if (!dto.title?.trim())   throw new BadRequestException('Title is required');
    if (!dto.subject?.trim()) throw new BadRequestException('Subject is required');

    const matType = (dto.materialType ?? 'pdf') as MaterialType;
    if (!TYPES.includes(matType)) throw new BadRequestException(`Invalid type. Allowed: ${TYPES.join(', ')}`);

    const fileKey       = this.toFileKey(file.path);
    const fileSizeBytes = file.size;
    const tags          = dto.tags ? JSON.parse(dto.tags) : [];

    // Parse marketplace fields from multipart (arrive as strings)
    const isPremium  = dto.isPremium  === true || dto.isPremium  === 'true';
    const freePages  = Math.max(1, parseInt(String(dto.freePages  ?? '3'), 10)  || 3);
    const price      = Math.max(0, parseInt(String(dto.price      ?? '0'), 10)  || 0);
    const language   = (dto.language?.trim()) || 'English';

    // Auto-count PDF pages from the uploaded file
    let pageCount = parseInt(String(dto.pageCount ?? '0'), 10) || 0;
    if (pageCount === 0 && matType === 'pdf') {
      try {
        const pdfBytes = fs.readFileSync(file.path);
        // Count pages by scanning for /Type /Page entries in the PDF byte stream
        // This is a lightweight approach that avoids heavy dependencies
        const pdfStr   = pdfBytes.toString('latin1');
        const matches  = pdfStr.match(/\/Type\s*\/Page[^s]/g);
        pageCount      = matches ? matches.length : 0;
        if (pageCount === 0) {
          // Fallback: count /Page objects differently
          const alt = pdfStr.match(/\/Count\s+(\d+)/g);
          if (alt && alt.length > 0) {
            const nums = alt.map(s => parseInt(s.replace(/\D/g, ''), 10)).filter(n => n > 0);
            pageCount  = nums.length > 0 ? Math.max(...nums) : 0;
          }
        }
       this.logger.log(`📄 PDF pages counted: ${pageCount} (file: ${fileKey})`);
      } catch (e) {
        this.logger.warn(`Could not count PDF pages: ${(e as Error).message}`);
            }
    }

    const [result] = await this.db.query(`
      INSERT INTO study_materials
        (title, description, subject, material_type, author, tags,
         file_key, file_size_bytes, page_count, uploader_id, status,
         is_premium, free_pages, price, language)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14)
      RETURNING id, title, status, created_at, page_count
    `, [
      dto.title.trim(),
      dto.description?.trim() ?? '',
      dto.subject.trim(),
      matType,
      dto.author?.trim() ?? '',
      tags,
      fileKey,
      fileSizeBytes,
      pageCount,
      userId,
      isPremium,
      freePages,
      price,
      language,
    ]);

    this.logger.log(`📤 Material uploaded: ${result.id} by user ${userId} — file: ${fileKey} — pages: ${pageCount}`);
    return successResponse({
      id:        result.id,
      title:     result.title,
      status:    result.status,
      fileUrl:   this.fileUrl(fileKey),
      fileKey,
      pageCount: result.page_count ?? pageCount,
      isPremium,
      freePages,
      price,
      language,
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
    // FIX: SELECT file_key first (avoids RETURNING column-mapping issues with TypeORM raw queries)
    // then UPDATE download_count separately — reliable on all pg driver versions
    const [mat] = await this.db.query(
      `SELECT id, title, file_key FROM study_materials WHERE id = $1 AND status = 'approved'`,
      [id]
    );
    if (!mat) throw new NotFoundException('Material not found or not published');

    // file_key may be stored under either name depending on ORM/driver config
    const fileKey: string | null = mat.file_key ?? mat.fileKey ?? mat['file_key'] ?? null;
    if (!fileKey || fileKey.trim() === '') {
      throw new NotFoundException('No file attached to this material yet. Contact the uploader.');
    }

    // Increment download count
    await this.db.query(
      `UPDATE study_materials SET download_count = download_count + 1 WHERE id = $1`,
      [id]
    );

    // Record in history (creates table if needed)
    await this.recordDownloadHistory(id, userId);

    return successResponse({ downloadUrl: this.fileUrl(fileKey), title: mat.title });
  }

  // ── POST: toggle bookmark ─────────────────────────────────
  async toggleBookmark(materialId: string, userId: string) {
    const exists = await this.db.query(
      `SELECT material_id FROM material_bookmarks WHERE material_id=$1 AND user_id=$2`, [materialId, userId]
    );
    if (exists.length) {
      await this.db.query(`DELETE FROM material_bookmarks WHERE material_id=$1 AND user_id=$2`, [materialId, userId]);
      return successResponse({ bookmarked: false });
    } else {
      await this.db.query(`INSERT INTO material_bookmarks (material_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [materialId, userId]);
      return successResponse({ bookmarked: true });
    }
  }

  // ── GET: my uploads ───────────────────────────────────────
  async myUploads(userId: string) {
    const uploads = await this.db.query(
      `SELECT id, title, subject, material_type, status, rejection_reason, download_count, created_at, file_key,
              price, negotiation_round, current_offer_price, proposed_by, negotiation_status
       FROM study_materials WHERE uploader_id=$1 ORDER BY created_at DESC`,
      [userId]
    );
    return successResponse({
      uploads: uploads.map((u: any) => ({ ...u, fileUrl: u.file_key ? this.fileUrl(u.file_key) : null }))
    });
  }

  // ── GET: negotiation history for one material ─────────────
  // Used by uploader to see the full back-and-forth before
  // deciding to accept or counter.
  async getNegotiationHistory(materialId: string, userId: string) {
    const [mat] = await this.db.query(
      `SELECT id, uploader_id, status, price, negotiation_round, current_offer_price,
              proposed_by, negotiation_status, title
       FROM study_materials WHERE id=$1`,
      [materialId]
    );
    if (!mat) throw new NotFoundException('Material not found');
    if (mat.uploader_id !== userId) throw new BadRequestException('Not your material');

    const history = await this.db.query(
      `SELECT round, offered_by, offer_price, message, action, created_at
       FROM material_negotiations WHERE material_id=$1 ORDER BY round ASC, created_at ASC`,
      [materialId]
    );

    return successResponse({
      materialId:        mat.id,
      title:             mat.title,
      status:            mat.status,
      originalPrice:     mat.price,
      negotiationRound:  mat.negotiation_round,
      currentOfferPrice: mat.current_offer_price,
      proposedBy:        mat.proposed_by,
      negotiationStatus: mat.negotiation_status,
      canRespond:        mat.negotiation_status === 'awaiting_user',
      isFinalRound:      mat.negotiation_round >= 3,
      history,
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
if (query.subject) { conditions.push(`sm.subject=$${pi++}`);     params.push(query.subject); }
if (query.search)  { conditions.push(`(sm.title ILIKE $${pi} OR sm.subject ILIKE $${pi} OR u.name ILIKE $${pi})`); params.push(`%${query.search}%`); pi++; }
    const where = conditions.join(' AND ');
    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT sm.*, sm.is_featured AS "isFeatured", sm.is_trending AS "isTrending",
                sm.is_premium AS "isPremium", u.name AS uploader_name,
                (SELECT mn.message FROM material_negotiations mn
                 WHERE mn.material_id = sm.id AND mn.offered_by = 'user' AND mn.message IS NOT NULL
                 ORDER BY mn.created_at DESC LIMIT 1) AS student_negotiation_message
         FROM study_materials sm LEFT JOIN users u ON u.id=sm.uploader_id
         WHERE ${where} ORDER BY sm.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM study_materials sm LEFT JOIN users u ON u.id=sm.uploader_id WHERE ${where}`, params),
    ]);
    return successResponse({
      materials: rows.map((m: any) => ({ ...m, fileUrl: m.file_key ? this.fileUrl(m.file_key) : null })),
      meta: paginationMeta(parseInt(cnt.count, 10), page, limit),
    });
  }

  // ── Inline referral milestone award ─────────────────────────
  // Avoids circular dependency with AuthService by using DB directly
  private async awardReferralMilestoneInline(refereeId: string, milestone: string) {
    try {
      const rows = await this.db.query(`SELECT referred_by FROM users WHERE id=$1`, [refereeId]);
      if (!rows.length || !rows[0].referred_by) return;
      const referrerId = rows[0].referred_by;
      const coins = 50;

      // Idempotency — UNIQUE constraint prevents double-award
      const existing = await this.db.query(
        `SELECT id FROM referral_milestones WHERE referrer_id=$1 AND referee_id=$2 AND milestone=$3`,
        [referrerId, refereeId, milestone]
      );
      if (existing.length) return;

      await this.db.query(
        `INSERT INTO referral_milestones (referrer_id, referee_id, milestone, coins) VALUES ($1,$2,$3,$4)`,
        [referrerId, refereeId, milestone, coins]
      );
      await this.db.query(
        `UPDATE users SET coins = COALESCE(coins,0) + $1, total_coins_earned = COALESCE(total_coins_earned,0) + $1 WHERE id=$2`,
        [coins, referrerId]
      );
      const bal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [referrerId]))[0]?.coins ?? 0;
      await this.db.query(
        `INSERT INTO coin_transactions (user_id, type, amount, description, action, ref_id, balance)
         VALUES ($1,'earned',$2,'Friend uploaded notes — referral bonus (2/3)','referral_engagement',$3,$4)`,
        [referrerId, coins, refereeId, bal]
      );
      await this.cache.del(`user:${referrerId}`);
    } catch (err: any) {
      this.logger.warn(`awardReferralMilestoneInline failed: ${err.message}`);
    }
  }

  // ── Admin: correct a material's language tag ─────────────────
  async updateMaterialLanguage(id: string, language: string) {
    const allowed = ['English', 'Hindi', 'Hindi + English'];
    const value = allowed.includes(language) ? language : 'English';
    const [row] = await this.db.query(
      `UPDATE study_materials SET language=$2, updated_at=NOW() WHERE id=$1 RETURNING id, language`,
      [id, value]
    );
    if (!row) throw new NotFoundException('Material not found');
    return successResponse({ id: row.id, language: row.language }, 'Language updated');
  }

  // ── Admin: backfill page_count for existing PDFs ──────────
  // Reads every approved PDF where page_count=0, re-parses the file
  // on disk, and updates the DB. Safe to call multiple times (idempotent).
  async backfillPageCounts() {
    const rows = await this.db.query(
      `SELECT id, file_key FROM study_materials
       WHERE material_type IN ('pdf','pyq','book') AND page_count = 0 AND file_key IS NOT NULL`
    );
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const filePath = join(this.uploadDir, row.file_key);
      if (!fs.existsSync(filePath)) { skipped++; continue; }
      try {
        const pdfBytes = fs.readFileSync(filePath);
        const pdfStr   = pdfBytes.toString('latin1');
        let pageCount  = 0;
        const typeMatches = pdfStr.match(/\/Type\s*\/Page[^s]/g);
        if (typeMatches) {
          pageCount = typeMatches.length;
        }
        if (pageCount === 0) {
          const alt = pdfStr.match(/\/Count\s+(\d+)/g);
          if (alt) {
            const nums = alt.map((s: string) => parseInt(s.replace(/\/Count\s+/, ''), 10)).filter((n: number) => !isNaN(n));
            pageCount  = nums.length > 0 ? Math.max(...nums) : 0;
          }
        }
        if (pageCount > 0) {
          await this.db.query(
            `UPDATE study_materials SET page_count=$1, updated_at=NOW() WHERE id=$2`,
            [pageCount, row.id]
          );
          updated++;
        } else {
          skipped++;
        }
      } catch (err: any) {
        this.logger.warn(`backfillPageCounts: skip ${row.id} — ${err.message}`);
        skipped++;
      }
    }
    this.logger.log(`backfillPageCounts: updated=${updated} skipped=${skipped} total=${rows.length}`);
    return successResponse({ updated, skipped, total: rows.length }, 'Backfill complete');
  }

  async adminApprove(id: string) {
    await this.db.query(`UPDATE study_materials SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);

    // Award coins to the uploader for the upload_note task (once per material approved)
    // Only award if they haven't already been awarded for this material's upload action
    try {
      const [mat] = await this.db.query(
        `SELECT uploader_id FROM study_materials WHERE id=$1`, [id]
      );
      if (mat?.uploader_id) {
        await this.coinsService.claimTask('upload_note', mat.uploader_id);
        // ── Referral milestone 2 — engagement: friend uploaded a material ──
        // Done inline to avoid circular dependency with AuthService
        this.awardReferralMilestoneInline(mat.uploader_id, 'engagement').catch(() => {});
      }
    } catch (_) { /* non-blocking — approval still succeeds */ }

    // Push notification to the uploader (direct Firebase, no cross-module dependency)
    try {
      const rows = await this.db.query(
        `SELECT sm.title, u.fcm_token
         FROM study_materials sm
         JOIN users u ON u.id = sm.uploader_id
         WHERE sm.id=$1`, [id]
      );
      const mat = rows[0];
      if (mat?.fcm_token) {
        ensureFirebaseAdmin();
        const result = await admin.messaging().send({
          token: mat.fcm_token,
          notification: {
            title: '✅ Study material approved!',
            body:  `Your upload "${mat.title}" is now live for all students.`,
          },
          data: { type: 'material_approved', materialId: id, screen: 'study_materials' },
          android: { priority: 'high' },
        });
        this.logger.log(`Push sent for approval: ${result}`);
      } else {
        this.logger.warn(`adminApprove: no fcm_token for material ${id}`);
      }
    } catch (err: any) {
      this.logger.error(`adminApprove push failed: ${err.message}`);
    }

    return successResponse(null, '✅ Approved — now visible to students');
  }

  async adminReject(id: string, reason?: string) {
    // Ensure column exists (migration-safe)
    await this.db.query(`ALTER TABLE study_materials ADD COLUMN IF NOT EXISTS rejection_reason TEXT`).catch(() => {});
    await this.db.query(
      `UPDATE study_materials SET status='rejected', rejection_reason=$2, updated_at=NOW() WHERE id=$1`,
      [id, reason || null]
    );

    // Send push notification to uploader
    try {
      const rows = await this.db.query(
        `SELECT sm.title, u.fcm_token
         FROM study_materials sm
         JOIN users u ON u.id = sm.uploader_id
         WHERE sm.id = $1`, [id]
      );
      const mat = rows[0];
      if (mat?.fcm_token) {
        ensureFirebaseAdmin();
        const body = reason
          ? `Your upload "${mat.title}" was rejected: ${reason}`
          : `Your upload "${mat.title}" was not approved. Please check the guidelines.`;
        const result = await admin.messaging().send({
          token: mat.fcm_token,
          notification: { title: '❌ Upload Not Approved', body },
          data: { type: 'upload_rejected', materialId: id, screen: 'study_materials' },
          android: { priority: 'high' },
        });
        this.logger.log(`Push sent for rejection: ${result}`);
      } else {
        this.logger.warn(`adminReject: no fcm_token for material ${id}`);
      }
    } catch (err: any) {
      this.logger.error(`adminReject push failed: ${err.message}`);
    }

    return successResponse(null, `Rejected${reason ? ': ' + reason : ''}`);
  }

  // ── Shared: push notification to a material's uploader ─────
  private async pushToUploader(materialId: string, title: string, body: string, data: Record<string, string>) {
    try {
      const rows = await this.db.query(
        `SELECT sm.title AS material_title, u.fcm_token
         FROM study_materials sm JOIN users u ON u.id = sm.uploader_id
         WHERE sm.id = $1`, [materialId]
      );
      const mat = rows[0];
      if (mat?.fcm_token) {
        ensureFirebaseAdmin();
        await admin.messaging().send({
          token: mat.fcm_token,
          notification: { title, body },
          data: { materialId, screen: 'study_materials', ...data },
          android: { priority: 'high' },
        });
      } else {
        this.logger.warn(`pushToUploader: no fcm_token for material ${materialId}`);
      }
    } catch (err: any) {
      this.logger.error(`pushToUploader failed: ${err.message}`);
    }
  }

  // ── Shared: load negotiation-relevant row, with guards ──────
  private async loadMaterialForNegotiation(id: string) {
    const [mat] = await this.db.query(
      `SELECT id, title, status, price, uploader_id, negotiation_round,
              current_offer_price, proposed_by, negotiation_status
       FROM study_materials WHERE id=$1`,
      [id]
    );
    if (!mat) throw new NotFoundException('Material not found');
    return mat;
  }

  // ── ADMIN: counter-offer instead of outright reject ─────────
  // Moves status -> 'negotiating', records round 1 (or increments
  // an existing round), and notifies the uploader.
  // Blocked once 3 rounds are already complete — admin must use
  // adminFinalDecision() instead.
  async adminCounterOffer(id: string, counterPrice: number, message?: string) {
    const mat = await this.loadMaterialForNegotiation(id);

    if (mat.status === 'approved') {
      throw new BadRequestException('Material is already approved');
    }
    if (mat.negotiation_round >= 3) {
      throw new BadRequestException(
        'Maximum negotiation rounds (3) reached — use the final decision (approve/reject) instead'
      );
    }
    if (counterPrice < 0) throw new BadRequestException('Price cannot be negative');

    const newRound = mat.negotiation_round + 1;

    await this.db.query(
      `UPDATE study_materials
       SET status='negotiating', negotiation_round=$2, current_offer_price=$3,
           proposed_by='admin', negotiation_status='awaiting_user', updated_at=NOW()
       WHERE id=$1`,
      [id, newRound, counterPrice]
    );
    await this.db.query(
      `INSERT INTO material_negotiations (material_id, round, offered_by, offer_price, message, action)
       VALUES ($1,$2,'admin',$3,$4,'counter')`,
      [id, newRound, counterPrice, message || null]
    );

    await this.pushToUploader(
      id,
      '💬 Price negotiation on your upload',
      message
        ? `For "${mat.title}", we suggest ₹${counterPrice}: ${message}`
        : `For "${mat.title}", we suggest a price of ₹${counterPrice}. Tap to respond.`,
      { type: 'price_negotiation', round: String(newRound) }
    );

    return successResponse(
      { negotiationRound: newRound, currentOfferPrice: counterPrice },
      `Counter-offer of ₹${counterPrice} sent (round ${newRound}/3)`
    );
  }

  // ── USER: respond to admin's counter-offer ──────────────────
  // action='accept'  -> material is approved at current_offer_price
  // action='counter' -> user proposes their own price (increments round)
  async respondToNegotiation(
    materialId: string,
    userId: string,
    action: 'accept' | 'counter',
    counterPrice?: number,
    message?: string,
  ) {
    const mat = await this.loadMaterialForNegotiation(materialId);
    if (mat.uploader_id !== userId) throw new BadRequestException('Not your material');
    if (mat.negotiation_status !== 'awaiting_user') {
      throw new BadRequestException('No pending offer to respond to');
    }

    if (action === 'accept') {
      const finalPrice = mat.current_offer_price ?? mat.price;
      await this.db.query(
        `UPDATE study_materials
         SET status='approved', price=$2, negotiation_status='resolved',
             approved_at=NOW(), updated_at=NOW()
         WHERE id=$1`,
        [materialId, finalPrice]
      );
      await this.db.query(
        `INSERT INTO material_negotiations (material_id, round, offered_by, offer_price, message, action)
         VALUES ($1,$2,'user',$3,$4,'accept')`,
        [materialId, mat.negotiation_round, finalPrice, message || null]
      );

      // Coin reward + referral milestone, same as a normal approval
      try {
        await this.coinsService.claimTask('upload_note', userId);
        this.awardReferralMilestoneInline(userId, 'engagement').catch(() => {});
      } catch (_) { /* non-blocking */ }

      return successResponse(
        { status: 'approved', finalPrice },
        `✅ Accepted ₹${finalPrice} — your material is now live!`
      );
    }

    // action === 'counter'
    if (counterPrice == null || counterPrice < 0) {
      throw new BadRequestException('A valid counter price is required');
    }
    if (mat.negotiation_round >= 3) {
      // Round 3 was the admin's offer; user cannot start a 4th round —
      // admin must make the final call.
      throw new BadRequestException(
        'Maximum negotiation rounds reached — please wait for the final decision from our team'
      );
    }

    const newRound = mat.negotiation_round + 1;
    const isFinalRound = newRound >= 3;

    await this.db.query(
      `UPDATE study_materials
       SET negotiation_round=$2, current_offer_price=$3,
           proposed_by='user', negotiation_status='awaiting_admin', updated_at=NOW()
       WHERE id=$1`,
      [materialId, newRound, counterPrice]
    );
    await this.db.query(
      `INSERT INTO material_negotiations (material_id, round, offered_by, offer_price, message, action)
       VALUES ($1,$2,'user',$3,$4,'counter')`,
      [materialId, newRound, counterPrice, message || null]
    );

    return successResponse(
      { negotiationRound: newRound, currentOfferPrice: counterPrice, isFinalRound },
      isFinalRound
        ? `Counter sent (round ${newRound}/3 — final round). Our team will make a final decision.`
        : `Counter-offer of ₹${counterPrice} sent (round ${newRound}/3)`
    );
  }

  // ── ADMIN: final decision after round 3 is exhausted ────────
  // action='approve' -> publish at the given price (defaults to the
  //                      most recent offer on the table)
  // action='reject'  -> permanent rejection with reason
  async adminFinalDecision(id: string, action: 'approve' | 'reject', price?: number, reason?: string) {
    const mat = await this.loadMaterialForNegotiation(id);

    if (action === 'approve') {
      const finalPrice = price ?? mat.current_offer_price ?? mat.price;
      await this.db.query(
        `UPDATE study_materials
         SET status='approved', price=$2, negotiation_status='resolved',
             approved_at=NOW(), updated_at=NOW()
         WHERE id=$1`,
        [id, finalPrice]
      );
      await this.db.query(
        `INSERT INTO material_negotiations (material_id, round, offered_by, offer_price, message, action)
         VALUES ($1,$2,'admin',$3,$4,'final_approve')`,
        [id, mat.negotiation_round, finalPrice, reason || null]
      );

      try {
        await this.coinsService.claimTask('upload_note', mat.uploader_id);
        this.awardReferralMilestoneInline(mat.uploader_id, 'engagement').catch(() => {});
      } catch (_) { /* non-blocking */ }

      await this.pushToUploader(
        id,
        '✅ Study material approved!',
        `Your upload "${mat.title}" is now live at ₹${finalPrice}.`,
        { type: 'material_approved' }
      );

      return successResponse({ status: 'approved', finalPrice }, `Approved at ₹${finalPrice}`);
    }

    // action === 'reject'
    await this.db.query(
      `UPDATE study_materials
       SET status='rejected', rejection_reason=$2, negotiation_status='resolved', updated_at=NOW()
       WHERE id=$1`,
      [id, reason || 'Not approved after negotiation']
    );
    await this.db.query(
      `INSERT INTO material_negotiations (material_id, round, offered_by, offer_price, message, action)
       VALUES ($1,$2,'admin',$3,$4,'final_reject')`,
      [id, mat.negotiation_round, mat.current_offer_price ?? mat.price, reason || null]
    );

    await this.pushToUploader(
      id,
      '❌ Upload Not Approved',
      reason
        ? `Your upload "${mat.title}" was not approved: ${reason}`
        : `Your upload "${mat.title}" was not approved after negotiation.`,
      { type: 'upload_rejected' }
    );

    return successResponse({ status: 'rejected' }, `Rejected${reason ? ': ' + reason : ''}`);
  }

  async adminToggleFeature(id: string) {
    const [row] = await this.db.query(`SELECT is_featured FROM study_materials WHERE id=$1`, [id]);
    if (!row) throw new NotFoundException();
    await this.db.query(`UPDATE study_materials SET is_featured=$2 WHERE id=$1`, [id, !row.is_featured]);
    return successResponse({ isFeatured: !row.is_featured });
  }

  async adminToggleTrending(id: string) {
    const [row] = await this.db.query(`SELECT is_trending FROM study_materials WHERE id=$1`, [id]);
    if (!row) throw new NotFoundException();
    await this.db.query(`UPDATE study_materials SET is_trending=$2 WHERE id=$1`, [id, !row.is_trending]);
    return successResponse({ isTrending: !row.is_trending });
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

  // ── GET: user's download history ────────────────────────
  async myDownloads(userId: string, page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    // FIX: material_downloads table may not exist if migration hasn't run.
    // Check first, return empty array instead of crashing with 500.
    const tableExists = await this.db.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'material_downloads'
      ) AS exists
    `);

    if (!tableExists[0]?.exists) {
      this.logger.warn('material_downloads table not found — run migration 1779700000000');
      return successResponse({ downloads: [] });
    }

    const rows = await this.db.query(
      `SELECT
         sm.id, sm.title, sm.subject, sm.material_type AS "materialType",
         sm.file_key, sm.file_size_bytes AS "fileSizeBytes",
         sm.page_count AS "pageCount",
         COALESCE(sm.language, 'English') AS language,
         COALESCE(sm.price, 0) AS price,
         COALESCE(sm.free_pages, 3) AS "freePages",
         u.name AS "uploaderName",
         dl.created_at AS "downloadedAt",
         EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_name='material_purchases'
         ) AND EXISTS (
           SELECT 1 FROM material_purchases mp
           WHERE mp.material_id = sm.id AND mp.user_id = $1
         ) AS "isPurchased"
       FROM material_downloads dl
       JOIN study_materials sm ON sm.id = dl.material_id
       LEFT JOIN users u ON u.id = sm.uploader_id
       WHERE dl.user_id = $1
       ORDER BY dl.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const downloads = rows.map((r: any) => ({
      ...r,
      fileUrl: r.file_key ? this.fileUrl(r.file_key) : null,
    }));

    return successResponse({ downloads });
  }

  // ── Rating: submit / upsert a star rating ───────────────────
  async rateMaterial(materialId: string, userId: string, stars: number, review?: string) {
    const s = Math.round(stars);
    if (s < 1 || s > 5) throw new BadRequestException('Stars must be between 1 and 5.');

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS material_ratings (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id UUID        NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stars       SMALLINT    NOT NULL CHECK (stars BETWEEN 1 AND 5),
        review      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(material_id, user_id)
      )
    `).catch(() => {});

    const [access] = await this.db.query(`
      SELECT 1 FROM material_purchases WHERE material_id=$1 AND user_id=$2
      UNION ALL
      SELECT 1 FROM download_history   WHERE material_id=$1 AND user_id=$2
      LIMIT 1
    `, [materialId, userId]).catch(() => [null]);
    if (!access) throw new BadRequestException('You can only rate materials you have accessed.');

    await this.db.query(`
      INSERT INTO material_ratings (material_id, user_id, stars, review)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (material_id, user_id)
      DO UPDATE SET stars=$3, review=$4, updated_at=NOW()
    `, [materialId, userId, s, review ?? null]);

    await this.db.query(`
      UPDATE study_materials
      SET rating = (SELECT ROUND(AVG(stars)::numeric,1) FROM material_ratings WHERE material_id=$1)
      WHERE id=$1
    `, [materialId]);

    const [mat] = await this.db.query(`SELECT rating FROM study_materials WHERE id=$1`, [materialId]);
    return successResponse({ stars: s, avgRating: parseFloat(mat?.rating ?? '0') }, 'Rating saved \u2B50');
  }

  async getMyRating(materialId: string, userId: string) {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS material_ratings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id UUID NOT NULL, user_id UUID NOT NULL,
        stars SMALLINT NOT NULL, review TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(material_id, user_id)
      )
    `).catch(() => {});
    const [row] = await this.db.query(
      `SELECT stars, review FROM material_ratings WHERE material_id=$1 AND user_id=$2`,
      [materialId, userId]
    ).catch(() => [null]);
    return successResponse({ stars: row?.stars ?? 0, review: row?.review ?? null });
  }

  // ── Shared: read a numeric app_settings value with fallback ─
  private async getSettingNumber(key: string, fallback: number): Promise<number> {
    const [row] = await this.db.query(
      `SELECT value FROM app_settings WHERE key=$1 LIMIT 1`, [key]
    ).catch(() => []);
    const n = parseFloat(row?.value);
    return isNaN(n) ? fallback : n;
  }

  // ── Shared: credit a seller's ₹ wallet and log the transaction ──
  // Auto-disburses immediately but logs status='disbursed' for a
  // full audit trail (per design: instant credit, full ledger).
  private async creditSellerWallet(
    sellerId: string, amountInr: number, materialId: string,
    purchaseOrderId: string, description: string,
  ) {
    if (amountInr <= 0) return;
    await this.db.query(`
      INSERT INTO seller_wallets (user_id, balance, total_earned)
      VALUES ($1,$2,$2)
      ON CONFLICT (user_id) DO UPDATE
        SET balance = seller_wallets.balance + $2,
            total_earned = seller_wallets.total_earned + $2,
            updated_at = NOW()
    `, [sellerId, amountInr]);

    const [wallet] = await this.db.query(
      `SELECT balance FROM seller_wallets WHERE user_id=$1`, [sellerId]
    );

    await this.db.query(`
      INSERT INTO wallet_transactions
        (user_id, type, amount, status, material_id, purchase_id, description, balance_after, disbursed_at)
      VALUES ($1,'sale_credit',$2,'disbursed',$3,$4,$5,$6,NOW())
    `, [sellerId, amountInr, materialId, purchaseOrderId, description, wallet.balance]);
  }

  // ── POST: initiate a marketplace purchase ───────────────────
  // Hybrid checkout: buyer may apply up to `max_coins_per_purchase`
  // coins as a discount (1 coin = coin_to_inr_rate ₹). Remaining ₹
  // balance is paid via Cashfree. If coins fully cover the price,
  // the purchase completes immediately with no payment step.
  async initPurchase(materialId: string, userId: string, coinsToApply: number) {
    // Already purchased?
    const [existing] = await this.db.query(
      `SELECT id FROM material_purchases WHERE material_id=$1 AND user_id=$2`,
      [materialId, userId]
    );
    if (existing) return successResponse({ purchased: true, alreadyPurchased: true });

    const [material] = await this.db.query(
      `SELECT id, title, price, uploader_id FROM study_materials WHERE id=$1 AND status='approved'`,
      [materialId]
    );
    if (!material) throw new NotFoundException('Material not found');

    const price = material.price ?? 0;

    // Free material — no payment needed at all
    if (price === 0) {
      await this.db.query(
        `INSERT INTO material_purchases (material_id, user_id, price_paid, coins_paid) VALUES ($1,$2,0,0)`,
        [materialId, userId]
      );
      const fileUrl = await this.fileUrlForMaterial(materialId);
      return successResponse({ purchased: true, alreadyPurchased: false, coinsSpent: 0, amountDueInr: 0, fileUrl },
        '🎉 Added to your library!');
    }

    // ── Validate coin discount ──
    const maxCoins      = await this.getSettingNumber('max_coins_per_purchase', 50);
    const coinToInrRate = await this.getSettingNumber('coin_to_inr_rate', 1);

    const coinsApplied = Math.max(0, Math.min(Math.floor(coinsToApply || 0), maxCoins));
    if (coinsApplied > 0) {
      const [userRow] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
      if (!userRow || userRow.coins < coinsApplied) {
        throw new BadRequestException(`You only have ${userRow?.coins ?? 0} coins.`);
      }
    }

    const coinDiscountInr = Math.min(price, Math.floor(coinsApplied * coinToInrRate));
    const amountDueInr    = price - coinDiscountInr;

    // ── Fully covered by coins — complete immediately, no gateway ──
    if (amountDueInr <= 0) {
      const [order] = await this.db.query(`
        INSERT INTO material_purchase_orders
          (material_id, user_id, material_price, coins_applied, coin_discount_inr, amount_due_inr, status)
        VALUES ($1,$2,$3,$4,$5,0,'completed')
        RETURNING id
      `, [materialId, userId, price, coinsApplied, coinDiscountInr]);

      return await this.finalizeMaterialPurchase(material, userId, order.id, coinsApplied, coinDiscountInr, price);
    }

    // ── Remaining balance needs Cashfree ─────────────────────────
    let paymentSessionId: string | null = null;
    let cfOrderId:        string | null = null;
    try {
      const { createCashfreeOrder, buildCashfreeCredentials, cashfreeReceiptId } = CashfreeUtil;
      let rows: any[] = [];

try {
  rows = await this.db.query(
    `SELECT key, value FROM payment_settings
     WHERE key IN ('cashfree_app_id','cashfree_secret_key','payment_mode')
       AND value IS NOT NULL AND value != ''`
  );
} catch (e) {
  console.error("PAYMENT_SETTINGS QUERY FAILED:", e);
}

console.log("ROWS =", rows);

const cfMap: any = {};
for (const r of rows) {
  cfMap[r.key] = r.value;
}

console.log("CFMAP =", cfMap);
console.log("PAYMENT MODE =", cfMap["payment_mode"]);
console.log("APP ID =", cfMap["cashfree_app_id"]);
console.log("SECRET =", cfMap["cashfree_secret_key"]?.substring(0, 10));

      const creds = buildCashfreeCredentials({
        appId:     cfMap['cashfree_app_id'],
        secretKey: cfMap['cashfree_secret_key'],
        env:       cfMap['payment_mode'],
      });
      const [userRow] = await this.db.query(
        `SELECT name, email, mobile FROM users WHERE id=$1`, [userId]
      );
      const order = await createCashfreeOrder(creds, {
        orderId:       cashfreeReceiptId('mat', materialId, userId),
        orderAmount:   amountDueInr,
        orderCurrency: 'INR',
        customerId:    userId,
        customerPhone: userRow?.mobile || '9999999999',
        customerEmail: userRow?.email  || `${userId}@bpscnotes.app`,
        customerName:  userRow?.name   || 'BPSCNotes User',
        orderNote:     `Study material: ${material.title}`,
        orderMeta:     { materialId, type: 'material_purchase' },
      });
      paymentSessionId = order.paymentSessionId;
      cfOrderId        = order.orderId;
    } catch (err: any) {
      this.logger.error(`Material Cashfree order creation failed: ${err.message}`);
    }

    if (!paymentSessionId || !cfOrderId) {
      throw new HttpException('Payment gateway unavailable. Please try again.', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const [order] = await this.db.query(`
      INSERT INTO material_purchase_orders
        (material_id, user_id, material_price, coins_applied, coin_discount_inr,
         amount_due_inr, provider_order_id, payment_provider, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'cashfree','pending')
      RETURNING id
    `, [materialId, userId, price, coinsApplied, coinDiscountInr, amountDueInr, cfOrderId]);

    return successResponse({
      purchased:        false,
      requiresPayment:  true,
      purchaseOrderId:  order.id,
      materialPrice:    price,
      coinsApplied,
      coinDiscountInr,
      amountDueInr,
      paymentSessionId,
      providerOrderId:  cfOrderId,
      materialTitle:    material.title,
    }, `₹${amountDueInr} due — complete payment to unlock`);
  }

  // ── POST: confirm a marketplace purchase after Cashfree payment ──
  async confirmPurchase(
    materialId: string, userId: string,
    dto: { purchaseOrderId: string; cfPaymentId: string; paymentMethod?: string },
  ) {
    // Idempotency
    const [already] = await this.db.query(
      `SELECT id FROM material_purchases WHERE material_id=$1 AND user_id=$2`,
      [materialId, userId]
    );
    if (already) {
      const fileUrl = await this.fileUrlForMaterial(materialId);
      return successResponse({ purchased: true, alreadyPurchased: true, fileUrl }, 'Already purchased');
    }

    const [order] = await this.db.query(
      `SELECT * FROM material_purchase_orders WHERE id=$1 AND material_id=$2 AND user_id=$3 AND status='pending'`,
      [dto.purchaseOrderId, materialId, userId]
    );
    if (!order) throw new NotFoundException('No pending purchase order found. Please try again.');

    // ── Verify payment with Cashfree (server-side) ───────────────
    const { verifyCashfreePayment, buildCashfreeCredentials } = CashfreeUtil;
    let rows: any[] = [];

try {
  rows = await this.db.query(
    `SELECT key, value FROM payment_settings
     WHERE key IN ('cashfree_app_id','cashfree_secret_key','payment_mode')
       AND value IS NOT NULL AND value != ''`
  );
} catch (e) {
  console.error("PAYMENT_SETTINGS QUERY FAILED:", e);
}

console.log("ROWS =", rows);

const cfMap: any = {};
for (const r of rows) {
  cfMap[r.key] = r.value;
}

console.log("CFMAP =", cfMap);
console.log("PAYMENT MODE =", cfMap["payment_mode"]);
console.log("APP ID =", cfMap["cashfree_app_id"]);
console.log("SECRET =", cfMap["cashfree_secret_key"]?.substring(0, 10));
    const creds = buildCashfreeCredentials({
      appId:     cfMap['cashfree_app_id'],
      secretKey: cfMap['cashfree_secret_key'],
      env:       cfMap['payment_mode'],
    });
    if (!creds.appId || !creds.secretKey) {
      throw new BadRequestException('Payment gateway not configured. Contact support.');
    }
    const providerOrderId = order.provider_order_id;
    if (!providerOrderId) {
      throw new BadRequestException('Missing provider order ID. Contact support.');
    }
    const payment = await verifyCashfreePayment(creds, providerOrderId);
    if (payment.paymentStatus !== 'SUCCESS') {
      this.logger.error(
        `MATERIAL PAYMENT NOT SUCCESS: user=${userId} material=${materialId} ` +
        `order=${providerOrderId} status=${payment.paymentStatus}`
      );
      throw new BadRequestException(`Payment not successful (status: ${payment.paymentStatus}). Contact support.`);
    }

    await this.db.query(
      `UPDATE material_purchase_orders
       SET status='completed', provider_payment_id=$1, payment_provider='cashfree',
           payment_method=$2, updated_at=NOW()
       WHERE id=$3`,
      [payment.cfPaymentId, payment.paymentMethod || 'upi', order.id]
    );

    const [material] = await this.db.query(
      `SELECT id, title, price, uploader_id FROM study_materials WHERE id=$1`, [materialId]
    );

    return await this.finalizeMaterialPurchase(
      material, userId, order.id, order.coins_applied, order.coin_discount_inr, order.material_price
    );
  }

  // ── Shared: finalize a purchase — deduct coins, record purchase, ──
  // credit seller wallet with the seller_commission_pct share, return file URL.
  // Called for both coin-only (fully covered) and Cashfree-completed purchases.
  private async finalizeMaterialPurchase(
    material: { id: string; title: string; price: number; uploader_id: string | null },
    userId: string, purchaseOrderId: string,
    coinsApplied: number, coinDiscountInr: number, fullPrice: number,
  ) {
    // Deduct applied coins from buyer
    let updatedCoins: number | null = null;
    if (coinsApplied > 0) {
      await this.db.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [coinsApplied, userId]);
      const [u] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
      updatedCoins = u.coins;
      await this.db.query(
        `INSERT INTO coin_transactions (user_id,type,amount,description,action,balance)
         VALUES ($1,'spent',$2,'Marketplace discount: '||$3,'material_purchase_discount',$4)`,
        [userId, coinsApplied, material.title, updatedCoins]
      );
    }

    // ── 60/40 split: compute seller's share and the platform's net fee ──
    // Seller share is 60% of the FULL listed price (coin discounts don't
    // reduce the seller's payout — the platform absorbs that cost).
    // Platform's net fee = amount actually collected (fullPrice - coinDiscountInr)
    // minus what was paid out to the seller. This can be less than the
    // "headline" 40% when a coin discount was applied.
    let sellerShare = 0;
    let platformFee = 0;
    if (material.uploader_id && material.uploader_id !== userId && fullPrice > 0) {
      const sellerPct = await this.getSettingNumber('seller_commission_pct', 60);
      sellerShare = Math.floor(fullPrice * sellerPct / 100);
      platformFee = Math.max(0, (fullPrice - coinDiscountInr) - sellerShare);
    }

    // Record the purchase (legacy table — kept for "isPurchased" checks elsewhere)
    await this.db.query(
      `INSERT INTO material_purchases (material_id, user_id, price_paid, coins_paid, platform_fee)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (material_id, user_id) DO NOTHING`,
      [material.id, userId, fullPrice, coinsApplied, platformFee]
    );

    if (sellerShare > 0) {
      await this.creditSellerWallet(
        material.uploader_id!, sellerShare, material.id, purchaseOrderId,
        `Sale: "${material.title}" (₹${fullPrice} @ ${Math.round(sellerShare / fullPrice * 100)}%)`
      );
    }


    const fileUrl = await this.fileUrlForMaterial(material.id);

    return successResponse({
      purchased: true, alreadyPurchased: false,
      coinsSpent: coinsApplied, coinsBalance: updatedCoins,
      coinDiscountInr, amountPaidInr: fullPrice - coinDiscountInr,
      fileUrl,
    }, '🎉 Purchase successful! Full PDF unlocked.');
  }

  // ── Shared: file URL lookup ──────────────────────────────────
  private async fileUrlForMaterial(materialId: string): Promise<string | null> {
    const [mat] = await this.db.query(`SELECT file_key FROM study_materials WHERE id=$1`, [materialId]);
    return mat?.file_key ? this.fileUrl(mat.file_key) : null;
  }

  // ── GET: seller wallet summary + transaction history ─────────
  async getWallet(userId: string, page = 1, limit = 30) {
    const offset = (page - 1) * limit;

    await this.db.query(`
      INSERT INTO seller_wallets (user_id, balance, total_earned)
      VALUES ($1,0,0) ON CONFLICT (user_id) DO NOTHING
    `, [userId]);

    const [wallet] = await this.db.query(
      `SELECT balance, total_earned FROM seller_wallets WHERE user_id=$1`, [userId]
    );

    const [transactions, [countRow]] = await Promise.all([
      this.db.query(
        `SELECT wt.id, wt.type, wt.amount, wt.status, wt.description, wt.balance_after,
                wt.created_at, wt.disbursed_at, sm.title AS material_title
         FROM wallet_transactions wt
         LEFT JOIN study_materials sm ON sm.id = wt.material_id
         WHERE wt.user_id=$1 ORDER BY wt.created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM wallet_transactions WHERE user_id=$1`, [userId]),
    ]);

    return successResponse({
      balance: wallet.balance,
      totalEarned: wallet.total_earned,
      transactions,
      meta: paginationMeta(parseInt(countRow.count, 10), page, limit),
    });
  }

  // ── POST: request withdrawal ──────────────────────────────
  // Deducts amount from seller balance immediately, creates a
  // 'pending' withdrawal transaction. Admin processes the actual
  // UPI/bank transfer and marks it 'disbursed' from the admin panel.
  async requestWithdrawal(userId: string, amount: number, upiId?: string) {
    if (!amount || amount < 100) throw new BadRequestException('Minimum withdrawal amount is ₹100');

    return this.db.transaction(async (em: any) => {
      const db = em.getRepository ? em : { query: em.query.bind(em) };

      // Lock seller_wallets row for update
      const [wallet] = await this.db.query(
        `SELECT balance FROM seller_wallets WHERE user_id=$1 FOR UPDATE`, [userId]
      );
      if (!wallet) throw new BadRequestException('No wallet found');
      if (wallet.balance < amount) {
        throw new BadRequestException(`Insufficient balance. Available: ₹${wallet.balance}`);
      }

      const newBalance = wallet.balance - amount;

      // Deduct balance
      await this.db.query(
        `UPDATE seller_wallets SET balance=$1 WHERE user_id=$2`,
        [newBalance, userId]
      );

      // Create withdrawal transaction record
      await this.db.query(
        `INSERT INTO wallet_transactions
           (user_id, type, amount, status, description, balance_after)
         VALUES ($1,'withdrawal',$2,'pending',$3,$4)`,
        [
          userId,
          amount,
          upiId ? `Withdrawal to UPI: ${upiId}` : 'Withdrawal requested',
          newBalance
        ]
      );

      return successResponse({ newBalance }, `Withdrawal of ₹${amount} requested. You'll receive it within 2-3 business days.`);
    }).catch(async (err: any) => {
      // Fallback: run outside transaction if DataSource doesn't support .transaction()
      if (err.message?.includes('transaction')) {
        const [wallet] = await this.db.query(
          `SELECT balance FROM seller_wallets WHERE user_id=$1`, [userId]
        );
        if (!wallet || wallet.balance < amount) {
          throw new BadRequestException(`Insufficient balance`);
        }
        const newBalance = wallet.balance - amount;
        await this.db.query(`UPDATE seller_wallets SET balance=$1 WHERE user_id=$2`, [newBalance, userId]);
        await this.db.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, status, description, balance_after) VALUES ($1,'withdrawal',$2,'pending',$3,$4)`,
          [userId, amount, upiId ? `Withdrawal to UPI: ${upiId}` : 'Withdrawal requested', newBalance]
        );
        return successResponse({ newBalance }, `Withdrawal of ₹${amount} requested.`);
      }
      throw err;
    });
  }

  // ── GET: preview (free pages URL — for locked content) ───
  // In production, you'd generate a page-limited PDF.
  // For now, return same URL with a free_pages hint.
  async getPreview(materialId: string, userId: string) {
    const [mat] = await this.db.query(
      `SELECT sm.*, EXISTS (
         SELECT 1 FROM material_purchases mp WHERE mp.material_id=sm.id AND mp.user_id=$2
       ) AS "isPurchased"
       FROM study_materials sm WHERE sm.id=$1 AND sm.status='approved'`,
      [materialId, userId]
    );
    if (!mat) throw new Error('Not found');

    const freePages  = mat.free_pages ?? 3;
    const isPurchased = mat.isPurchased || !mat.is_premium;
    const fileUrl    = mat.file_key ? this.fileUrl(mat.file_key) : null;

    return successResponse({
      previewUrl:  fileUrl,   // full URL (Android will limit display pages)
      totalPages:  mat.page_count ?? 0,
      freePages,
      isPurchased
    });
  }

  // ── DELETE: remove a download from history ───────────────
  async removeDownload(materialId: string, userId: string) {
    await this.db.query(
      `DELETE FROM material_downloads WHERE material_id=$1 AND user_id=$2`,
      [materialId, userId]
    );
    return successResponse(null, 'Removed from downloads');
  }

  // ── GET: record download in history table ─────────────────
  async recordDownloadHistory(materialId: string, userId: string) {
    // Ensure table exists
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS material_downloads (
        id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        material_id UUID        NOT NULL,
        user_id     UUID        NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Use SELECT + INSERT instead of ON CONFLICT to avoid constraint errors
    const rows = await this.db.query(
      `SELECT id FROM material_downloads WHERE material_id = $1 AND user_id = $2 LIMIT 1`,
      [materialId, userId]
    ).catch(() => []);

    if (rows.length > 0) {
      await this.db.query(
        `UPDATE material_downloads SET created_at = NOW() WHERE material_id = $1 AND user_id = $2`,
        [materialId, userId]
      ).catch(() => {});
    } else {
      await this.db.query(
        `INSERT INTO material_downloads (material_id, user_id) VALUES ($1, $2)`,
        [materialId, userId]
      ).catch((e: any) => this.logger.warn('recordDownload insert:', e.message));
    }
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

  // ── ADMIN: list all seller wallets (balances + totals) ───────
  // Supports search by name/mobile and sorting by balance/earned.
  async adminListWallets(query: any) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let pi = 1;
    if (query.search?.trim()) {
      conditions.push(`(u.name ILIKE $${pi} OR u.mobile ILIKE $${pi})`);
      params.push(`%${query.search.trim()}%`); pi++;
    }
    const where = conditions.join(' AND ');

    const sortMap: Record<string, string> = {
      balance:     'sw.balance DESC',
      total_earned: 'sw.total_earned DESC',
      name:        'u.name ASC',
    };
    const orderBy = sortMap[query.sort ?? 'balance'] ?? sortMap.balance;

    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT sw.user_id, u.name AS uploader_name, u.mobile, u.email,
                sw.balance, sw.total_earned, sw.updated_at,
                (SELECT COUNT(*) FROM wallet_transactions wt WHERE wt.user_id = sw.user_id) AS transaction_count,
                (SELECT COUNT(*) FROM wallet_transactions wt WHERE wt.user_id = sw.user_id AND wt.status='pending') AS pending_count
         FROM seller_wallets sw
         JOIN users u ON u.id = sw.user_id
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(*) FROM seller_wallets sw JOIN users u ON u.id = sw.user_id WHERE ${where}`,
        params
      ),
    ]);

    // Platform-wide totals — useful for an admin dashboard summary
    const [totals] = await this.db.query(`
      SELECT
        COALESCE(SUM(balance),0)::int      AS total_balance,
        COALESCE(SUM(total_earned),0)::int AS total_disbursed,
        COUNT(*)::int                      AS seller_count
      FROM seller_wallets
    `);

    // Platform revenue — sum of platform_fee from all completed marketplace
    // purchases (the platform's net cut after seller payouts and any
    // coin-discount cost absorbed by the platform).
    const [platformRow] = await this.db.query(`
      SELECT COALESCE(SUM(platform_fee),0)::int AS platform_revenue
      FROM material_purchases
    `);
    totals.platform_revenue = parseInt(platformRow?.platform_revenue ?? '0', 10);

    return successResponse({
      wallets: rows.map((r: any) => ({
        ...r,
        transaction_count: parseInt(r.transaction_count, 10),
        pending_count: parseInt(r.pending_count, 10),
      })),
      totals,
      meta: paginationMeta(parseInt(cnt.count, 10), page, limit),
    });
  }

  // ── ADMIN: full transaction history for one seller ───────────
  async adminGetWalletTransactions(userId: string, page = 1, limit = 30) {
    const offset = (page - 1) * limit;

    const [wallet] = await this.db.query(
      `SELECT sw.balance, sw.total_earned, u.name AS uploader_name, u.mobile
       FROM seller_wallets sw JOIN users u ON u.id = sw.user_id
       WHERE sw.user_id=$1`,
      [userId]
    );
    if (!wallet) throw new NotFoundException('Seller has no wallet yet');

    const [transactions, [countRow]] = await Promise.all([
      this.db.query(
        `SELECT wt.id, wt.type, wt.amount, wt.status, wt.description, wt.balance_after,
                wt.created_at, wt.disbursed_at, sm.title AS material_title, sm.id AS material_id
         FROM wallet_transactions wt
         LEFT JOIN study_materials sm ON sm.id = wt.material_id
         WHERE wt.user_id=$1 ORDER BY wt.created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM wallet_transactions WHERE user_id=$1`, [userId]),
    ]);

    return successResponse({
      uploaderName: wallet.uploader_name,
      mobile: wallet.mobile,
      balance: wallet.balance,
      totalEarned: wallet.total_earned,
      transactions,
      meta: paginationMeta(parseInt(countRow.count, 10), page, limit),
    });
  }

  // ── ADMIN: per-material revenue breakdown ─────────────────────
  // For each material with at least one paid purchase, shows total
  // collected, what the seller was paid, and the platform's net fee
  // — i.e. "how much did the platform make from THIS material".
  async adminListMaterialRevenue(query: any) {
    const page   = Math.max(1, +(query.page  ?? 1));
    const limit  = Math.min(100, +(query.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [`mp.price_paid > 0`];
    const params: any[] = [];
    let pi = 1;
    if (query.search?.trim()) {
      conditions.push(`(sm.title ILIKE $${pi} OR u.name ILIKE $${pi})`);
      params.push(`%${query.search.trim()}%`); pi++;
    }
    const where = conditions.join(' AND ');

    const sortMap: Record<string, string> = {
      revenue:  'platform_revenue DESC',
      sales:    'sale_count DESC',
      newest:   'last_sale_at DESC',
    };
    const orderBy = sortMap[query.sort ?? 'revenue'] ?? sortMap.revenue;

    const [rows, [cnt]] = await Promise.all([
      this.db.query(
        `SELECT sm.id AS material_id, sm.title, sm.price,
                u.name AS uploader_name, u.mobile AS uploader_mobile,
                COUNT(mp.id)::int                          AS sale_count,
                COALESCE(SUM(mp.price_paid),0)::int        AS total_collected,
                COALESCE(SUM(mp.price_paid - mp.platform_fee),0)::int AS seller_payout,
                COALESCE(SUM(mp.platform_fee),0)::int      AS platform_revenue,
                MAX(mp.created_at)                         AS last_sale_at
         FROM material_purchases mp
         JOIN study_materials sm ON sm.id = mp.material_id
         LEFT JOIN users u ON u.id = sm.uploader_id
         WHERE ${where}
         GROUP BY sm.id, sm.title, sm.price, u.name, u.mobile
         ORDER BY ${orderBy}
         LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, limit, offset]
      ),
      this.db.query(
        `SELECT COUNT(*) FROM (
           SELECT sm.id FROM material_purchases mp
           JOIN study_materials sm ON sm.id = mp.material_id
           LEFT JOIN users u ON u.id = sm.uploader_id
           WHERE ${where}
           GROUP BY sm.id
         ) sub`,
        params
      ),
    ]);

    // Grand totals across ALL materials (not just this page) for a summary header
    const [grand] = await this.db.query(`
      SELECT
        COALESCE(SUM(price_paid),0)::int               AS total_collected,
        COALESCE(SUM(price_paid - platform_fee),0)::int AS total_seller_payout,
        COALESCE(SUM(platform_fee),0)::int             AS total_platform_revenue,
        COUNT(*)::int                                  AS total_sales
      FROM material_purchases WHERE price_paid > 0
    `);

    return successResponse({
      materials: rows,
      totals: grand,
      meta: paginationMeta(parseInt(cnt.count, 10), page, limit),
    });
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

  // FIX: pinned/featured materials must NOT depend on the main list's
  // pagination (limit=20, sorted by downloads). A pinned item with low
  // downloads could sit on page 3+ and never appear in the client-side
  // `.filter { it.isFeatured }` — making it "only findable via search".
  // This dedicated endpoint returns ALL approved featured materials.
  @Get('pinned')
  getPinned(@Req() r: any) { return this.svc.listPinned(r.user?.id); }

  @Get()
  list(@Query() q: any, @Req() r: any) {
    return this.svc.listApproved({ ...q, userId: r.user?.id });
  }

  @Get('my-uploads')
  myUploads(@Req() r: any) { return this.svc.myUploads(r.user.id); }

  // ── NEGOTIATION: get full offer history for a material ─────
  @Get('my-uploads/:id/negotiation')
  getNegotiationHistory(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.getNegotiationHistory(id, r.user.id);
  }

  // ── NEGOTIATION: accept the admin's counter-offer ───────────
  @Post('my-uploads/:id/negotiation/accept')
  @HttpCode(HttpStatus.OK)
  acceptNegotiation(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.respondToNegotiation(id, r.user.id, 'accept');
  }

  // ── NEGOTIATION: send a counter-offer back to admin ─────────
  @Post('my-uploads/:id/negotiation/counter')
  @HttpCode(HttpStatus.OK)
  counterNegotiation(@Param('id', ParseUUIDPipe) id: string, @Body() b: any, @Req() r: any) {
    return this.svc.respondToNegotiation(id, r.user.id, 'counter', +b.price, b.message);
  }

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

  // FIX: Static routes MUST come before parameterised /:id routes.
  // NestJS matches in declaration order — 'my-downloads' would be swallowed
  // by ':id' and fail ParseUUIDPipe validation with a 400 error.
  @Get('my-downloads')
  getMyDownloads(@Query('page') page = 1, @Query('limit') limit = 50, @Req() r: any) {
    return this.svc.myDownloads(r.user.id, +page, +limit);
  }

  @Delete('my-downloads/:materialId')
  @HttpCode(HttpStatus.OK)
  removeDownload(@Param('materialId', ParseUUIDPipe) materialId: string, @Req() r: any) {
    return this.svc.removeDownload(materialId, r.user.id);
  }

  // ── Marketplace purchase — hybrid coins + Cashfree checkout ──
  // POST /study-materials/:id/purchase/init  body: { coinsToApply?: number }
  // Returns either a completed purchase (free or fully coin-covered)
  // or a Cashfree session to pay the remaining ₹ balance.
  @Post(':id/purchase/init')
  @HttpCode(HttpStatus.OK)
  initPurchase(@Param('id', ParseUUIDPipe) id: string, @Body() b: any, @Req() r: any) {
    return this.svc.initPurchase(id, r.user.id, +(b?.coinsToApply ?? 0));
  }

  // POST /study-materials/:id/purchase/confirm
  // body: { purchaseOrderId, cfPaymentId, paymentMethod? }
  @Post(':id/purchase/confirm')
  @HttpCode(HttpStatus.OK)
  confirmPurchase(@Param('id', ParseUUIDPipe) id: string, @Body() b: any, @Req() r: any) {
    return this.svc.confirmPurchase(id, r.user.id, b);
  }

  // POST /study-materials/:id/rate  body: { stars: 1-5, review?: string }
  @Post(':id/rate')
  @HttpCode(HttpStatus.OK)
  rateMaterial(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: { stars: number; review?: string },
    @Req() r: any
  ) { return this.svc.rateMaterial(id, r.user.id, b.stars, b.review); }

  // GET /study-materials/:id/my-rating
  @Get(':id/my-rating')
  getMyRating(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.getMyRating(id, r.user.id);
  }

  // ── GET: seller's ₹ wallet balance + transaction history ─────
  @Get('wallet')
  getWallet(@Query('page') page = 1, @Query('limit') limit = 30, @Req() r: any) {
    return this.svc.getWallet(r.user.id, +page, +limit);
  }

  @Post('wallet/withdraw')
  @HttpCode(HttpStatus.OK)
  requestWithdrawal(@Body() body: { amount: number; upiId?: string }, @Req() r: any) {
    return this.svc.requestWithdrawal(r.user.id, body.amount, body.upiId);
  }

  @Get(':id/preview')
  getPreview(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) {
    return this.svc.getPreview(id, r.user.id);
  }

  // ── Social proof: anonymized buyer list for "Rahul K. and 11 others" ──
  @Get(':id/buyers')
  getBuyers(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit = 5) {
    return this.svc.getBuyers(id, +limit);
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

  // ── Seller wallets (Phase 3) ────────────────────────────────
  // Must be declared before any :id routes to avoid 'wallets'
  // being swallowed by a ':id' parameter match.
  @Get('wallets')
  @RequirePermission('study-materials')
  adminListWallets(@Query() q: any) { return this.svc.adminListWallets(q); }

  @Get('wallets/:userId/transactions')
  @RequirePermission('study-materials')
  adminGetWalletTransactions(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 30,
  ) {
    return this.svc.adminGetWalletTransactions(userId, +page, +limit);
  }

  // ── Per-material platform revenue breakdown ─────────────────
  @Get('revenue')
  @RequirePermission('study-materials')
  adminListMaterialRevenue(@Query() q: any) { return this.svc.adminListMaterialRevenue(q); }

  @Get()
  @RequirePermission('study-materials')
  adminList(@Query() q: any) { return this.svc.adminList(q); }

  @Patch(':id/approve')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminApprove(id); }

  // ── Correct a material's language tag ────────────────────────
  // Needed because the language column was backfilled to 'English'
  // for all pre-existing uploads when it was added — admin can now
  // fix the tag on older Hindi/mixed materials retroactively.
  @Patch(':id/language')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  updateLanguage(@Param('id', ParseUUIDPipe) id: string, @Body() b: { language: string }) {
    return this.svc.updateMaterialLanguage(id, b.language);
  }

  // ── Backfill page_count for all PDFs that show 0 ─────────────
  // Admin triggers this once after deploy. Safe to call multiple times.
  // POST /admin/study-materials/backfill-page-counts
  @Post('backfill-page-counts')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  backfillPageCounts() { return this.svc.backfillPageCounts(); }


  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() b: any) { return this.svc.adminReject(id, b.reason); }

  // ── NEGOTIATION: counter-offer instead of outright reject ───
  // Body: { price: number, message?: string }
  @Patch(':id/counter-offer')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  counterOffer(@Param('id', ParseUUIDPipe) id: string, @Body() b: any) {
    return this.svc.adminCounterOffer(id, +b.price, b.message);
  }

  // ── NEGOTIATION: final call after round 3 ───────────────────
  // Body: { action: 'approve'|'reject', price?: number, reason?: string }
  @Patch(':id/final-decision')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  finalDecision(@Param('id', ParseUUIDPipe) id: string, @Body() b: any) {
    return this.svc.adminFinalDecision(id, b.action, b.price != null ? +b.price : undefined, b.reason);
  }

  @Patch(':id/feature')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  toggleFeature(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminToggleFeature(id); }

  @Patch(':id/trending')
  @RequirePermission('study-materials')
  @HttpCode(HttpStatus.OK)
  toggleTrending(@Param('id', ParseUUIDPipe) id: string) { return this.svc.adminToggleTrending(id); }

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
  imports:     [AuthModule, CoinsModule],
  controllers: [StudyMaterialsController, AdminStudyMaterialsController],
  providers:   [StudyMaterialsService],
  exports:     [StudyMaterialsService],
})
export class StudyMaterialsModule {}