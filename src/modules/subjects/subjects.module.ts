
import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Body, Param,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { InjectDataSource }   from '@nestjs/typeorm';
import { DataSource }         from 'typeorm';
import { AdminJwtGuard }      from '../../common/guards';
import { AuthModule }         from '../auth/auth.module';
import { JwtAuthGuard }       from '../../common/guards';
import { successResponse }    from '../../common/utils/response.util';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/subjects/subjects.module.ts
//
// Provides:
//   GET  /app-config/subjects       — Android reads dynamic subject list
//   GET  /app-config/affair-categories — Android reads affair filter categories
//
//   Admin:
//   GET    /admin/subjects           — list all subjects
//   POST   /admin/subjects           — add new subject
//   PUT    /admin/subjects/:id       — update subject
//   DELETE /admin/subjects/:id       — delete subject
//   GET    /admin/affair-categories  — list affair categories
//   POST   /admin/affair-categories  — add new category
//   DELETE /admin/affair-categories/:id
// ════════════════════════════════════════════════════════════

@Injectable()
export class SubjectsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // Public endpoints (no auth)
  async getSubjects() {
    const rows = await this.db.query(
      `SELECT id, name, emoji, color_hex, type, sort_order
       FROM subjects WHERE is_active=TRUE ORDER BY sort_order, name`
    );
    return successResponse({ subjects: rows });
  }

  async getAffairCategories() {
    const rows = await this.db.query(
      `SELECT id, name, emoji, sort_order FROM affair_categories
       WHERE is_active=TRUE ORDER BY sort_order, name`
    );
    return successResponse({ categories: rows });
  }

  // Admin CRUD
  async listSubjectsAdmin() {
    const rows = await this.db.query(
      `SELECT id, name, emoji, color_hex, type, sort_order, is_active, created_at
       FROM subjects ORDER BY sort_order, name`
    );
    return successResponse({ subjects: rows });
  }

  async createSubject(dto: { name: string; emoji?: string; colorHex?: string; type?: string }) {
    const maxOrder = await this.db.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM subjects`);
    const [row] = await this.db.query(
      `INSERT INTO subjects (name, emoji, color_hex, type, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [dto.name, dto.emoji ?? '📚', dto.colorHex ?? '#1565C0', dto.type ?? 'all', maxOrder[0].next]
    );
    return successResponse({ subject: row }, 'Subject created');
  }

  async updateSubject(id: string, dto: any) {
    const fields: string[] = [];
    const vals:   any[]    = [];
    let i = 1;
    if (dto.name      != null) { fields.push(`name=$${i++}`);       vals.push(dto.name); }
    if (dto.emoji     != null) { fields.push(`emoji=$${i++}`);      vals.push(dto.emoji); }
    if (dto.colorHex  != null) { fields.push(`color_hex=$${i++}`);  vals.push(dto.colorHex); }
    if (dto.sortOrder != null) { fields.push(`sort_order=$${i++}`); vals.push(dto.sortOrder); }
    if (dto.isActive  != null) { fields.push(`is_active=$${i++}`);  vals.push(dto.isActive); }
    if (!fields.length) return successResponse(null, 'Nothing to update');
    await this.db.query(`UPDATE subjects SET ${fields.join(',')} WHERE id=$${i}`, [...vals, id]);
    return successResponse(null, 'Subject updated');
  }

  async deleteSubject(id: string) {
    await this.db.query(`DELETE FROM subjects WHERE id=$1`, [id]);
    return successResponse(null, 'Subject deleted');
  }

  // Affair categories CRUD
  async listCategoriesAdmin() {
    const rows = await this.db.query(
      `SELECT id, name, emoji, sort_order, is_active FROM affair_categories ORDER BY sort_order, name`
    );
    return successResponse({ categories: rows });
  }

  async createCategory(dto: { name: string; emoji?: string }) {
    const maxOrder = await this.db.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM affair_categories`);
    const [row] = await this.db.query(
      `INSERT INTO affair_categories (name, emoji, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [dto.name, dto.emoji ?? '📰', maxOrder[0].next]
    );
    return successResponse({ category: row }, 'Category created');
  }

  async deleteCategory(id: string) {
    await this.db.query(`DELETE FROM affair_categories WHERE id=$1`, [id]);
    return successResponse(null, 'Category deleted');
  }
}

// ── Public controller (no auth) ───────────────────────────────
@Controller('app-config')
export class AppConfigSubjectsController {
  constructor(private readonly svc: SubjectsService) {}

  @Get('subjects')
  getSubjects() { return this.svc.getSubjects(); }

  @Get('affair-categories')
  getAffairCategories() { return this.svc.getAffairCategories(); }
}

// ── Admin controller ─────────────────────────────────────────
@UseGuards(AdminJwtGuard)
@Controller('admin/subjects')
export class AdminSubjectsController {
  constructor(private readonly svc: SubjectsService) {}

  @Get()
  list() { return this.svc.listSubjectsAdmin(); }

  @Post()
  create(@Body() dto: any) { return this.svc.createSubject(dto); }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: any) { return this.svc.updateSubject(id, dto); }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) { return this.svc.deleteSubject(id); }
}

@UseGuards(AdminJwtGuard)
@Controller('admin/affair-categories')
export class AdminAffairCategoriesController {
  constructor(private readonly svc: SubjectsService) {}

  @Get()
  list() { return this.svc.listCategoriesAdmin(); }

  @Post()
  create(@Body() dto: any) { return this.svc.createCategory(dto); }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) { return this.svc.deleteCategory(id); }
}

@Module({
  imports:     [AuthModule],
  controllers: [AppConfigSubjectsController, AdminSubjectsController, AdminAffairCategoriesController],
  providers:   [SubjectsService],
  exports:     [SubjectsService],
})
export class SubjectsModule {}
