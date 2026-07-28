import { HttpStatus, Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';

type ReportDefinition = {
  sql: string;
  orderBy: string;
  params: any[];
};

const REPORT_NAMES: Record<string, string> = {
  current: '当前库存',
  'movement-summary': '出入库汇总',
  'item-ledger': '物料收发存',
  'warehouse-summary': '仓库库存统计',
  'low-stock': '低库存',
  'zero-stock': '零库存',
  'defective-stock': '不良品库存',
  aging: '库龄与呆滞库存',
  'batch-stock': '批次库存',
  'production-materials': '生产领退料统计',
};

@Injectable()
export class InventoryReportService {
  constructor(private readonly db: DataSource) {}

  async report(type: string, q: any) {
    const definition = this.definition(type, q);
    const page = parsePage(q.page, 1);
    const pageSize = parsePage(q.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    const [{ count }] = await this.db.query(
      `WITH report_rows AS (${definition.sql}) SELECT count(*)::int count FROM report_rows`,
      definition.params,
    );
    const items = await this.db.query(
      `WITH report_rows AS (${definition.sql})
       SELECT * FROM report_rows ORDER BY ${definition.orderBy}
       LIMIT $${definition.params.length + 1} OFFSET $${definition.params.length + 2}`,
      [...definition.params, pageSize, offset],
    );
    const quantityColumn = ['current', 'low-stock', 'zero-stock', 'defective-stock', 'aging', 'batch-stock', 'warehouse-summary'].includes(type)
      ? 'onHandQty'
      : 'closingQty';
    const unitTotals = await this.db.query(
      `WITH report_rows AS (${definition.sql})
       SELECT COALESCE(unit,'无单位') unit,
         COALESCE(sum(COALESCE("${quantityColumn}"::numeric,0)),0)::numeric(18,4)::text quantity
       FROM report_rows GROUP BY COALESCE(unit,'无单位') ORDER BY 1`,
      definition.params,
    );
    return {
      reportType: type,
      reportName: REPORT_NAMES[type],
      items,
      total: count,
      page,
      pageSize,
      summary: { unitTotals },
    };
  }

  async export(type: string, q: any) {
    const first = await this.report(type, { ...q, page: 1, pageSize: 100 });
    const items = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) {
      const next = await this.report(type, { ...q, page, pageSize: 100 });
      items.push(...next.items);
    }
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet(first.reportName);
    const keys = items.length ? Object.keys(items[0]) : ['message'];
    sheet.columns = keys.map(key => ({ header: this.columnName(key), key, width: 18 }));
    if (items.length) sheet.addRows(items);
    else sheet.addRow({ message: '当前筛选条件下暂无数据' });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: 'A1', to: `${this.columnLetter(keys.length)}1` };
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  name(type: string) {
    if (!REPORT_NAMES[type]) throw new BusinessException('VALIDATION_ERROR', '不支持的库存报表类型', HttpStatus.BAD_REQUEST);
    return REPORT_NAMES[type];
  }

  private definition(type: string, q: any): ReportDefinition {
    this.name(type);
    const params: any[] = [];
    const where: string[] = [];
    const add = (value: any, expression: string) => {
      if (value === undefined || value === '') return;
      params.push(value);
      where.push(expression.replaceAll('?', `$${params.length}`));
    };
    add(q.warehouseId, 'w.id=?');
    add(q.itemId, 'i.id=?');
    if (q.keyword) {
      params.push(`%${q.keyword}%`);
      where.push(`(i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length} OR w.warehouse_code ILIKE $${params.length})`);
    }
    const balanceWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const balanceBase = `
      SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",w.warehouse_type "warehouseType",
        z.id "zoneId",z.code "zoneCode",loc.id "locationId",loc.code "locationCode",
        i.id "itemId",i.item_code "itemCode",i.name "itemName",i.model,i.spec,i.unit,
        b.id "batchId",b.batch_no "batchNo",sb.on_hand_qty::text "onHandQty",
        COALESCE(sb.frozen_qty,0)::text "frozenQty",i.minimum_stock::text "minimumStock",sb.updated_at "updatedAt"
      FROM stock_balances sb
      JOIN warehouses w ON w.id=sb.warehouse_id
      JOIN warehouse_locations loc ON loc.id=sb.location_id
      JOIN warehouse_zones z ON z.id=loc.zone_id
      JOIN items i ON i.id=sb.item_id
      LEFT JOIN inventory_batches b ON b.id=sb.batch_id ${balanceWhere}`;

    if (type === 'current') {
      return {
        sql: `SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
          w.warehouse_type "warehouseType",i.id "itemId",i.item_code "itemCode",i.name "itemName",
          i.model,i.spec,i.unit,i.minimum_stock::text "minimumStock",
          sum(sb.on_hand_qty)::numeric(18,4)::text "onHandQty",
          sum(GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(res.qty,0),0))::numeric(18,4)::text "availableQty",
          sum(COALESCE(sb.frozen_qty,0))::numeric(18,4)::text "frozenQty",
          sum(COALESCE(res.qty,0))::numeric(18,4)::text "reservedQty",
          count(DISTINCT sb.location_id)::int "locationCount",
          count(DISTINCT sb.batch_id)::int "batchCount",
          count(sb.id)::int "inventoryRecordCount",
          CASE
            WHEN sum(sb.on_hand_qty)=0 THEN 'ZERO'
            WHEN sum(sb.on_hand_qty)<=i.minimum_stock THEN 'LOW'
            ELSE 'HEALTHY'
          END "riskStatus",
          max(sb.updated_at) "updatedAt"
        FROM stock_balances sb
        JOIN warehouses w ON w.id=sb.warehouse_id
        JOIN items i ON i.id=sb.item_id
        JOIN warehouse_locations loc ON loc.id=sb.location_id
        JOIN warehouse_zones z ON z.id=loc.zone_id
        LEFT JOIN inventory_batches batch ON batch.id=sb.batch_id
        LEFT JOIN (
          SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty
          FROM stock_reservations WHERE status='ACTIVE'
          GROUP BY warehouse_id,location_id,item_id,batch_id
        ) res ON res.warehouse_id=sb.warehouse_id AND res.location_id=sb.location_id
          AND res.item_id=sb.item_id AND res.batch_id IS NOT DISTINCT FROM sb.batch_id
        ${balanceWhere}
        GROUP BY w.id,w.warehouse_code,w.name,w.warehouse_type,
          i.id,i.item_code,i.name,i.model,i.spec,i.unit,i.minimum_stock`,
        params,
        orderBy: '"itemCode"',
      };
    }
    if (type === 'low-stock') return { sql: `${balanceBase} ${balanceWhere ? 'AND' : 'WHERE'} sb.on_hand_qty>0 AND sb.on_hand_qty<=i.minimum_stock`, params, orderBy: '"warehouseCode","itemCode"' };
    if (type === 'zero-stock') return { sql: `${balanceBase} ${balanceWhere ? 'AND' : 'WHERE'} sb.on_hand_qty=0`, params, orderBy: '"warehouseCode","itemCode"' };
    if (type === 'defective-stock') return { sql: `${balanceBase} ${balanceWhere ? 'AND' : 'WHERE'} w.warehouse_type='DEFECTIVE' AND sb.on_hand_qty<>0`, params, orderBy: '"warehouseCode","itemCode"' };
    if (type === 'batch-stock') return { sql: `${balanceBase} ${balanceWhere ? 'AND' : 'WHERE'} sb.batch_id IS NOT NULL`, params, orderBy: '"itemCode","batchNo","warehouseCode"' };

    if (type === 'warehouse-summary') {
      return {
        sql: `SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
          count(DISTINCT sb.item_id)::int "itemCount",count(sb.id)::int "inventoryRecordCount",
          count(*) FILTER(WHERE sb.on_hand_qty>0 AND sb.on_hand_qty<=i.minimum_stock)::int "lowStockCount",
          count(*) FILTER(WHERE sb.on_hand_qty=0)::int "zeroStockCount",
          i.unit,sum(sb.on_hand_qty)::numeric(18,4)::text "onHandQty"
          FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id JOIN items i ON i.id=sb.item_id
          ${balanceWhere} GROUP BY w.id,w.warehouse_code,w.name,i.unit`,
        params,
        orderBy: '"warehouseCode",unit',
      };
    }

    if (type === 'aging') {
      return {
        sql: `SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",loc.code "locationCode",
          i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,b.batch_no "batchNo",
          sb.on_hand_qty::text "onHandQty",MAX(t.created_at) FILTER(WHERE t.delta_qty>0) "lastInboundAt",
          MAX(t.created_at) "lastMovementAt",
          COALESCE(EXTRACT(day FROM now()-MAX(t.created_at) FILTER(WHERE t.delta_qty>0)),0)::int "stockAgeDays",
          COALESCE(EXTRACT(day FROM now()-MAX(t.created_at)),0)::int "idleDays"
          FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id
          JOIN warehouse_locations loc ON loc.id=sb.location_id JOIN items i ON i.id=sb.item_id
          LEFT JOIN inventory_batches b ON b.id=sb.batch_id
          LEFT JOIN stock_transactions t ON t.warehouse_id=sb.warehouse_id AND t.location_id=sb.location_id
            AND t.item_id=sb.item_id AND t.batch_id IS NOT DISTINCT FROM sb.batch_id
          ${balanceWhere} ${balanceWhere ? 'AND' : 'WHERE'} sb.on_hand_qty>0
          GROUP BY w.id,w.warehouse_code,loc.code,i.id,i.item_code,i.name,i.unit,b.batch_no,sb.on_hand_qty`,
        params,
        orderBy: '"idleDays" DESC,"itemCode"',
      };
    }

    if (type === 'item-ledger') {
      const fromIndex = q.dateFrom ? (params.push(q.dateFrom), params.length) : 0;
      const toIndex = q.dateTo ? (params.push(q.dateTo), params.length) : 0;
      const movementRange = [
        fromIndex ? `t.created_at >= $${fromIndex}::date` : '',
        toIndex ? `t.created_at < ($${toIndex}::date + interval '1 day')` : '',
      ].filter(Boolean).join(' AND ') || 'true';
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return {
        sql: `SELECT i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,
          ${fromIndex ? `COALESCE(sum(t.delta_qty) FILTER(WHERE t.created_at < $${fromIndex}::date),0)` : '0'}::numeric(18,4)::text "openingQty",
          COALESCE(sum(t.delta_qty) FILTER(WHERE t.delta_qty>0 AND ${movementRange}),0)::numeric(18,4)::text "inQty",
          abs(COALESCE(sum(t.delta_qty) FILTER(WHERE t.delta_qty<0 AND ${movementRange}),0))::numeric(18,4)::text "outQty",
          COALESCE(sum(t.delta_qty) FILTER(WHERE ${toIndex ? `t.created_at < ($${toIndex}::date + interval '1 day')` : 'true'}),0)::numeric(18,4)::text "closingQty"
          FROM stock_transactions t JOIN warehouses w ON w.id=t.warehouse_id JOIN items i ON i.id=t.item_id
          ${clause} GROUP BY i.id,i.item_code,i.name,i.unit`,
        params,
        orderBy: '"itemCode"',
      };
    }

    const txWhere = [...where];
    if (q.dateFrom) {
      params.push(q.dateFrom);
      txWhere.push(`t.created_at >= $${params.length}::date`);
    }
    if (q.dateTo) {
      params.push(q.dateTo);
      txWhere.push(`t.created_at < ($${params.length}::date + interval '1 day')`);
    }
    const txClause = txWhere.length ? `WHERE ${txWhere.join(' AND ')}` : '';
    if (type === 'movement-summary') {
      return {
        sql: `SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,
          sum(t.delta_qty) FILTER(WHERE t.delta_qty>0)::numeric(18,4)::text "inQty",
          abs(sum(t.delta_qty) FILTER(WHERE t.delta_qty<0))::numeric(18,4)::text "outQty",
          sum(t.delta_qty)::numeric(18,4)::text "closingQty",count(*)::int "movementCount"
          FROM stock_transactions t JOIN warehouses w ON w.id=t.warehouse_id JOIN items i ON i.id=t.item_id
          ${txClause} GROUP BY w.id,w.warehouse_code,i.id,i.item_code,i.name,i.unit`,
        params,
        orderBy: '"warehouseCode","itemCode"',
      };
    }
    return {
      sql: `SELECT po.id "productionOrderId",po.order_no "productionOrderNo",fg.item_code "outputItemCode",
        i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,
        sum(CASE WHEN d.document_type='PRODUCTION_ISSUE' THEN l.quantity ELSE 0 END)::numeric(18,4)::text "issuedQty",
        sum(CASE WHEN d.document_type='PRODUCTION_RETURN' THEN l.quantity ELSE 0 END)::numeric(18,4)::text "returnedQty",
        sum(CASE WHEN d.document_type='PRODUCTION_ISSUE' THEN l.quantity ELSE -l.quantity END)::numeric(18,4)::text "closingQty"
        FROM stock_document_lines l JOIN stock_documents d ON d.id=l.document_id
        JOIN production_orders po ON po.id=d.production_order_id JOIN items fg ON fg.id=po.finished_good_id
        JOIN items i ON i.id=l.item_id JOIN warehouses w ON w.id=COALESCE(l.source_warehouse_id,d.warehouse_id)
        ${txClause.replaceAll('t.created_at', 'd.posted_at')} ${txClause ? 'AND' : 'WHERE'}
          d.status='POSTED' AND d.document_type IN ('PRODUCTION_ISSUE','PRODUCTION_RETURN')
        GROUP BY po.id,po.order_no,fg.item_code,i.id,i.item_code,i.name,i.unit`,
      params,
      orderBy: '"productionOrderNo","itemCode"',
    };
  }

  private columnName(key: string) {
    const names: Record<string, string> = {
      warehouseCode: '仓库编码', warehouseName: '仓库名称', zoneCode: '库区', locationCode: '库位',
      itemCode: '物料编码', itemName: '物料名称', model: '型号', spec: '规格', unit: '单位',
      batchNo: '批次', onHandQty: '当前库存', frozenQty: '冻结数量', minimumStock: '安全库存',
      availableQty: '可用库存', reservedQty: '预占库存', locationCount: '库位数',
      batchCount: '批次数', inventoryRecordCount: '库存记录', riskStatus: '库存状态',
      inQty: '入库数量', outQty: '出库数量', openingQty: '期初数量', closingQty: '结存数量',
      itemCount: '物料种类', lowStockCount: '低库存', zeroStockCount: '零库存',
      lastInboundAt: '最近入库', lastMovementAt: '最近变动', stockAgeDays: '库龄（天）', idleDays: '呆滞（天）',
      productionOrderNo: '生产任务', outputItemCode: '产出物料', issuedQty: '领料数量', returnedQty: '退料数量',
    };
    return names[key] || key;
  }

  private columnLetter(count: number) {
    let value = '';
    for (let n = count; n > 0; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + ((n - 1) % 26)) + value;
    return value;
  }
}
