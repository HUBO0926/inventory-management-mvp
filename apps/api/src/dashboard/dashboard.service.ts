import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DashboardService {
  constructor(private readonly db: DataSource) {}

  async summary() {
    const cockpit = await this.cockpit(14);
    return {
      materialCount: cockpit.kpis.materialSkuCount,
      finishedGoodCount: cockpit.kpis.finishedGoodSkuCount,
      warningCount: cockpit.kpis.inventoryRiskSkuCount,
      activeProductionCount: cockpit.kpis.activeProductionOrderCount,
      recentTransactions: cockpit.recentTransactions,
    };
  }

  async cockpit(days: number) {
    const [kpiRows, inventoryHealth, movementTrend, productionStatus, riskItems, recentTransactions] =
      await Promise.all([
        this.db.query(`
          SELECT
            count(*) FILTER (WHERE i.item_type='MATERIAL')::int AS "materialSkuCount",
            count(*) FILTER (WHERE i.item_type='FINISHED_GOOD')::int AS "finishedGoodSkuCount",
            count(*) FILTER (WHERE COALESCE(b.on_hand_qty,0)=0 OR COALESCE(b.on_hand_qty,0)<=i.minimum_stock)::int AS "inventoryRiskSkuCount",
            (SELECT count(*)::int FROM production_orders WHERE status IN ('RELEASED','IN_PROGRESS')) AS "activeProductionOrderCount",
            (SELECT count(*)::int FROM stock_documents WHERE posted_at>=CURRENT_DATE AND status IN ('POSTED','VOIDED')) AS "todayPostedDocumentCount"
          FROM items i
          JOIN warehouses w ON w.warehouse_code=CASE WHEN i.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
          LEFT JOIN (SELECT warehouse_id,item_id,sum(on_hand_qty) on_hand_qty FROM stock_balances GROUP BY warehouse_id,item_id) b ON b.warehouse_id=w.id AND b.item_id=i.id
          WHERE i.status='ACTIVE'
        `),
        this.db.query(`
          SELECT w.warehouse_code "warehouseCode",w.name "warehouseName",
            count(*) FILTER (WHERE COALESCE(b.on_hand_qty,0)>i.minimum_stock)::int "healthySkuCount",
            count(*) FILTER (WHERE COALESCE(b.on_hand_qty,0)>0 AND COALESCE(b.on_hand_qty,0)<=i.minimum_stock)::int "lowSkuCount",
            count(*) FILTER (WHERE COALESCE(b.on_hand_qty,0)=0)::int "zeroSkuCount"
          FROM items i
          JOIN warehouses w ON w.warehouse_code=CASE WHEN i.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
          LEFT JOIN (SELECT warehouse_id,item_id,sum(on_hand_qty) on_hand_qty FROM stock_balances GROUP BY warehouse_id,item_id) b ON b.warehouse_id=w.id AND b.item_id=i.id
          WHERE i.status='ACTIVE' AND w.status='ACTIVE'
          GROUP BY w.warehouse_code,w.name ORDER BY w.warehouse_code DESC
        `),
        this.db.query(`
          WITH dates AS (
            SELECT generate_series(CURRENT_DATE-($1::int-1),CURRENT_DATE,interval '1 day')::date AS report_day
          )
          SELECT to_char(dates.report_day,'YYYY-MM-DD') date,
            count(sd.id) FILTER (WHERE sd.document_type='MATERIAL_INBOUND')::int "inboundDocumentCount",
            count(sd.id) FILTER (WHERE sd.document_type='FINISHED_INBOUND')::int "finishedInboundDocumentCount",
            count(sd.id) FILTER (WHERE sd.document_type='FINISHED_OUTBOUND')::int "outboundDocumentCount",
            count(sd.id) FILTER (WHERE sd.document_type IN ('PRODUCTION_ISSUE','PRODUCTION_RETURN','PRODUCTION_COMPLETION'))::int "productionDocumentCount",
            count(sd.id) FILTER (WHERE sd.document_type='INVENTORY_ADJUSTMENT')::int "adjustmentDocumentCount",
            count(sd.id) FILTER (WHERE sd.document_type='REVERSAL')::int "reversalDocumentCount"
          FROM dates LEFT JOIN stock_documents sd
            ON sd.posted_at>=dates.report_day AND sd.posted_at<dates.report_day+interval '1 day'
            AND sd.status IN ('POSTED','VOIDED')
          GROUP BY dates.report_day ORDER BY dates.report_day
        `, [days]),
        this.db.query(`
          WITH statuses(status,sort_order) AS (VALUES
            ('DRAFT',1),('RELEASED',2),('IN_PROGRESS',3),('COMPLETED',4),('CANCELLED',5)
          )
          SELECT statuses.status,count(o.id)::int count
          FROM statuses LEFT JOIN production_orders o ON o.status=statuses.status
          GROUP BY statuses.status,statuses.sort_order ORDER BY statuses.sort_order
        `),
        this.db.query(`
          SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
            i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,
            COALESCE(b.on_hand_qty,0) "onHandQty",i.minimum_stock "minimumStock",
            CASE WHEN COALESCE(b.on_hand_qty,0)=0 THEN 'ZERO' ELSE 'LOW' END "riskLevel"
          FROM items i
          JOIN warehouses w ON w.warehouse_code=CASE WHEN i.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
          LEFT JOIN (SELECT warehouse_id,item_id,sum(on_hand_qty) on_hand_qty FROM stock_balances GROUP BY warehouse_id,item_id) b ON b.warehouse_id=w.id AND b.item_id=i.id
          WHERE i.status='ACTIVE' AND (COALESCE(b.on_hand_qty,0)=0 OR COALESCE(b.on_hand_qty,0)<=i.minimum_stock)
          ORDER BY CASE WHEN COALESCE(b.on_hand_qty,0)=0 THEN 0 ELSE 1 END,
            CASE WHEN i.minimum_stock=0 THEN 0 ELSE COALESCE(b.on_hand_qty,0)/i.minimum_stock END,i.item_code
          LIMIT 8
        `),
        this.db.query(`
          SELECT t.id,t.created_at "createdAt",w.warehouse_code "warehouseCode",
            i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,
            t.delta_qty "deltaQty",t.balance_after "balanceAfter",
            d.id "documentId",d.document_no "documentNo",d.document_type "documentType",
            u.name "operatorName"
          FROM stock_transactions t
          JOIN warehouses w ON w.id=t.warehouse_id
          JOIN items i ON i.id=t.item_id
          JOIN stock_documents d ON d.id=t.source_document_id
          JOIN users u ON u.id=t.created_by
          ORDER BY t.created_at DESC,t.id DESC LIMIT 10
        `),
      ]);

    return {
      kpis: kpiRows[0] || {
        materialSkuCount: 0,
        finishedGoodSkuCount: 0,
        inventoryRiskSkuCount: 0,
        activeProductionOrderCount: 0,
        todayPostedDocumentCount: 0,
      },
      inventoryHealth,
      movementTrend,
      productionStatus,
      riskItems,
      recentTransactions,
    };
  }
}
