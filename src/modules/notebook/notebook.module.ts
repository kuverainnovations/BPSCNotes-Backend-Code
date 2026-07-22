import {
  Module, Injectable, Controller,
  Get, Post, Patch, Delete,
  Body, Query, Req, Param,
  HttpCode, HttpStatus,
  UseGuards, ParseUUIDPipe, UseInterceptors, UploadedFile,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../../common/guards';
import { successResponse } from '../../common/utils/response.util';
import { AuthModule } from '../auth/auth.module';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/notebook/notebook.module.ts
//
// Notebook — personal study notes (dashboard → Notebook card).
// Strictly per-user: every query is scoped to the JWT user's id,
// so one user can never read or touch another's notes. No admin
// surface on purpose — this is private user data.
//
// v3: notes are an ordered list of typed blocks (heading/text/bullet/
// numbered/check/image) stored in `blocks` JSONB. `content` is kept as a
// plain-text flattening for search + share + legacy render.
// ════════════════════════════════════════════════════════════

// UI palette names the app renders; anything else is rejected so the
// column can't accumulate arbitrary client strings.
const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'];
const BLOCK_TYPES = ['heading', 'text', 'bullet', 'numbered', 'check', 'image'];
const MAX_BLOCKS = 300;

@Injectable()
export class NotebookService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async list(userId: string, search?: string) {
    const params: any[] = [userId];
    let where = 'user_id = $1';
    if (search?.trim()) {
      params.push(`%${search.trim()}%`);
      where += ` AND (title ILIKE $2 OR content ILIKE $2)`;
    }
    const notes = await this.db.query(
      `SELECT id, title, content, color, subject, blocks, is_pinned, created_at, updated_at
       FROM notebook_notes
       WHERE ${where}
       ORDER BY is_pinned DESC, updated_at DESC
       LIMIT 500`,
      params
    );
    return successResponse({ notes });
  }

  async create(userId: string, dto: { title?: string; content?: string; color?: string; subject?: string; blocks?: any; sourceRef?: string }) {
    const title   = (dto.title ?? '').trim().substring(0, 200);
    const content = dto.content ?? '';
    const blocks  = this.normalizeBlocks(dto.blocks);
    if (!title && !content.trim() && !blocks) throw new BadRequestException('Note is empty');
    const color   = this.validColor(dto.color);
    const subject = (dto.subject ?? '').trim().substring(0, 100) || null;
    // sourceRef ties a note to the mock-test/quiz question it came from so the
    // same question can't be added twice (QA 21-07 Issue 10). Manually created
    // notes have no sourceRef and are never deduped.
    const sourceRef = (dto.sourceRef ?? '').trim().substring(0, 100) || null;

    const cols   = ['user_id', 'title', 'content', 'color', 'subject', 'blocks', 'source_ref'];
    const vals   = [userId, title, content, color, subject, blocks ? JSON.stringify(blocks) : null, sourceRef];
    // With a source_ref, re-adding is idempotent: ON CONFLICT keeps the first
    // note (no duplicate) and the existing row is returned below.
    const conflict = sourceRef
      ? `ON CONFLICT (user_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`
      : '';
    const [note] = await this.db.query(
      `INSERT INTO notebook_notes (${cols.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ${conflict}
       RETURNING id, title, content, color, subject, blocks, is_pinned, created_at, updated_at`,
      vals
    );
    if (!note && sourceRef) {
      // Conflict — the question is already in the notebook; return the existing note.
      const [existing] = await this.db.query(
        `SELECT id, title, content, color, subject, blocks, is_pinned, created_at, updated_at
           FROM notebook_notes WHERE user_id=$1 AND source_ref=$2`,
        [userId, sourceRef]
      );
      return successResponse({ note: existing, duplicate: true }, 'Already in your notebook');
    }
    return successResponse({ note }, 'Note saved');
  }

  async update(
    userId: string, noteId: string,
    dto: { title?: string; content?: string; color?: string | null; isPinned?: boolean; subject?: string | null; blocks?: any },
  ) {
    const sets: string[] = [];
    const params: any[] = [];
    let pi = 1;

    if (dto.title    !== undefined) { sets.push(`title = $${pi++}`);   params.push(dto.title.trim().substring(0, 200)); }
    if (dto.content  !== undefined) { sets.push(`content = $${pi++}`); params.push(dto.content); }
    if (dto.color    !== undefined) { sets.push(`color = $${pi++}`);   params.push(this.validColor(dto.color)); }
    if (dto.isPinned !== undefined) { sets.push(`is_pinned = $${pi++}`); params.push(!!dto.isPinned); }
    if (dto.subject  !== undefined) { sets.push(`subject = $${pi++}`); params.push((dto.subject ?? '').trim().substring(0, 100) || null); }
    if (dto.blocks   !== undefined) {
      const blocks = this.normalizeBlocks(dto.blocks);
      sets.push(`blocks = $${pi++}::jsonb`); params.push(blocks ? JSON.stringify(blocks) : null);
    }
    if (!sets.length) throw new BadRequestException('Nothing to update');

    // UPDATE via raw query() returns [rows, rowCount] (unlike INSERT/SELECT,
    // which return rows directly) — unwrap rows first, same trap as the
    // coin-deduction fix in courses.module.ts.
    const [rows] = await this.db.query(
      `UPDATE notebook_notes SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${pi++} AND user_id = $${pi}
       RETURNING id, title, content, color, subject, blocks, is_pinned, created_at, updated_at`,
      [...params, noteId, userId]
    );
    const note = rows[0];
    if (!note) throw new NotFoundException('Note not found');
    return successResponse({ note }, 'Note updated');
  }

  async remove(userId: string, noteId: string) {
    // DELETE via raw query() also returns [rows, rowCount] — the old
    // `result.length` check saw the outer pair (always 2) and could never
    // report not-found.
    const [rows] = await this.db.query(
      `DELETE FROM notebook_notes WHERE id = $1 AND user_id = $2 RETURNING id`,
      [noteId, userId]
    );
    if (!rows.length) throw new NotFoundException('Note not found');
    return successResponse(null, 'Note deleted');
  }

  private validColor(color?: string | null): string | null {
    if (!color) return null;
    return NOTE_COLORS.includes(color) ? color : null;
  }

  // Sanitize client-supplied blocks: drop unknown types, cap length/count,
  // keep only the fields each type uses. Returns null for an empty/absent
  // array so the column stays NULL (legacy render path) rather than "[]".
  private normalizeBlocks(blocks: any): any[] | null {
    if (!Array.isArray(blocks)) return null;
    const out = blocks
      .slice(0, MAX_BLOCKS)
      .filter((b) => b && BLOCK_TYPES.includes(b.type))
      .map((b) => {
        const block: any = { type: b.type };
        if (b.type === 'image') {
          block.url = String(b.url ?? '').substring(0, 500);
        } else {
          block.text = String(b.text ?? '').substring(0, 5000);
          if (b.type === 'check') block.done = !!b.done;
        }
        return block;
      })
      // Drop blocks that ended up with no content (empty image / empty text
      // is fine to keep for text so the user can have blank lines — only
      // drop images with no url).
      .filter((b) => b.type !== 'image' || b.url);
    return out.length ? out : null;
  }
}

@ApiTags('Notebook')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notebook')
export class NotebookController {
  constructor(private readonly svc: NotebookService) {}

  @Get()
  list(@Req() r: any, @Query('search') search?: string) {
    return this.svc.list(r.user.id, search);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() r: any, @Body() dto: any) {
    return this.svc.create(r.user.id, dto);
  }

  // User-facing image upload for note image blocks. Same disk-storage
  // pattern as AdminUploadController, but JWT-guarded and namespaced under
  // uploads/notebook. Served statically at ${BASE_URL}/uploads/… (main.ts).
  @Post('upload-image')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: (_req: any, _file: any, cb: any) => {
          const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
          const dest = join(uploadDir, 'notebook');
          fs.mkdirSync(dest, { recursive: true });
          cb(null, dest);
        },
        filename: (_req: any, file: any, cb: any) => {
          const ext  = extname(file.originalname).toLowerCase() || '.jpg';
          const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
          cb(null, name);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
      fileFilter: (_req: any, file: any, cb: any) => {
        if (file.mimetype?.startsWith('image/')) cb(null, true);
        else cb(new BadRequestException('Only image files are allowed'), false);
      },
    }),
  )
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
    const baseUrl   = process.env.BASE_URL    ?? 'https://api.bpscnotes.in';
    const fileKey   = file.path.replace(uploadDir + '/', '').replace(/\\/g, '/');
    return successResponse({ url: `${baseUrl}/uploads/${fileKey}`, fileKey }, 'Image uploaded');
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  update(@Req() r: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.svc.update(r.user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Req() r: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(r.user.id, id);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [NotebookController],
  providers: [NotebookService],
  exports: [NotebookService],
})
export class NotebookModule {}
