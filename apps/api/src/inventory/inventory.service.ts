import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { AuthUser } from '../common/constants';
import { parsePage } from '../common/validation';
import { WarehouseAccessService } from '../warehouses/warehouse-access.service';

@Injectable()
export class InventoryService {
  constructor(private readonly db: DataSource, private readonly warehouseAccess: WarehouseAccessService) {}

  async balances(q: any, user?: AuthUser) {
    const page = parsePage(q.page, 1);
    const pageSize = parsePage(q.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    const params: any[] = [];
    const where = this.balanceFilters(q, params);
    await this.appendWarehouseScope(where, params, 'sb', user);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ count }] = await this.db.query(
      `SELECT count(*)::int count
       FROM stock_balances sb
       JOIN items i ON i.id=sb.item_id
       JOIN warehouse_locations loc ON loc.id=sb.location_id
       JOIN warehouse_zones z ON z.id=loc.zone_id
       LEFT JOIN inventory_batches batch ON batch.id=sb.batch_id ${clause}`,
      params,
    );
    params.push(pageSize, offset);
    const items = await this.db.query(
      `SELECT sb.id,w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
        z.id "zoneId",z.code "zoneCode",z.name "zoneName",
        loc.id "locationId",loc.code "locationCode",loc.code "locationDisplayName",loc.name "locationName",NULLIF(z.actual_location,'未填写') "actualPosition",
        i.id "itemId",i.item_code "itemCode",i.name "itemName",i.item_type "itemType",i.unit,
        batch.id "batchId",batch.batch_no "batchNo",
        sb.on_hand_qty "onHandQty",
        GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(res.qty,0),0)::numeric(18,0) "availableQty",
        COALESCE(sb.frozen_qty,0)::numeric(18,0) "frozenQty",COALESCE(res.qty,0)::numeric(18,0) "reservedQty",i.minimum_stock "minimumStock",
        sb.updated_at "updatedAt"
       FROM stock_balances sb
       JOIN warehouses w ON w.id=sb.warehouse_id
       JOIN items i ON i.id=sb.item_id
       JOIN warehouse_locations loc ON loc.id=sb.location_id
       JOIN warehouse_zones z ON z.id=loc.zone_id
       LEFT JOIN inventory_batches batch ON batch.id=sb.batch_id
       LEFT JOIN (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id) res
         ON res.warehouse_id=sb.warehouse_id AND res.location_id=sb.location_id AND res.item_id=sb.item_id AND res.batch_id IS NOT DISTINCT FROM sb.batch_id
       ${clause}
       ORDER BY w.warehouse_code,z.code,loc.code,i.item_code,batch.batch_no NULLS FIRST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items, total: count, page, pageSize };
  }

  async transactions(q: any, user?: AuthUser) {
    const page = parsePage(q.page, 1);
    const pageSize = parsePage(q.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    const params: any[] = [];
    const where: string[] = [];
    const add = (value: any, expression: string) => {
      if (value === undefined || value === '') return;
      params.push(value);
      where.push(expression.replace('?', `$${params.length}`));
    };
    add(q.transactionId, 't.id::text=?');
    if (q.flowNo) add(`%${q.flowNo}%`, 't.flow_no ILIKE ?');
    if (q.documentNo) add(`%${q.documentNo}%`, 'd.document_no ILIKE ?');
    add(q.itemId, 't.item_id=?');
    add(q.warehouseId, 't.warehouse_id=?');
    add(q.zoneId, 'loc.zone_id=?');
    add(q.locationId, 't.location_id=?');
    add(q.batchId, 't.batch_id=?');
    add(q.documentType, 'd.document_type=?');
    if (q.direction !== undefined && !['IN', 'OUT'].includes(q.direction)) {
      throw new BusinessException('VALIDATION_ERROR', '流水方向只允许 IN 或 OUT', HttpStatus.BAD_REQUEST);
    }
    if (q.direction === 'IN') where.push('t.delta_qty>0');
    if (q.direction === 'OUT') where.push('t.delta_qty<0');
    if (q.batchNo) add(`%${q.batchNo}%`, 'batch.batch_no ILIKE ?');
    if (q.operator) add(`%${q.operator}%`, `COALESCE(t.operator_name,t.operator_username,u.name,u.username,'') ILIKE ?`);
    if (q.model) add(`%${q.model}%`, 'i.model ILIKE ?');
    if (q.parameter) {
      params.push(`%${q.parameter}%`);
      where.push(`EXISTS(SELECT 1 FROM material_parameters mp WHERE mp.material_id=i.id AND (mp.parameter_name ILIKE $${params.length} OR mp.parameter_value ILIKE $${params.length}))`);
    }
    add(q.dateFrom, 't.created_at >= ?::date');
    add(q.dateTo, `t.created_at < (?::date + interval '1 day')`);
    if (q.keyword) {
      params.push(`%${q.keyword}%`);
      where.push(`(t.flow_no ILIKE $${params.length} OR i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length} OR d.document_no ILIKE $${params.length} OR w.warehouse_code ILIKE $${params.length} OR w.name ILIKE $${params.length})`);
    }
    await this.appendWarehouseScope(where, params, 't', user);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ count }] = await this.db.query(
      `SELECT count(*)::int count FROM stock_transactions t
       JOIN items i ON i.id=t.item_id JOIN stock_documents d ON d.id=t.source_document_id
       JOIN warehouses w ON w.id=t.warehouse_id
       JOIN warehouse_locations loc ON loc.id=t.location_id
       LEFT JOIN inventory_batches batch ON batch.id=t.batch_id LEFT JOIN users u ON u.id=t.created_by ${clause}`,
      params,
    );
    params.push(pageSize, offset);
    const items = await this.db.query(
      `SELECT t.id,t.flow_no "flowNo",(t.flow_no IS NULL) "isHistoricalFlow",t.created_at "createdAt",w.id "warehouseId",w.warehouse_code "warehouseCode",
        z.code "zoneCode",loc.id "locationId",loc.code "locationCode",loc.code "locationDisplayName",NULLIF(z.actual_location,'未填写') "actualPosition",
        i.id "itemId",i.item_code "itemCode",i.name "itemName",i.model,i.spec,
        COALESCE(parameters.value,'—') parameters,i.unit,
        batch.id "batchId",batch.batch_no "batchNo",
        t.balance_before "balanceBefore",t.delta_qty "deltaQty",t.balance_after "balanceAfter",
        d.id "documentId",d.document_no "documentNo",d.document_type "documentType",
        d.production_order_id "productionOrderId",COALESCE(t.operator_name,t.operator_username,u.name,u.username,'—') operator
       FROM stock_transactions t
       JOIN warehouses w ON w.id=t.warehouse_id
       JOIN warehouse_locations loc ON loc.id=t.location_id
       JOIN warehouse_zones z ON z.id=loc.zone_id
       JOIN items i ON i.id=t.item_id
       LEFT JOIN inventory_batches batch ON batch.id=t.batch_id
       JOIN stock_documents d ON d.id=t.source_document_id
       JOIN users u ON u.id=t.created_by
       LEFT JOIN LATERAL (
         SELECT string_agg(parameter_name||'：'||parameter_value||COALESCE(' '||unit,''),'；' ORDER BY sort_order) value
         FROM material_parameters WHERE material_id=i.id
       ) parameters ON true
       ${clause}
       ORDER BY t.created_at DESC,t.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items, total: count, page, pageSize };
  }

  async transaction(id: string, user?: AuthUser) {
    const result = await this.transactions({ transactionId:id, page:1, pageSize:1 }, user);
    if (!result.items.length) throw new BusinessException('NOT_FOUND', '库存流水不存在', HttpStatus.NOT_FOUND);
    return result.items[0];
  }

  async reconciliation() {
    const differences = await this.db.query(
      `WITH ledger AS (
         SELECT warehouse_id,location_id,item_id,batch_id,sum(delta_qty)::numeric(18,0) ledger_qty
         FROM stock_transactions
         GROUP BY warehouse_id,location_id,item_id,batch_id
       )
       SELECT w.warehouse_code "warehouseCode",loc.code "locationCode",
         i.item_code "itemCode",batch.batch_no "batchNo",
         COALESCE(sb.on_hand_qty,0)::numeric(18,0)::text "balanceQty",
         COALESCE(l.ledger_qty,0)::numeric(18,0)::text "ledgerQty",
         (COALESCE(sb.on_hand_qty,0)-COALESCE(l.ledger_qty,0))::numeric(18,0)::text difference
       FROM stock_balances sb
       FULL OUTER JOIN ledger l ON l.warehouse_id=sb.warehouse_id
         AND l.location_id=sb.location_id AND l.item_id=sb.item_id
         AND l.batch_id IS NOT DISTINCT FROM sb.batch_id
       JOIN warehouses w ON w.id=COALESCE(sb.warehouse_id,l.warehouse_id)
       JOIN warehouse_locations loc ON loc.id=COALESCE(sb.location_id,l.location_id)
       JOIN items i ON i.id=COALESCE(sb.item_id,l.item_id)
       LEFT JOIN inventory_batches batch ON batch.id=COALESCE(sb.batch_id,l.batch_id)
       WHERE COALESCE(sb.on_hand_qty,0)<>COALESCE(l.ledger_qty,0)
       ORDER BY w.warehouse_code,loc.code,i.item_code,batch.batch_no NULLS FIRST`,
    );
    return { consistent: differences.length === 0, checkedAt: new Date().toISOString(), differences };
  }

  async exportCsv(q: any, user?: AuthUser) {
    const result = await this.balances({ ...q, page: 1, pageSize: 100 }, user);
    const all = [...result.items];
    for (let page = 2; page <= Math.ceil(result.total / 100); page++) {
      const next = await this.balances({ ...q, page, pageSize: 100 }, user);
      all.push(...next.items);
    }
    const header = ['仓库', '库区', '库位', '物料编码', '物料名称', '单位', '批次', '当前库存', '安全库存'];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return '\uFEFF' + [header, ...all.map((r: any) => [
      r.warehouseCode, r.zoneCode, r.locationCode, r.itemCode, r.itemName,
      r.unit, r.batchNo, new Decimal(r.onHandQty).toFixed(0), new Decimal(r.minimumStock || 0).toFixed(0),
    ])].map(row => row.map(escape).join(',')).join('\r\n');
  }

  private balanceFilters(q: any, params: any[]) {
    const where: string[] = [];
    const add = (value: any, expression: string) => {
      if (value === undefined || value === '') return;
      params.push(value);
      where.push(expression.replace('?', `$${params.length}`));
    };
    if (q.keyword) {
      params.push(`%${q.keyword}%`);
      where.push(`(i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length} OR batch.batch_no ILIKE $${params.length})`);
    }
    add(q.warehouseId, 'sb.warehouse_id=?');
    add(q.zoneId, 'z.id=?');
    add(q.locationId, 'sb.location_id=?');
    add(q.itemId, 'sb.item_id=?');
    add(q.batchId, 'sb.batch_id=?');
    add(q.itemType, 'i.item_type=?');
    return where;
  }

  private async appendWarehouseScope(where: string[], params: any[], alias: string, user?: AuthUser) {
    const ids = await this.warehouseAccess.managedWarehouseIds(user);
    if (ids === null) return;
    params.push(ids);
    where.push(`${alias}.warehouse_id=ANY($${params.length}::uuid[])`);
  }
}
