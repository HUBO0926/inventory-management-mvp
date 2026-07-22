import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1710000000000 implements MigrationInterface {
  name = 'InitialSchema1710000000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username varchar(50) NOT NULL UNIQUE,
        name varchar(100) NOT NULL,
        password_hash varchar(100) NOT NULL,
        role varchar(20) NOT NULL CHECK (role IN ('ADMIN','WAREHOUSE','PRODUCTION')),
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_code varchar(50) NOT NULL UNIQUE,
        name varchar(100) NOT NULL,
        item_type varchar(30) NOT NULL CHECK (item_type IN ('MATERIAL','FINISHED_GOOD')),
        unit varchar(20) NOT NULL,
        minimum_stock numeric(18,4) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE warehouses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_code varchar(20) NOT NULL UNIQUE,
        name varchar(100) NOT NULL, warehouse_type varchar(30) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE boms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), finished_good_id uuid NOT NULL REFERENCES items(id),
        version varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
        notes varchar(500), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(finished_good_id, version)
      );
      CREATE UNIQUE INDEX ux_boms_one_active ON boms(finished_good_id) WHERE status='ACTIVE';
      CREATE TABLE bom_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bom_id uuid NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
        material_id uuid NOT NULL REFERENCES items(id), qty_per numeric(18,4) NOT NULL CHECK (qty_per > 0),
        UNIQUE(bom_id, material_id)
      );
      CREATE TABLE production_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_no varchar(50) NOT NULL UNIQUE,
        finished_good_id uuid NOT NULL REFERENCES items(id), planned_qty numeric(18,4) NOT NULL CHECK (planned_qty > 0),
        completed_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (completed_qty >= 0),
        status varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED')),
        shortage_flag boolean NOT NULL DEFAULT false, planned_date date, notes varchar(500),
        created_by uuid NOT NULL REFERENCES users(id), released_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE production_order_materials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), production_order_id uuid NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
        material_id uuid NOT NULL REFERENCES items(id), qty_per numeric(18,4) NOT NULL CHECK (qty_per > 0),
        required_qty numeric(18,4) NOT NULL CHECK (required_qty > 0), issued_qty numeric(18,4) NOT NULL DEFAULT 0,
        returned_qty numeric(18,4) NOT NULL DEFAULT 0, UNIQUE(production_order_id, material_id)
      );
      CREATE TABLE stock_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_no varchar(60) NOT NULL UNIQUE,
        document_type varchar(40) NOT NULL CHECK (document_type IN ('MATERIAL_INBOUND','PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION','FINISHED_OUTBOUND','REVERSAL')),
        status varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','VOIDED')),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id), production_order_id uuid REFERENCES production_orders(id),
        original_document_id uuid REFERENCES stock_documents(id), notes varchar(500),
        created_by uuid NOT NULL REFERENCES users(id), posted_by uuid REFERENCES users(id), voided_by uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz, voided_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE stock_document_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
        item_id uuid NOT NULL REFERENCES items(id), quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
        direction varchar(10) NOT NULL CHECK (direction IN ('IN','OUT')), notes varchar(300), UNIQUE(document_id, item_id)
      );
      CREATE TABLE stock_balances (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), warehouse_id uuid NOT NULL REFERENCES warehouses(id),
        item_id uuid NOT NULL REFERENCES items(id), on_hand_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
        version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(warehouse_id, item_id)
      );
      CREATE TABLE stock_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_document_id uuid NOT NULL REFERENCES stock_documents(id),
        warehouse_id uuid NOT NULL REFERENCES warehouses(id), item_id uuid NOT NULL REFERENCES items(id),
        delta_qty numeric(18,4) NOT NULL CHECK (delta_qty <> 0), balance_after numeric(18,4) NOT NULL CHECK (balance_after >= 0),
        created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
        idempotency_key varchar(100) NOT NULL, endpoint varchar(160) NOT NULL, request_hash varchar(64) NOT NULL,
        response_payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, idempotency_key, endpoint)
      );
      CREATE TABLE operation_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id), action varchar(80) NOT NULL,
        entity_type varchar(80) NOT NULL, entity_id uuid, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ix_stock_documents_type_status ON stock_documents(document_type, status, created_at DESC);
      CREATE INDEX ix_stock_transactions_lookup ON stock_transactions(warehouse_id, item_id, created_at DESC);
      CREATE INDEX ix_production_orders_status ON production_orders(status, created_at DESC);
      CREATE OR REPLACE FUNCTION prevent_stock_transaction_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'stock_transactions are immutable'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_stock_transactions_immutable BEFORE UPDATE OR DELETE ON stock_transactions
      FOR EACH ROW EXECUTE FUNCTION prevent_stock_transaction_mutation();
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TRIGGER IF EXISTS trg_stock_transactions_immutable ON stock_transactions;
      DROP FUNCTION IF EXISTS prevent_stock_transaction_mutation();
      DROP TABLE IF EXISTS operation_logs, idempotency_keys, stock_transactions, stock_balances,
        stock_document_lines, stock_documents, production_order_materials, production_orders,
        bom_items, boms, warehouses, items, users CASCADE;
    `);
  }
}
