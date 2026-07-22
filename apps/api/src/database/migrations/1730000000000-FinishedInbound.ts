import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinishedInbound1730000000000 implements MigrationInterface {
  name = 'FinishedInbound1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_document_type_check`);
    await queryRunner.query(`ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_document_type_check CHECK (document_type IN ('MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION','FINISHED_OUTBOUND','REVERSAL'))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE stock_documents DROP CONSTRAINT IF EXISTS stock_documents_document_type_check`);
    await queryRunner.query(`ALTER TABLE stock_documents ADD CONSTRAINT stock_documents_document_type_check CHECK (document_type IN ('MATERIAL_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION','FINISHED_OUTBOUND','REVERSAL'))`);
  }
}
