// ════════════════════════════════════════════════════════════
// LIBRARY MODULE
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, Get, Post, Put, Delete,
  Body, Param, Query, Req, HttpCode, HttpStatus,
  NotFoundException, ForbiddenException, UseGuards, ParseUUIDPipe,
  UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import * as cloudinary from 'cloudinary';

import { JwtAuthGuard, AdminJwtGuard, PermissionGuard, RequirePermission, Public } from '../../common/guards';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { successResponse, paginationMeta } from '../../common/utils/response.util';

@Injectable()
class LibraryService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async findAll(query: any, userId: string) {
    const { page=1, limit=20, type, subject, search, premium } = query;
    const offset = (page-1)*limit;
    const conditions = [`n.status='published'`];
    const params: any[] = [];
    if (type)    { conditions.push(`n.type=$${params.length+1}`); params.push(type); }
    if (subject) { conditions.push(`n.subject=$${params.length+1}`); params.push(subject); }
    if (premium === 'false') conditions.push(`n.is_premium=FALSE`);
    if (premium === 'true')  conditions.push(`n.is_premium=TRUE`);
    if (search)  { conditions.push(`to_tsvector('english',n.title||' '||COALESCE(n.description,''))@@plainto_tsquery($${params.length+1})`); params.push(search); }
    const where = conditions.join(' AND ');

    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT n.*,
           (SELECT TRUE FROM note_bookmarks nb WHERE nb.user_id=$${params.length+1} AND nb.note_id=n.id) AS is_bookmarked,
           (SELECT TRUE FROM note_downloads nd WHERE nd.user_id=$${params.length+1} AND nd.note_id=n.id) AS is_downloaded
         FROM library_notes n WHERE ${where}
         ORDER BY n.is_pinned DESC, n.is_trending DESC, n.created_at DESC
         LIMIT $${params.length+2} OFFSET $${params.length+3}`,
        [...params, userId, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM library_notes n WHERE ${where}`, params),
    ]);
    return successResponse({ notes: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async toggleBookmark(noteId: string, userId: string) {
    const existing = await this.db.query(`SELECT user_id FROM note_bookmarks WHERE user_id=$1 AND note_id=$2`, [userId, noteId]);
    if (existing.length) {
      await this.db.query(`DELETE FROM note_bookmarks WHERE user_id=$1 AND note_id=$2`, [userId, noteId]);
      return successResponse({ isBookmarked: false }, 'Bookmark removed');
    }
    await this.db.query(`INSERT INTO note_bookmarks VALUES ($1,$2)`, [userId, noteId]);
    return successResponse({ isBookmarked: true }, 'Bookmarked');
  }

  async download(noteId: string, userId: string) {
    const note = await this.db.query(`SELECT id, is_premium, file_url FROM library_notes WHERE id=$1 AND status='published'`, [noteId]);
    if (!note.length) throw new NotFoundException('Resource not found');
    const n = note[0];
    if (n.is_premium) {
      const sub = await this.db.query(`SELECT id FROM subscriptions WHERE user_id=$1 AND status='active' AND ends_at>NOW()`, [userId]);
      if (!sub.length) throw new ForbiddenException({ message: 'Subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    }
    await this.db.query(`INSERT INTO note_downloads VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, noteId]);
    await this.db.query(`UPDATE library_notes SET download_count=download_count+1 WHERE id=$1`, [noteId]);
    return successResponse({ fileUrl: n.file_url });
  }

  async userUpload(data: any, userId: string, userName: string) {
    const result = await this.db.query(
      `INSERT INTO library_notes (title, description, subject, type, author, uploaded_by_id, tags, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'review') RETURNING id`,
      [data.title, data.description, data.subject, data.type, userName, userId, data.tags || []]
    );
    return successResponse({ noteId: result[0].id }, 'Upload submitted for review. Our team will approve within 24 hours.');
  }

  async findAllAdmin(query: any) {
    const { page=1, limit=20, type, status, subject } = query;
    const offset = (page-1)*limit;
    const conditions = ['1=1'];
    const params: any[] = [];
    if (type)    { conditions.push(`n.type=$${params.length+1}`); params.push(type); }
    if (status)  { conditions.push(`n.status=$${params.length+1}`); params.push(status); }
    if (subject) { conditions.push(`n.subject=$${params.length+1}`); params.push(subject); }
    const where = conditions.join(' AND ');
    const [rows, countResult] = await Promise.all([
      this.db.query(
        `SELECT n.*, u.name AS uploader_name FROM library_notes n
         LEFT JOIN users u ON n.uploaded_by_id=u.id
         WHERE ${where} ORDER BY n.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM library_notes n WHERE ${where}`, params),
    ]);
    return successResponse({ notes: rows }, 'Success', paginationMeta(parseInt(countResult[0].count), page, limit));
  }

  async adminCreate(data: any, file: Express.Multer.File | undefined, adminId: string) {
    let fileUrl = null, fileSizeMb = 0;
    if (file) {
      const cfg = this.config.get('cloudinary');
      cloudinary.v2.config(cfg);
      const uploaded = await new Promise<any>((resolve, reject) => {
        const s = cloudinary.v2.uploader.upload_stream({ folder: 'bpscnotes/library', resource_type: 'auto' }, (e, r) => e ? reject(e) : resolve(r));
        s.end(file.buffer);
      });
      fileUrl = uploaded.secure_url;
      fileSizeMb = parseFloat((file.size / (1024*1024)).toFixed(2));
    }
    const result = await this.db.query(
      `INSERT INTO library_notes (title, description, subject, type, author, file_url, file_size_mb, is_premium, is_pinned, tags, exam_tags, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [data.title, data.description, data.subject, data.type, data.author, fileUrl, fileSizeMb,
       data.isPremium||false, data.isPinned||false, data.tags||[], data.examTags||[], data.status||'draft', adminId]
    );
    return successResponse({ note: result[0] }, 'Resource uploaded ✅');
  }

  async adminUpdate(noteId: string, data: any) {
    const fields: string[] = [], vals: any[] = [];
    let i = 1;
    const map: any = { title:'title', description:'description', subject:'subject', type:'type', author:'author', isPremium:'is_premium', isPinned:'is_pinned', isTrending:'is_trending', status:'status' };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) { fields.push(`${col}=$${i++}`); vals.push(data[key]); }
    }
    if (fields.length) { fields.push('updated_at=NOW()'); await this.db.query(`UPDATE library_notes SET ${fields.join(',')} WHERE id=$${i}`, [...vals, noteId]); }
    return successResponse(null, 'Resource updated — live in app ✅');
  }

  async reviewUpload(noteId: string, action: string) {
    if (!['published','rejected'].includes(action)) throw new ForbiddenException('Invalid action');
    await this.db.query(`UPDATE library_notes SET status=$1, updated_at=NOW() WHERE id=$2`, [action, noteId]);
    return successResponse(null, `${action === 'published' ? 'Approved — now live in E-Library ✅' : 'Rejected'}`);
  }

  async getPendingReviews() {
    const rows = await this.db.query(
      `SELECT n.*, u.name AS uploader_name FROM library_notes n
       LEFT JOIN users u ON n.uploaded_by_id=u.id
       WHERE n.status='review' ORDER BY n.created_at ASC`
    );
    return successResponse({ notes: rows, count: rows.length });
  }
}

@ApiTags('Library') @ApiBearerAuth() @UseGuards(JwtAuthGuard) @Controller('library')
class LibraryController {
  constructor(private s: LibraryService) {}
  @Get() findAll(@Query() q: any, @Req() r: any) { return this.s.findAll(q, r.user.id); }
  @Post(':id/bookmark') @HttpCode(200) toggleBookmark(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.toggleBookmark(id, r.user.id); }
  @Post(':id/download') @HttpCode(200) download(@Param('id', ParseUUIDPipe) id: string, @Req() r: any) { return this.s.download(id, r.user.id); }
  @Post('upload') @HttpCode(201) upload(@Body() dto: any, @Req() r: any) { return this.s.userUpload(dto, r.user.id, r.user.name); }
}

@ApiTags('Admin — Library') @ApiBearerAuth() @Public()
@UseGuards(AdminJwtGuard, PermissionGuard) @Controller('admin/library')
class AdminLibraryController {
  constructor(private s: LibraryService) {}
  @Get() @RequirePermission('notes') findAll(@Query() q: any) { return this.s.findAllAdmin(q); }
  @Get('pending-reviews') @RequirePermission('reviews') getPending() { return this.s.getPendingReviews(); }
  @Post() @RequirePermission('notes') @HttpCode(201) @UseInterceptors(FileInterceptor('file')) create(@Body() dto: any, @UploadedFile() file: any, @Req() r: any) { return this.s.adminCreate(dto, file, r.admin.id); }
  @Put(':id') @RequirePermission('notes') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) { return this.s.adminUpdate(id, dto); }
  @Put(':id/review') @RequirePermission('reviews') review(@Param('id', ParseUUIDPipe) id: string, @Body() body: any) { return this.s.reviewUpload(id, body.action); }
}

@Module({ imports:[ConfigModule], controllers:[LibraryController, AdminLibraryController], providers:[LibraryService] })
export class LibraryModule {}
