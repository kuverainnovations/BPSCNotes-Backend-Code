import { MigrationInterface, QueryRunner } from 'typeorm';

// QA 04-Jul issue 11 — the app's upload flow offers "Handwritten Notes" but
// the DB CHECK only allowed ('pdf','pyq','book','video'), so handwritten
// uploads were silently stored as 'pdf' and displayed as PDF in both the
// admin panel and the app. Widen the CHECK to make 'handwritten' a real
// type. 'notes' and 'image' are included too because the API's TYPES
// whitelist already advertises them — inserting either would have violated
// the old constraint with a 500.
// SAFE: constraint swap only, no data change; old rows all satisfy the
// wider constraint.
export class HandwrittenMaterialType1783700000000 implements MigrationInterface {
  name = 'HandwrittenMaterialType1783700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE study_materials
        DROP CONSTRAINT IF EXISTS study_materials_material_type_check
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
        ADD CONSTRAINT study_materials_material_type_check
        CHECK (material_type IN ('pdf','pyq','book','video','handwritten','notes','image'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original narrow constraint; remap any wider values to 'pdf'
    // first so the constraint can be applied.
    await queryRunner.query(`
      UPDATE study_materials SET material_type='pdf'
       WHERE material_type NOT IN ('pdf','pyq','book','video')
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
        DROP CONSTRAINT IF EXISTS study_materials_material_type_check
    `);
    await queryRunner.query(`
      ALTER TABLE study_materials
        ADD CONSTRAINT study_materials_material_type_check
        CHECK (material_type IN ('pdf','pyq','book','video'))
    `);
  }
}
