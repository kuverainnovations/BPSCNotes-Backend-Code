import {
  Module, Injectable, Controller,
  Get, Post, Patch, Delete,
  Body, Query, Req, Param,
  HttpCode, HttpStatus,
  UseGuards, ParseUUIDPipe,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
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
// ════════════════════════════════════════════════════════════

// UI palette names the app renders; anything else is rejected so the
// column can't accumulate arbitrary client strings.
const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'];

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
      `SELECT id, title, content, color, is_pinned, created_at, updated_at
       FROM notebook_notes
       WHERE ${where}
       ORDER BY is_pinned DESC, updated_at DESC
       LIMIT 500`,
      params
    );
    return successResponse({ notes });
  }

  async create(userId: string, dto: { title?: string; content?: string; color?: string }) {
    const title   = (dto.title ?? '').trim().substring(0, 200);
    const content = dto.content ?? '';
    if (!title && !content.trim()) throw new BadRequestException('Note is empty');
    const color = this.validColor(dto.color);

    const [note] = await this.db.query(
      `INSERT INTO notebook_notes (user_id, title, content, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, content, color, is_pinned, created_at, updated_at`,
      [userId, title, content, color]
    );
    return successResponse({ note }, 'Note saved');
  }

  async update(
    userId: string, noteId: string,
    dto: { title?: string; content?: string; color?: string | null; isPinned?: boolean },
  ) {
    const sets: string[] = [];
    const params: any[] = [];
    let pi = 1;

    if (dto.title    !== undefined) { sets.push(`title = $${pi++}`);   params.push(dto.title.trim().substring(0, 200)); }
    if (dto.content  !== undefined) { sets.push(`content = $${pi++}`); params.push(dto.content); }
    if (dto.color    !== undefined) { sets.push(`color = $${pi++}`);   params.push(this.validColor(dto.color)); }
    if (dto.isPinned !== undefined) { sets.push(`is_pinned = $${pi++}`); params.push(!!dto.isPinned); }
    if (!sets.length) throw new BadRequestException('Nothing to update');

    // UPDATE via raw query() returns [rows, rowCount] (unlike INSERT/SELECT,
    // which return rows directly) — unwrap rows first, same trap as the
    // coin-deduction fix in courses.module.ts.
    const [rows] = await this.db.query(
      `UPDATE notebook_notes SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${pi++} AND user_id = $${pi}
       RETURNING id, title, content, color, is_pinned, created_at, updated_at`,
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
