import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser, Role } from '../common/constants';

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

  async integratedCockpit(
    query: {
      warehouseId?: string; inventoryType?: string; period?: string; productionStatus?: string;
      keyword?: string; inventoryStatus?: string; categoryId?: string; dateFrom?: string; dateTo?: string;
      rawPage?: number; finishedPage?: number; pageSize?: number;
    },
    user: AuthUser,
  ) {
    const warehouseId = query.warehouseId || null;
    const inventoryType = query.inventoryType || 'ALL';
    const days = query.period === 'TODAY' ? 1 : query.period === '30D' ? 30 : 7;
    const productionStatus = query.productionStatus || 'ALL';
    const keyword = query.keyword?.trim() || null;
    const inventoryStatus = query.inventoryStatus || 'ALL';
    const categoryId = query.categoryId || null;
    const rawPage = Math.max(1, Number(query.rawPage || 1));
    const finishedPage = Math.max(1, Number(query.finishedPage || 1));
    const pageSize = Math.min(20, Math.max(1, Number(query.pageSize || 5)));
    const dateFrom = query.dateFrom || null;
    const dateTo = query.dateTo || null;
    const inventoryParams = [warehouseId, inventoryType];
    const productionParams = [productionStatus];
    const capabilities = this.capabilities(user);

    const [
      warehouses,
      inventoryByUnit,
      inventoryMetaRows,
      warehouseRows,
      riskItems,
      pendingApprovals,
      productionTasks,
      materialRows,
      todayRows,
      trendRows,
      recentDocuments,
    ] = await Promise.all([
      this.db.query(`
        SELECT id,warehouse_code "warehouseCode",COALESCE(display_name,name) name,warehouse_type "warehouseType"
        FROM warehouses
        WHERE status='ACTIVE' AND deleted_at IS NULL
        ORDER BY warehouse_type,warehouse_code
      `),
      this.db.query(`
        WITH reserved AS (
          SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) quantity
          FROM stock_reservations WHERE status='ACTIVE'
          GROUP BY warehouse_id,location_id,item_id,batch_id
        )
        SELECT i.unit,
          COALESCE(sum(sb.on_hand_qty),0)::text "actualQty",
          COALESCE(sum(CASE WHEN w.warehouse_type='DEFECTIVE' THEN 0
            ELSE GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.quantity,0),0) END),0)::text "availableQty"
        FROM stock_balances sb
        JOIN warehouses w ON w.id=sb.warehouse_id
        JOIN items i ON i.id=sb.item_id
        LEFT JOIN reserved r ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id
          AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
        WHERE w.status='ACTIVE' AND w.deleted_at IS NULL
          AND ($1::uuid IS NULL OR w.id=$1)
          AND (($2='ALL' AND w.warehouse_type IN ('RAW','FG')) OR ($2<>'ALL' AND w.warehouse_type=$2))
        GROUP BY i.unit ORDER BY i.unit
      `, inventoryParams),
      this.db.query(`
        SELECT
          count(DISTINCT sb.item_id) FILTER(WHERE sb.on_hand_qty>0)::int "inventorySkuCount",
          count(DISTINCT l.id) FILTER(WHERE l.status='ACTIVE' AND l.is_archived=false)::int "totalLocations",
          count(DISTINCT l.id) FILTER(WHERE l.status='ACTIVE' AND l.is_archived=false AND sb.on_hand_qty>0)::int "occupiedLocations",
          (SELECT count(*)::int FROM defective_inventory_lots lot
            JOIN warehouses dw ON dw.id=lot.warehouse_id
            WHERE lot.status='OPEN' AND lot.remaining_qty>0
              AND ($1::uuid IS NULL OR dw.id=$1)
              AND ($2 IN ('ALL','DEFECTIVE'))) "pendingDefectiveCount",
          (SELECT count(*)::int FROM production_orders po
            WHERE po.status IN ('RELEASED','AWAITING_ISSUE','IN_PROGRESS','AWAITING_COMPLETION')) "inProgressTaskCount",
          (SELECT count(*)::int FROM production_orders po
            WHERE po.shortage_flag=true AND po.status IN ('DRAFT','RELEASED','AWAITING_ISSUE','IN_PROGRESS')) "shortageTaskCount",
          (SELECT count(*)::int FROM stock_documents d
            WHERE d.status='SUBMITTED' AND d.deleted_at IS NULL) "pendingApprovalCount"
          ,(SELECT count(*)::int
            FROM items ri
            JOIN warehouses rw ON rw.warehouse_type=CASE WHEN ri.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
            LEFT JOIN (SELECT warehouse_id,item_id,sum(on_hand_qty) quantity FROM stock_balances GROUP BY warehouse_id,item_id) rb
              ON rb.warehouse_id=rw.id AND rb.item_id=ri.id
            WHERE ri.status='ACTIVE' AND ri.deleted_at IS NULL AND rw.status='ACTIVE' AND rw.deleted_at IS NULL
              AND ($1::uuid IS NULL OR rw.id=$1)
              AND ($2='ALL' OR rw.warehouse_type=$2)
              AND COALESCE(rb.quantity,0)>0 AND COALESCE(rb.quantity,0)<=ri.minimum_stock) "lowStockCount"
          ,(SELECT count(*)::int
            FROM items zi
            JOIN warehouses zw ON zw.warehouse_type=CASE WHEN zi.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
            LEFT JOIN (SELECT warehouse_id,item_id,sum(on_hand_qty) quantity FROM stock_balances GROUP BY warehouse_id,item_id) zb
              ON zb.warehouse_id=zw.id AND zb.item_id=zi.id
            WHERE zi.status='ACTIVE' AND zi.deleted_at IS NULL AND zw.status='ACTIVE' AND zw.deleted_at IS NULL
              AND ($1::uuid IS NULL OR zw.id=$1)
              AND ($2='ALL' OR zw.warehouse_type=$2)
              AND COALESCE(zb.quantity,0)=0) "zeroStockCount"
        FROM warehouses w
        LEFT JOIN warehouse_locations l ON l.warehouse_id=w.id AND l.is_archived=false
        LEFT JOIN stock_balances sb ON sb.warehouse_id=w.id AND sb.location_id=l.id
        WHERE w.status='ACTIVE' AND w.deleted_at IS NULL
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
      `, inventoryParams),
      this.db.query(`
        SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",COALESCE(w.display_name,w.name) "warehouseName",
          w.warehouse_type "warehouseType",i.unit,
          COALESCE(sum(sb.on_hand_qty),0)::text quantity,
          (SELECT count(DISTINCT sb2.item_id)::int FROM stock_balances sb2
            WHERE sb2.warehouse_id=w.id AND sb2.on_hand_qty>0) "skuCount",
          (SELECT count(DISTINCT sb3.location_id)::int FROM stock_balances sb3
            WHERE sb3.warehouse_id=w.id AND sb3.on_hand_qty>0) "occupiedLocationCount",
          COALESCE(lot."pendingDefectiveCount",0)::int "pendingDefectiveCount"
        FROM warehouses w
        LEFT JOIN stock_balances sb ON sb.warehouse_id=w.id
        LEFT JOIN items i ON i.id=sb.item_id
        LEFT JOIN (
          SELECT warehouse_id,count(*)::int "pendingDefectiveCount"
          FROM defective_inventory_lots WHERE status='OPEN' AND remaining_qty>0 GROUP BY warehouse_id
        ) lot ON lot.warehouse_id=w.id
        WHERE w.status='ACTIVE' AND w.deleted_at IS NULL
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
        GROUP BY w.id,i.unit,lot."pendingDefectiveCount" ORDER BY w.warehouse_type,w.warehouse_code,i.unit
      `, inventoryParams),
      this.db.query(`
        WITH balances AS (
          SELECT warehouse_id,item_id,sum(on_hand_qty) quantity
          FROM stock_balances GROUP BY warehouse_id,item_id
        )
        SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",i.id "itemId",
          i.item_code "itemCode",i.name "itemName",i.unit,
          COALESCE(b.quantity,0)::text "onHandQty",i.minimum_stock::text "minimumStock",
          CASE WHEN COALESCE(b.quantity,0)=0 THEN 'ZERO' ELSE 'LOW' END "riskLevel"
        FROM items i
        JOIN warehouses w ON w.warehouse_type=CASE WHEN i.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
        LEFT JOIN balances b ON b.warehouse_id=w.id AND b.item_id=i.id
        WHERE i.status='ACTIVE' AND i.deleted_at IS NULL AND w.status='ACTIVE' AND w.deleted_at IS NULL
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
          AND COALESCE(b.quantity,0)<=i.minimum_stock
        ORDER BY CASE WHEN COALESCE(b.quantity,0)=0 THEN 0 ELSE 1 END,i.item_code
        LIMIT 8
      `, inventoryParams),
      this.db.query(`
        SELECT d.id,d.document_no "documentNo",d.document_type "documentType",
          COALESCE(d.submitted_at,d.created_at) "submittedAt",u.name "createdByName"
        FROM stock_documents d JOIN users u ON u.id=d.created_by
        WHERE d.status='SUBMITTED' AND d.deleted_at IS NULL
          AND ($1::uuid IS NULL OR d.warehouse_id=$1)
        ORDER BY COALESCE(d.submitted_at,d.created_at) DESC LIMIT 5
      `, [warehouseId]),
      this.db.query(`
        SELECT po.id,po.order_no "orderNo",po.status,po.planned_qty::text "plannedQty",
          po.completed_qty::text "completedQty",
          GREATEST(po.planned_qty-po.completed_qty,0)::text "remainingQty",
          CASE WHEN po.planned_qty=0 THEN 0 ELSE round(po.completed_qty*100.0/po.planned_qty)::int END progress,
          po.shortage_flag "shortageFlag",po.planned_date "plannedDate",
          COALESCE(po.responsible_name,po.responsible_username) "responsibleName",
          (po.planned_date < timezone('Asia/Shanghai',now())::date
            AND po.status NOT IN ('COMPLETED','CLOSED','CANCELLED')) "delayed",
          COALESCE((SELECT sum(a.quantity) FROM stock_documents d
            JOIN stock_document_lines dl ON dl.document_id=d.id
            JOIN stock_document_receipt_allocations a ON a.document_line_id=dl.id
            WHERE d.production_order_id=po.id AND d.document_type='PRODUCTION_COMPLETION'
              AND d.status='POSTED' AND a.disposition='DEFECTIVE'),0)::text "defectiveQty",
          i.item_code "itemCode",i.name "itemName",i.unit
        FROM production_orders po JOIN items i ON i.id=po.finished_good_id
        WHERE ($1='ALL' OR po.status=$1)
        ORDER BY CASE WHEN po.status IN ('IN_PROGRESS','AWAITING_COMPLETION') THEN 0 ELSE 1 END,po.created_at DESC
      `, productionParams),
      this.db.query(`
        WITH reserved AS (
          SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) quantity
          FROM stock_reservations WHERE status='ACTIVE'
          GROUP BY warehouse_id,location_id,item_id,batch_id
        ), available AS (
          SELECT sb.item_id,sum(GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.quantity,0),0)) quantity
          FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id
          LEFT JOIN reserved r ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id
            AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
          WHERE w.warehouse_type='RAW' AND w.status='ACTIVE' AND w.deleted_at IS NULL
          GROUP BY sb.item_id
        )
        SELECT po.id "productionOrderId",po.order_no "orderNo",i.id "itemId",i.item_code "itemCode",
          i.name "itemName",i.unit,pm.required_qty::text "requiredQty",
          GREATEST(pm.issued_qty-pm.returned_qty,0)::text "netIssuedQty",
          COALESCE(a.quantity,0)::text "availableQty",
          GREATEST(pm.required_qty-(pm.issued_qty-pm.returned_qty)-COALESCE(a.quantity,0),0)::text "shortageQty"
        FROM production_order_materials pm
        JOIN production_orders po ON po.id=pm.production_order_id
        JOIN items i ON i.id=pm.material_id
        LEFT JOIN available a ON a.item_id=pm.material_id
        WHERE po.status IN ('RELEASED','AWAITING_ISSUE','IN_PROGRESS','AWAITING_COMPLETION')
          AND ($1='ALL' OR po.status=$1)
        ORDER BY GREATEST(pm.required_qty-(pm.issued_qty-pm.returned_qty)-COALESCE(a.quantity,0),0) DESC,po.created_at DESC
        LIMIT 12
      `, productionParams),
      this.db.query(`
        SELECT document_type "documentType",count(*)::int count
        FROM stock_documents d
        JOIN warehouses w ON w.id=d.warehouse_id
        WHERE d.status IN ('POSTED','VOIDED')
          AND d.posted_at >= ((timezone('Asia/Shanghai',now())::date)::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
        GROUP BY document_type
      `, inventoryParams),
      this.db.query(`
        WITH dates AS (
          SELECT generate_series(
            timezone('Asia/Shanghai',now())::date-($3::int-1),
            timezone('Asia/Shanghai',now())::date,
            interval '1 day'
          )::date report_day
        )
        SELECT to_char(d.report_day,'YYYY-MM-DD') date,
          count(DISTINCT t.item_id) FILTER(WHERE w.id IS NOT NULL AND t.delta_qty>0)::int "inboundSkuCount",
          count(DISTINCT t.item_id) FILTER(WHERE w.id IS NOT NULL AND t.delta_qty<0)::int "outboundSkuCount",
          count(DISTINCT t.item_id) FILTER(WHERE w.id IS NOT NULL)::int "changedSkuCount"
        FROM dates d
        LEFT JOIN stock_transactions t
          ON timezone('Asia/Shanghai',t.created_at)::date=d.report_day
        LEFT JOIN warehouses w ON w.id=t.warehouse_id
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
        GROUP BY d.report_day ORDER BY d.report_day
      `, [warehouseId, inventoryType, days]),
      this.db.query(`
        SELECT d.id,d.document_no "documentNo",d.document_type "documentType",d.status,
          d.created_at "createdAt",d.submitted_at "submittedAt",d.posted_at "postedAt",
          w.warehouse_code "warehouseCode",COALESCE(w.display_name,w.name) "warehouseName",
          d.production_order_id "productionOrderId",u.name "submitterName",
          count(DISTINCT dl.id)::int "lineCount",
          COALESCE(jsonb_agg(DISTINCT jsonb_build_object('unit',i.unit,'quantity',dl.quantity))
            FILTER(WHERE dl.id IS NOT NULL),'[]'::jsonb) "quantities",
          GREATEST(0,extract(epoch FROM (now()-COALESCE(d.submitted_at,d.created_at)))/3600)::int "waitingHours"
        FROM stock_documents d JOIN warehouses w ON w.id=d.warehouse_id
        JOIN users u ON u.id=d.created_by
        LEFT JOIN stock_document_lines dl ON dl.document_id=d.id
        LEFT JOIN items i ON i.id=dl.item_id
        WHERE d.deleted_at IS NULL
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
          AND d.created_at >= (
            (timezone('Asia/Shanghai',now())::date-($3::int-1))::timestamp AT TIME ZONE 'Asia/Shanghai'
          )
        GROUP BY d.id,w.warehouse_code,w.display_name,w.name,u.name
        ORDER BY d.created_at DESC LIMIT 8
      `, [warehouseId, inventoryType, days]),
    ]);

    const rangeParams = [warehouseId, inventoryType, days, dateFrom, dateTo];
    const [inventoryCenterRows, qualityRows, todayDetailRows, trendDetailRows] = await Promise.all([
      this.db.query(`
        WITH reserved AS (
          SELECT warehouse_id,item_id,sum(quantity) quantity
          FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,item_id
        ), balances AS (
          SELECT warehouse_id,item_id,sum(on_hand_qty) "currentQty",sum(frozen_qty) "frozenQty"
          FROM stock_balances GROUP BY warehouse_id,item_id
        ), defective AS (
          SELECT item_id,sum(remaining_qty) quantity FROM defective_inventory_lots
          WHERE status='OPEN' AND remaining_qty>0 GROUP BY item_id
        )
        SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",
          COALESCE(w.display_name,w.name) "warehouseName",w.warehouse_type "warehouseType",
          i.id "itemId",i.item_code "itemCode",i.name "itemName",i.model,i.spec,i.unit,
          i.category_id "categoryId",COALESCE(b."currentQty",0)::text "currentQty",
          COALESCE(b."frozenQty",0)::text "frozenQty",COALESCE(r.quantity,0)::text "reservedQty",
          GREATEST(COALESCE(b."currentQty",0)-COALESCE(b."frozenQty",0)-COALESCE(r.quantity,0),0)::text "availableQty",
          i.minimum_stock::text "minimumStock",
          GREATEST(i.minimum_stock-GREATEST(COALESCE(b."currentQty",0)-COALESCE(b."frozenQty",0)-COALESCE(r.quantity,0),0),0)::text "shortageQty",
          COALESCE(df.quantity,0)::text "defectivePendingQty"
        FROM warehouses w
        JOIN items i ON w.warehouse_type=CASE WHEN i.item_type='MATERIAL' THEN 'RAW' ELSE 'FG' END
        LEFT JOIN balances b ON b.warehouse_id=w.id AND b.item_id=i.id
        LEFT JOIN reserved r ON r.warehouse_id=w.id AND r.item_id=i.id
        LEFT JOIN defective df ON df.item_id=i.id
        WHERE w.status='ACTIVE' AND w.deleted_at IS NULL AND w.warehouse_type IN ('RAW','FG')
          AND i.status='ACTIVE' AND i.deleted_at IS NULL
          AND ($1::uuid IS NULL OR w.id=$1)
          AND ($2='ALL' OR w.warehouse_type=$2)
          AND ($3::uuid IS NULL OR i.category_id=$3)
          AND ($4::text IS NULL OR i.item_code ILIKE '%'||$4||'%' OR i.name ILIKE '%'||$4||'%'
            OR COALESCE(i.model,'') ILIKE '%'||$4||'%' OR COALESCE(i.spec,'') ILIKE '%'||$4||'%')
        ORDER BY w.warehouse_type,
          CASE WHEN COALESCE(b."currentQty",0)=0 THEN 0
               WHEN GREATEST(COALESCE(b."currentQty",0)-COALESCE(b."frozenQty",0)-COALESCE(r.quantity,0),0)<=i.minimum_stock THEN 1
               WHEN COALESCE(df.quantity,0)>0 THEN 2 ELSE 3 END,
          i.item_code
      `, [warehouseId, inventoryType, categoryId, keyword]),
      this.db.query(`
        SELECT CASE WHEN d.document_type='MATERIAL_INBOUND' THEN 'MATERIAL' ELSE 'PRODUCTION' END scope,
          i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,
          po.id "productionOrderId",po.order_no "orderNo",a.disposition,
          COALESCE(NULLIF(trim(a.defect_reason),''),'未说明原因') "defectReason",
          sum(a.quantity)::text quantity,
          to_char(timezone('Asia/Shanghai',COALESCE(d.posted_at,d.updated_at)),'YYYY-MM-DD') date
        FROM stock_documents d
        JOIN stock_document_lines dl ON dl.document_id=d.id
        JOIN stock_document_receipt_allocations a ON a.document_line_id=dl.id
        JOIN items i ON i.id=dl.item_id
        LEFT JOIN production_orders po ON po.id=d.production_order_id
        WHERE d.status='POSTED'
          AND d.document_type IN ('MATERIAL_INBOUND','PRODUCTION_COMPLETION')
          AND ($1::uuid IS NULL OR d.warehouse_id=$1)
          AND ($2::text IS NULL OR i.item_code ILIKE '%'||$2||'%' OR i.name ILIKE '%'||$2||'%'
            OR po.order_no ILIKE '%'||$2||'%')
          AND COALESCE(d.posted_at,d.updated_at) >=
            (timezone('Asia/Shanghai',now())::date-($3::int-1))::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND COALESCE(d.posted_at,d.updated_at) <
            (timezone('Asia/Shanghai',now())::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'
        GROUP BY scope,i.id,po.id,po.order_no,a.disposition,a.defect_reason,date
        ORDER BY date
      `, [warehouseId, keyword, days]),
      this.db.query(`
        SELECT d.document_type "documentType",d.status,i.unit,
          count(DISTINCT d.id)::int "documentCount",COALESCE(sum(dl.quantity),0)::text quantity
        FROM stock_documents d
        LEFT JOIN stock_document_lines dl ON dl.document_id=d.id
        LEFT JOIN items i ON i.id=dl.item_id
        WHERE d.deleted_at IS NULL
          AND COALESCE(d.posted_at,d.submitted_at,d.updated_at) >=
            (timezone('Asia/Shanghai',now())::date)::timestamp AT TIME ZONE 'Asia/Shanghai'
          AND ($1::uuid IS NULL OR d.warehouse_id=$1)
          AND ($2='ALL' OR EXISTS(SELECT 1 FROM warehouses tw WHERE tw.id=d.warehouse_id AND tw.warehouse_type=$2))
        GROUP BY d.document_type,d.status,i.unit
      `, inventoryParams),
      this.db.query(`
        SELECT to_char(timezone('Asia/Shanghai',t.created_at),'YYYY-MM-DD') date,
          d.document_type "documentType",i.unit,
          sum(abs(t.delta_qty))::text quantity,count(DISTINCT t.item_id)::int "skuCount",
          count(DISTINCT d.id)::int "documentCount",
          count(DISTINCT d.production_order_id) FILTER(WHERE d.production_order_id IS NOT NULL)::int "taskCount"
        FROM stock_transactions t
        JOIN stock_documents d ON d.id=t.source_document_id
        JOIN warehouses w ON w.id=t.warehouse_id
        JOIN items i ON i.id=t.item_id
        WHERE ($1::uuid IS NULL OR w.id=$1) AND ($2='ALL' OR w.warehouse_type=$2)
          AND t.created_at >= COALESCE($4::date::timestamp AT TIME ZONE 'Asia/Shanghai',
            (timezone('Asia/Shanghai',now())::date-($3::int-1))::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND t.created_at < COALESCE(($5::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai',
            (timezone('Asia/Shanghai',now())::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
        GROUP BY date,d.document_type,i.unit ORDER BY date,d.document_type,i.unit
      `, rangeParams),
    ]);

    const inventoryMeta = inventoryMetaRows[0] || {};
    const warehouseSummaries = this.warehouseSummaries(warehouseRows);
    const todayOperations = Object.fromEntries(todayRows.map((row: any) => [row.documentType, Number(row.count)]));
    const shortageMaterials = materialRows.filter((row: any) => Number(row.shortageQty) > 0);
    const relevantMaterials = materialRows.length;
    const readyMaterials = materialRows.filter((row: any) => Number(row.shortageQty) === 0).length;
    const progressTasks = productionStatus === 'ALL'
      ? productionTasks.filter((row: any) => ['RELEASED', 'AWAITING_ISSUE', 'IN_PROGRESS', 'AWAITING_COMPLETION'].includes(row.status))
      : productionTasks;
    const inventoryCenters = {
      raw: this.inventoryCenter(inventoryCenterRows, 'RAW', rawPage, pageSize, inventoryStatus),
      finished: this.inventoryCenter(inventoryCenterRows, 'FG', finishedPage, pageSize, inventoryStatus),
    };
    const materialQuality = this.qualitySummary(qualityRows, 'MATERIAL', 'MATERIAL');
    const productionQuality = this.qualitySummary(qualityRows, 'PRODUCTION', 'PRODUCTION');
    const todayOperationDetails = this.todayOperationDetails(todayDetailRows);
    const riskCenter = this.riskCenter(
      inventoryCenters,
      productionTasks,
      pendingApprovals,
      Number(inventoryMeta.pendingDefectiveCount || 0),
      materialQuality,
      productionQuality,
    );
    const productionStatusCounts = productionTasks.reduce((map: Record<string, number>, row: any) => {
      map[row.status] = (map[row.status] || 0) + 1;
      return map;
    }, {});

    return {
      generatedAt: new Date().toISOString(),
      scopeLabel: user.role === Role.ADMIN ? '全部数据范围' : user.role === Role.WAREHOUSE ? '仓储业务范围' : '生产业务范围',
      capabilities,
      filterOptions: {
        warehouses: capabilities.warehouse || capabilities.inventory ? warehouses : [],
        inventoryTypes: ['ALL', 'RAW', 'FG', 'DEFECTIVE'],
        periods: ['TODAY', '7D', '30D'],
        productionStatuses: ['ALL', 'DRAFT', 'RELEASED', 'AWAITING_ISSUE', 'IN_PROGRESS', 'AWAITING_COMPLETION', 'COMPLETED', 'CLOSED', 'CANCELLED'],
        inventoryStatuses: ['ALL', 'NORMAL', 'LOW', 'ZERO', 'LOCKED', 'DEFECTIVE'],
      },
      kpis: {
        inventoryByUnit: capabilities.inventory ? inventoryByUnit : [],
        availableByUnit: capabilities.inventory ? inventoryByUnit.map((row: any) => ({ unit: row.unit, quantity: row.availableQty })) : [],
        inventorySkuCount: capabilities.inventory ? Number(inventoryMeta.inventorySkuCount || 0) : null,
        totalLocations: capabilities.warehouse ? Number(inventoryMeta.totalLocations || 0) : null,
        occupiedLocations: capabilities.warehouse ? Number(inventoryMeta.occupiedLocations || 0) : null,
        locationUsageRate: capabilities.warehouse && Number(inventoryMeta.totalLocations)
          ? Number(((Number(inventoryMeta.occupiedLocations) / Number(inventoryMeta.totalLocations)) * 100).toFixed(1))
          : capabilities.warehouse ? 0 : null,
        lowStockCount: capabilities.inventory ? Number(inventoryMeta.lowStockCount || 0) : null,
        zeroStockCount: capabilities.inventory ? Number(inventoryMeta.zeroStockCount || 0) : null,
        pendingDefectiveCount: capabilities.defective ? Number(inventoryMeta.pendingDefectiveCount || 0) : null,
        inProgressTaskCount: capabilities.production ? Number(inventoryMeta.inProgressTaskCount || 0) : null,
        shortageTaskCount: capabilities.production ? Number(inventoryMeta.shortageTaskCount || 0) : null,
        pendingApprovalCount: capabilities.approval ? Number(inventoryMeta.pendingApprovalCount || 0) : null,
        rawItemCount: capabilities.inventory ? inventoryCenters.raw.summary.totalItems : null,
        lowRawItemCount: capabilities.inventory ? inventoryCenters.raw.summary.lowItems + inventoryCenters.raw.summary.zeroItems : null,
        finishedItemCount: capabilities.inventory ? inventoryCenters.finished.summary.totalItems : null,
        lowFinishedItemCount: capabilities.inventory ? inventoryCenters.finished.summary.lowItems + inventoryCenters.finished.summary.zeroItems : null,
        productionTaskCount: capabilities.production ? productionTasks.length : null,
        materialDefectRate: capabilities.inventory ? materialQuality.overallRate : null,
        productionDefectRate: capabilities.production ? productionQuality.overallRate : null,
      },
      inventoryCenters: capabilities.inventory ? inventoryCenters : {
        raw: this.inventoryCenter([], 'RAW', 1, pageSize, inventoryStatus),
        finished: this.inventoryCenter([], 'FG', 1, pageSize, inventoryStatus),
      },
      warehouseSummaries: capabilities.inventory ? warehouseSummaries : [],
      risksAndTodos: {
        riskItems: capabilities.inventory ? riskItems : [],
        pendingApprovals: capabilities.approval ? pendingApprovals : [],
      },
      productionExecution: {
        tasks: capabilities.production ? this.attentionTasks(productionTasks).slice(0, 5) : [],
        overallProgress: capabilities.production ? this.overallProgress(progressTasks) : null,
        statusCounts: capabilities.production ? productionStatusCounts : {},
      },
      materialReadiness: {
        readinessRate: capabilities.production && relevantMaterials ? Number(((readyMaterials / relevantMaterials) * 100).toFixed(1)) : capabilities.production ? 100 : null,
        shortageTaskCount: capabilities.production ? Number(inventoryMeta.shortageTaskCount || 0) : null,
        materials: capabilities.production ? materialRows : [],
        shortages: capabilities.production ? shortageMaterials : [],
      },
      todayOperations: capabilities.inventory ? todayOperations : {},
      todayOperationDetails: capabilities.inventory ? todayOperationDetails : [],
      inventoryTrend: capabilities.inventory ? trendRows : [],
      inventoryTrendDetails: capabilities.inventory ? trendDetailRows : [],
      recentDocuments: capabilities.inventory ? recentDocuments : [],
      materialQuality: capabilities.inventory ? materialQuality : null,
      productionQuality: capabilities.production ? productionQuality : null,
      riskCenter: capabilities.dashboard ? riskCenter : { summary: {}, items: [] },
      dataGaps: ['返工数量', '报废数量', '供应商', '独立检验时间', '计划开始/完成双日期'],
    };
  }

  private capabilities(user: AuthUser) {
    const allowed = (...codes: string[]) => user.role === Role.ADMIN || codes.some(code => user.permissions?.includes(code));
    const inventory = allowed('stock.view', 'inventory.view', 'inventory.report.view');
    const warehouse = allowed('warehouse.virtual.view', 'master.view');
    const production = allowed('production.view');
    const approval = allowed('approval.view-own', 'approval.statistics');
    const defective = allowed('approval.defective.view', 'approval.defective.process');
    return { dashboard: inventory || warehouse || production || approval || defective, inventory, warehouse, production, approval, defective };
  }

  private warehouseSummaries(rows: any[]) {
    const map = new Map<string, any>();
    for (const row of rows) {
      const current = map.get(row.warehouseType) || {
        warehouseId: row.warehouseId,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        warehouseType: row.warehouseType,
        stockByUnit: [],
        skuCount: 0,
        occupiedLocationCount: 0,
        pendingDefectiveCount: 0,
      };
      if (row.unit) current.stockByUnit.push({ unit: row.unit, quantity: row.quantity });
      current.skuCount = Math.max(current.skuCount, Number(row.skuCount || 0));
      current.occupiedLocationCount = Math.max(current.occupiedLocationCount, Number(row.occupiedLocationCount || 0));
      current.pendingDefectiveCount = Math.max(current.pendingDefectiveCount, Number(row.pendingDefectiveCount || 0));
      map.set(row.warehouseType, current);
    }
    return ['RAW', 'FG', 'DEFECTIVE'].map(type => map.get(type)).filter(Boolean);
  }

  private overallProgress(tasks: any[]) {
    const planned = tasks.reduce((sum, row) => sum + Number(row.plannedQty || 0), 0);
    const completed = tasks.reduce((sum, row) => sum + Number(row.completedQty || 0), 0);
    return planned ? Number(((completed / planned) * 100).toFixed(1)) : 0;
  }

  private inventoryCenter(rows: any[], type: 'RAW' | 'FG', page: number, pageSize: number, status: string) {
    const normalized = rows.filter(row => row.warehouseType === type).map(row => {
      const current = Number(row.currentQty || 0);
      const available = Number(row.availableQty || 0);
      const minimum = Number(row.minimumStock || 0);
      const frozen = Number(row.frozenQty || 0);
      const defective = Number(row.defectivePendingQty || 0);
      const inventoryStatus = current === 0 ? 'ZERO'
        : available <= minimum ? 'LOW'
          : frozen > 0 ? 'LOCKED'
            : defective > 0 ? 'DEFECTIVE' : 'NORMAL';
      return { ...row, inventoryStatus };
    });
    const filtered = status === 'ALL' ? normalized : normalized.filter(row => row.inventoryStatus === status);
    const total = filtered.length;
    const safePage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / pageSize)));
    return {
      summary: {
        totalItems: normalized.length,
        stockedItems: normalized.filter(row => Number(row.currentQty) > 0).length,
        zeroItems: normalized.filter(row => row.inventoryStatus === 'ZERO').length,
        lowItems: normalized.filter(row => row.inventoryStatus === 'LOW').length,
        lockedItems: normalized.filter(row => Number(row.frozenQty) > 0 || Number(row.reservedQty) > 0).length,
        defectiveItems: normalized.filter(row => Number(row.defectivePendingQty) > 0).length,
      },
      rows: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
      pagination: { page: safePage, pageSize, total },
    };
  }

  private qualitySummary(rows: any[], scope: 'MATERIAL' | 'PRODUCTION', envPrefix: string) {
    const scoped = rows.filter(row => row.scope === scope);
    const byUnitMap = new Map<string, { unit: string; inspectedQty: number; normalQty: number; defectiveQty: number }>();
    const topMap = new Map<string, any>();
    const reasonMap = new Map<string, number>();
    for (const row of scoped) {
      const quantity = Number(row.quantity || 0);
      const unit = row.unit || '单位';
      const unitRow = byUnitMap.get(unit) || { unit, inspectedQty: 0, normalQty: 0, defectiveQty: 0 };
      unitRow.inspectedQty += quantity;
      if (row.disposition === 'DEFECTIVE') unitRow.defectiveQty += quantity;
      else unitRow.normalQty += quantity;
      byUnitMap.set(unit, unitRow);
      const key = scope === 'MATERIAL' ? row.itemId : row.productionOrderId || row.itemId;
      const top = topMap.get(key) || {
        id: key, itemId: row.itemId, productionOrderId: row.productionOrderId,
        code: scope === 'MATERIAL' ? row.itemCode : row.orderNo,
        name: row.itemName, unit, normalQty: 0, defectiveQty: 0,
      };
      if (row.disposition === 'DEFECTIVE') {
        top.defectiveQty += quantity;
        reasonMap.set(row.defectReason, (reasonMap.get(row.defectReason) || 0) + quantity);
      } else top.normalQty += quantity;
      topMap.set(key, top);
    }
    const byUnit = [...byUnitMap.values()].map(row => ({
      ...row,
      inspectedQty: String(row.inspectedQty),
      normalQty: String(row.normalQty),
      defectiveQty: String(row.defectiveQty),
      defectRate: row.inspectedQty ? Number((row.defectiveQty * 100 / row.inspectedQty).toFixed(1)) : 0,
    }));
    const thresholds = this.qualityThresholds(envPrefix);
    const overallRate = byUnit.length === 1 ? byUnit[0].defectRate : null;
    const level = overallRate === null || !thresholds.configured ? 'NEUTRAL'
      : overallRate >= Number(thresholds.critical) ? 'CRITICAL'
        : overallRate >= Number(thresholds.warning) ? 'WARNING' : 'NORMAL';
    return {
      byUnit,
      overallRate,
      displayMode: byUnit.length > 1 ? 'BY_UNIT' : 'SINGLE_UNIT',
      level,
      thresholds,
      top: [...topMap.values()].map(row => ({
        ...row,
        inspectedQty: String(row.normalQty + row.defectiveQty),
        normalQty: String(row.normalQty),
        defectiveQty: String(row.defectiveQty),
        defectRate: row.normalQty + row.defectiveQty
          ? Number((row.defectiveQty * 100 / (row.normalQty + row.defectiveQty)).toFixed(1)) : 0,
      })).sort((a, b) => b.defectRate - a.defectRate || b.defectiveQty - a.defectiveQty).slice(0, 5),
      reasons: [...reasonMap.entries()].map(([reason, quantity]) => ({ reason, quantity: String(quantity) }))
        .sort((a, b) => Number(b.quantity) - Number(a.quantity)).slice(0, 3),
    };
  }

  private qualityThresholds(prefix: string) {
    const warning = Number(process.env[`${prefix}_DEFECT_WARNING_PERCENT`]);
    const critical = Number(process.env[`${prefix}_DEFECT_CRITICAL_PERCENT`]);
    const configured = Number.isFinite(warning) && Number.isFinite(critical)
      && warning >= 0 && critical <= 100 && warning < critical;
    return configured ? { configured, warning, critical } : { configured: false, warning: null, critical: null };
  }

  private todayOperationDetails(rows: any[]) {
    const types = ['MATERIAL_INBOUND', 'PRODUCTION_ISSUE', 'PRODUCTION_RETURN', 'FINISHED_INBOUND', 'FINISHED_OUTBOUND', 'STOCK_MOVE', 'INVENTORY_ADJUSTMENT'];
    return types.map(documentType => {
      const matches = rows.filter(row => row.documentType === documentType);
      const posted = matches.filter(row => ['POSTED', 'VOIDED'].includes(row.status));
      return {
        documentType,
        postedDocumentCount: posted.reduce((sum, row) => sum + Number(row.documentCount || 0), 0),
        quantities: posted.filter(row => row.unit).map(row => ({ unit: row.unit, quantity: row.quantity })),
        pendingCount: matches.filter(row => row.status === 'SUBMITTED').reduce((sum, row) => sum + Number(row.documentCount || 0), 0),
        rejectedCount: matches.filter(row => row.status === 'REJECTED').reduce((sum, row) => sum + Number(row.documentCount || 0), 0),
      };
    });
  }

  private attentionTasks(rows: any[]) {
    return [...rows].sort((a, b) => {
      const score = (row: any) => Number(row.shortageFlag) * 100 + Number(row.delayed) * 80
        + Number(row.defectiveQty > 0) * 60 + Number(row.status === 'AWAITING_ISSUE') * 40
        + Number(row.status === 'AWAITING_COMPLETION') * 30;
      return score(b) - score(a);
    });
  }

  private riskCenter(
    centers: any,
    tasks: any[],
    approvals: any[],
    pendingDefective: number,
    materialQuality: any,
    productionQuality: any,
  ) {
    const items: any[] = [];
    for (const center of [centers.raw, centers.finished]) {
      for (const row of center.rows.filter((entry: any) => ['ZERO', 'LOW'].includes(entry.inventoryStatus))) {
        items.push({
          id: `${row.warehouseId}-${row.itemId}`, type: row.inventoryStatus === 'ZERO' ? 'ZERO_STOCK' : 'LOW_STOCK',
          severity: row.inventoryStatus === 'ZERO' ? 'CRITICAL' : 'WARNING',
          title: `${row.itemCode} ${row.itemName}`, description: `${row.warehouseName} · 可用 ${row.availableQty} ${row.unit}`,
          ratio: Number(row.minimumStock) ? Number(row.shortageQty) / Number(row.minimumStock) : 0,
          route: `/inventory/management?tab=current&warehouseId=${row.warehouseId}&itemId=${row.itemId}`,
        });
      }
    }
    for (const task of tasks) {
      if (!task.shortageFlag && !task.delayed && !['AWAITING_ISSUE', 'AWAITING_COMPLETION'].includes(task.status)) continue;
      const type = task.shortageFlag ? 'MATERIAL_SHORTAGE' : task.delayed ? 'DELAYED_TASK'
        : task.status === 'AWAITING_ISSUE' ? 'PENDING_ISSUE' : 'COMPLETION_PENDING';
      items.push({
        id: task.id, type, severity: task.shortageFlag || task.delayed ? 'CRITICAL' : 'TODO',
        title: `${task.orderNo} ${task.itemName}`, description: task.responsibleName || '负责人未指定',
        route: `/production/tasks/${task.id}`,
      });
    }
    for (const approval of approvals) {
      const waitingHours = Math.max(0, Math.floor((Date.now() - new Date(approval.submittedAt).getTime()) / 3600000));
      items.push({
        id: approval.id, type: waitingHours >= 24 ? 'APPROVAL_OVERDUE' : 'PENDING_APPROVAL',
        severity: waitingHours >= 24 ? 'CRITICAL' : 'TODO', waitingHours,
        title: approval.documentNo, description: `等待审核 ${waitingHours} 小时`, route: '/approvals?tab=pendingMine',
      });
    }
    if (pendingDefective > 0) items.push({
      id: 'defective', type: 'DEFECTIVE_PENDING', severity: 'WARNING',
      title: `待处理不良品 ${pendingDefective} 批`, description: '进入审核中心处理', route: '/approvals?mode=defective',
    });
    for (const [type, quality] of [['MATERIAL_QUALITY', materialQuality], ['PRODUCTION_QUALITY', productionQuality]] as const) {
      if (!quality.thresholds.configured || !['WARNING', 'CRITICAL'].includes(quality.level)) continue;
      items.push({
        id: type, type, severity: quality.level, title: type === 'MATERIAL_QUALITY' ? '原材料不良率异常' : '生产不良率异常',
        description: `${quality.overallRate}%`, route: '#quality-center',
      });
    }
    const rank: Record<string, number> = { CRITICAL: 0, WARNING: 1, TODO: 2 };
    items.sort((a, b) => rank[a.severity] - rank[b.severity]
      || Number(b.waitingHours || 0) - Number(a.waitingHours || 0)
      || Number(b.ratio || 0) - Number(a.ratio || 0));
    return {
      summary: {
        critical: items.filter(row => row.severity === 'CRITICAL').length,
        warning: items.filter(row => row.severity === 'WARNING').length,
        todo: items.filter(row => row.severity === 'TODO').length,
        overdue: items.filter(row => row.type === 'APPROVAL_OVERDUE').length,
      },
      items: items.slice(0, 20),
    };
  }
}
