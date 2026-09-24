import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { AuthUser } from '../common/constants';
import { snapshotUser } from '../common/snapshot';
import { parsePage } from '../common/validation';
import { WarehouseAccessService } from './warehouse-access.service';

type ContextType = 'warehouse' | 'zone' | 'location';

@Injectable()
export class WarehouseManagementService {
  constructor(private readonly db: DataSource, private readonly access: WarehouseAccessService) {}

  async warehouses(user: AuthUser) {
    const ids = await this.access.getAccessibleWarehouseIds(user);
    return this.db.query(`SELECT w.id,w.warehouse_code "warehouseCode",COALESCE(w.display_name,w.name) name,w.warehouse_type "warehouseType",w.status,
      count(DISTINCT z.id) FILTER(WHERE z.deleted_at IS NULL)::int "zoneCount",
      count(DISTINCT l.id) FILTER(WHERE l.is_archived=false)::int "locationCount",
      count(DISTINCT sb.item_id) FILTER(WHERE sb.on_hand_qty>0)::int "itemTypeCount"
      FROM warehouses w LEFT JOIN warehouse_zones z ON z.warehouse_id=w.id
      LEFT JOIN warehouse_locations l ON l.zone_id=z.id LEFT JOIN stock_balances sb ON sb.location_id=l.id
      WHERE w.deleted_at IS NULL AND ($1::uuid[] IS NULL OR w.id=ANY($1::uuid[]))
      GROUP BY w.id ORDER BY w.status='ACTIVE' DESC,w.warehouse_code`, [ids]);
  }

  async zones(user: AuthUser, warehouseId: string) {
    await this.access.assertWarehouse(user, warehouseId);
    return this.db.query(`SELECT z.id,z.warehouse_id "warehouseId",z.code,z.name,z.status,
      count(DISTINCT l.id) FILTER(WHERE l.is_archived=false)::int "locationCount",
      count(DISTINCT sb.item_id) FILTER(WHERE sb.on_hand_qty>0)::int "itemTypeCount",
      EXISTS(SELECT 1 FROM warehouse_operation_locks ol WHERE ol.status='ACTIVE' AND ol.warehouse_id=$1 AND (ol.scope_type='WAREHOUSE' OR ol.zone_id=z.id)) "locked"
      FROM warehouse_zones z LEFT JOIN warehouse_locations l ON l.zone_id=z.id LEFT JOIN stock_balances sb ON sb.location_id=l.id
      WHERE z.warehouse_id=$1 AND z.deleted_at IS NULL GROUP BY z.id ORDER BY z.sequence_no NULLS LAST,z.code`, [warehouseId]);
  }

  async locations(user: AuthUser, zoneId: string) {
    const scope = await this.scope('zone', zoneId, user);
    const rows = await this.db.query(`${this.locationStateSql()} WHERE l.zone_id=$1 GROUP BY l.id,z.id,w.id,s.item_count,s.on_hand,s.frozen,s.reserved,s.incoming,c.capacity_count,c.full_risk,c.warning_risk,locks.locked ORDER BY l.sort_order NULLS LAST,l.code`, [zoneId]);
    return rows.map((row: any) => {const state=this.locationState(row);const {onHandQty,frozenQty,reservedQty,pendingInboundQty,...publicRow}=row;return { ...publicRow, warehouseId: scope.warehouseId, state };});
  }

  async context(user: AuthUser, type: ContextType, id: string) {
    const scope = await this.scope(type, id, user);
    const [detail] = await this.db.query(type === 'warehouse'
      ? `SELECT id,warehouse_code code,COALESCE(display_name,name) name,warehouse_type "warehouseType",status FROM warehouses WHERE id=$1`
      : type === 'zone'
        ? `SELECT z.id,z.code,z.name,z.status,w.id "warehouseId",w.warehouse_code "warehouseCode",COALESCE(w.display_name,w.name) "warehouseName",w.warehouse_type "warehouseType" FROM warehouse_zones z JOIN warehouses w ON w.id=z.warehouse_id WHERE z.id=$1`
        : `SELECT l.id,l.code,l.code "locationDisplayName",l.name,l.status,z.id "zoneId",z.code "zoneCode",z.name "zoneName",NULLIF(z.actual_location,'未填写') "actualPosition",w.id "warehouseId",w.warehouse_code "warehouseCode",COALESCE(w.display_name,w.name) "warehouseName",w.warehouse_type "warehouseType" FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1`, [id]);
    const filter = type === 'warehouse' ? 'l.warehouse_id=$1' : type === 'zone' ? 'l.zone_id=$1' : 'l.id=$1';
    const metricsByUnit = await this.db.query(`${this.metricsSql()} WHERE ${filter} GROUP BY i.unit ORDER BY i.unit`, [id]);
    const [counts] = await this.db.query(`SELECT count(DISTINCT z.id)::int "zoneCount",count(DISTINCT l.id)::int "locationCount",count(DISTINCT sb.item_id) FILTER(WHERE sb.on_hand_qty>0)::int "itemTypeCount"
      FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id LEFT JOIN stock_balances sb ON sb.location_id=l.id WHERE ${filter}`, [id]);
    const [lock] = await this.effectiveLock(this.db, scope.warehouseId, scope.zoneId, scope.locationId);
    const alerts = await this.db.query(`SELECT id,alert_type "alertType",message,status,updated_at "updatedAt" FROM inventory_alerts WHERE warehouse_id=$1 AND status='OPEN' ORDER BY updated_at DESC LIMIT 20`, [scope.warehouseId]);
    return { type, ...detail, ...counts, metricsByUnit, lock: lock || null, alerts };
  }

  async materials(user: AuthUser, locationId: string, q: any) {
    await this.scope('location', locationId, user);
    const page = parsePage(q.page, 1), pageSize = parsePage(q.pageSize, 30, 100), keyword = q.keyword?.trim() || null;
    const sql = `WITH reserved AS (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id),
      incoming AS (SELECT location_id,item_id,sum(quantity) qty FROM location_capacity_reservations WHERE status='ACTIVE' GROUP BY location_id,item_id),dimensions AS (SELECT location_id,item_id FROM stock_balances UNION SELECT location_id,item_id FROM location_item_capacities UNION SELECT location_id,item_id FROM location_item_rules UNION SELECT location_id,item_id FROM stock_reservations WHERE status='ACTIVE' UNION SELECT location_id,item_id FROM location_capacity_reservations WHERE status='ACTIVE')
      SELECT i.id "itemId",i.item_code "itemCode",i.name,i.model,i.spec,i.unit,i.minimum_stock "minimumStock",
        COALESCE(sum(sb.on_hand_qty),0)::numeric(18,0)::text "onHandQty",COALESCE(sum(sb.frozen_qty),0)::numeric(18,0)::text "frozenQty",
        COALESCE(sum(r.qty),0)::numeric(18,0)::text "reservedQty",COALESCE(inc.qty,0)::numeric(18,0)::text "pendingInboundQty",
        GREATEST(COALESCE(sum(sb.on_hand_qty),0)-COALESCE(sum(sb.frozen_qty),0)-COALESCE(sum(r.qty),0),0)::numeric(18,0)::text "availableQty",
        cap.capacity::text "capacityQty",rule.allowed,rule.notes "ruleNotes"
      FROM dimensions d JOIN items i ON i.id=d.item_id LEFT JOIN stock_balances sb ON sb.location_id=d.location_id AND sb.item_id=d.item_id
      LEFT JOIN reserved r ON r.location_id=d.location_id AND r.item_id=d.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
      LEFT JOIN incoming inc ON inc.location_id=d.location_id AND inc.item_id=d.item_id
      LEFT JOIN location_item_capacities cap ON cap.location_id=d.location_id AND cap.item_id=d.item_id
      LEFT JOIN location_item_rules rule ON rule.location_id=d.location_id AND rule.item_id=d.item_id
      WHERE d.location_id=$1 AND ($2::text IS NULL OR i.item_code ILIKE '%'||$2||'%' OR i.name ILIKE '%'||$2||'%' OR COALESCE(i.model,'') ILIKE '%'||$2||'%')
      GROUP BY i.id,inc.qty,cap.capacity,rule.allowed,rule.notes`;
    const [{ total }] = await this.db.query(`SELECT count(*)::int total FROM (${sql}) x`, [locationId, keyword]);
    const items = await this.db.query(`${sql} ORDER BY "itemCode" LIMIT $3 OFFSET $4`, [locationId, keyword, pageSize, (page - 1) * pageSize]);
    const batches = items.length ? await this.db.query(`WITH reserved AS (SELECT warehouse_id,location_id,item_id,batch_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id,batch_id)
      SELECT sb.item_id "itemId",sb.batch_id "batchId",b.batch_no "batchNo",sb.on_hand_qty::text "onHandQty",COALESCE(sb.frozen_qty,0)::text "frozenQty",COALESCE(r.qty,0)::text "reservedQty",
      GREATEST(sb.on_hand_qty-COALESCE(sb.frozen_qty,0)-COALESCE(r.qty,0),0)::text "availableQty"
      FROM stock_balances sb LEFT JOIN inventory_batches b ON b.id=sb.batch_id LEFT JOIN reserved r ON r.warehouse_id=sb.warehouse_id AND r.location_id=sb.location_id AND r.item_id=sb.item_id AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
      WHERE sb.location_id=$1 AND sb.item_id=ANY($2::uuid[]) ORDER BY b.batch_no NULLS FIRST`, [locationId, items.map((item: any) => item.itemId)]) : [];
    return { items: items.map((item: any) => ({ ...item, remainingCapacityQty: item.capacityQty === null ? null : Decimal.max(new Decimal(item.capacityQty).sub(item.onHandQty).sub(item.pendingInboundQty), 0).toFixed(0), usageRate: item.capacityQty === null ? null : new Decimal(item.onHandQty).add(item.pendingInboundQty).div(item.capacityQty).mul(100).toDecimalPlaces(1).toNumber(), batches: batches.filter((batch: any) => batch.itemId === item.itemId) })), total: Number(total || 0), page, pageSize };
  }

  async search(user: AuthUser, keyword: string) {
    const term = keyword?.trim(); if (!term) return [];
    const ids = await this.access.getAccessibleWarehouseIds(user);
    return this.db.query(`SELECT * FROM (
      SELECT 'warehouse' type,w.id,w.id "warehouseId",NULL::uuid "zoneId",NULL::uuid "locationId",NULL::uuid "itemId",w.warehouse_code code,COALESCE(w.display_name,w.name) name,w.warehouse_code "warehouseCode",NULL::text "zoneCode",NULL::text "locationCode",NULL::text unit,NULL::text quantity,NULL::text "locationDisplayName",NULL::text "actualPosition"
      FROM warehouses w WHERE w.deleted_at IS NULL AND ($2::uuid[] IS NULL OR w.id=ANY($2::uuid[])) AND (w.warehouse_code ILIKE '%'||$1||'%' OR w.name ILIKE '%'||$1||'%' OR COALESCE(w.display_name,'') ILIKE '%'||$1||'%')
      UNION ALL SELECT 'zone',z.id,w.id,z.id,NULL,NULL,z.code,z.name,w.warehouse_code,z.code,NULL,NULL,NULL,NULL,NULL FROM warehouse_zones z JOIN warehouses w ON w.id=z.warehouse_id WHERE z.deleted_at IS NULL AND ($2::uuid[] IS NULL OR w.id=ANY($2::uuid[])) AND (z.code ILIKE '%'||$1||'%' OR z.name ILIKE '%'||$1||'%')
      UNION ALL SELECT 'location',l.id,w.id,z.id,l.id,NULL,l.code,l.name,w.warehouse_code,z.code,l.code,NULL,NULL,l.code,NULLIF(z.actual_location,'未填写') FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id WHERE l.is_archived=false AND ($2::uuid[] IS NULL OR w.id=ANY($2::uuid[])) AND (l.code ILIKE '%'||$1||'%' OR l.name ILIKE '%'||$1||'%')
      UNION ALL SELECT 'material',i.id,w.id,z.id,l.id,i.id,i.item_code,i.name,w.warehouse_code,z.code,l.code,i.unit,sum(sb.on_hand_qty)::numeric(18,0)::text,l.code,NULLIF(z.actual_location,'未填写') FROM stock_balances sb JOIN items i ON i.id=sb.item_id JOIN warehouse_locations l ON l.id=sb.location_id JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=sb.warehouse_id WHERE sb.on_hand_qty>0 AND ($2::uuid[] IS NULL OR w.id=ANY($2::uuid[])) AND (i.item_code ILIKE '%'||$1||'%' OR i.name ILIKE '%'||$1||'%' OR COALESCE(i.model,'') ILIKE '%'||$1||'%') GROUP BY i.id,w.id,z.id,l.id,w.warehouse_code,z.code,l.code,z.actual_location
      ) result ORDER BY CASE type WHEN 'material' THEN 1 WHEN 'location' THEN 2 WHEN 'zone' THEN 3 ELSE 4 END,code LIMIT 60`, [term, ids]);
  }

  async activity(user: AuthUser, q: any) {
    const type = (q.contextType || 'warehouse') as ContextType, id = q.contextId;
    const scope = await this.scope(type, id, user);
    const condition = type === 'warehouse' ? 't.warehouse_id=$1' : type === 'zone' ? 'l.zone_id=$1' : 't.location_id=$1';
    const rows = await this.db.query(`SELECT t.id,t.source_document_id "documentId",d.document_no "documentNo",d.document_type "documentType",t.created_at "createdAt",t.delta_qty::text "deltaQty",i.id "itemId",i.item_code "itemCode",i.name "itemName",i.unit,l.id "locationId",l.code "locationCode",l.code "locationDisplayName",NULLIF(z.actual_location,'未填写') "actualPosition",z.code "zoneCode",w.warehouse_code "warehouseCode",COALESCE(t.operator_name,u.employee_name,u.name,u.username,'—') operator
      FROM stock_transactions t JOIN stock_documents d ON d.id=t.source_document_id JOIN items i ON i.id=t.item_id JOIN warehouse_locations l ON l.id=t.location_id JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=t.warehouse_id LEFT JOIN users u ON u.id=t.created_by WHERE ${condition} ORDER BY t.created_at DESC LIMIT 80`, [id]);
    const result: any[] = [], moves = new Map<string, any[]>();
    for (const row of rows) { if (row.documentType === 'STOCK_MOVE') moves.set(row.documentId, [...(moves.get(row.documentId) || []), row]); else result.push(row); }
    for (const group of moves.values()) { const out = group.find(row => Number(row.deltaQty) < 0), inbound = group.find(row => Number(row.deltaQty) > 0); result.push({ ...out, deltaQty: out ? String(Math.abs(Number(out.deltaQty))) : inbound?.deltaQty, direction: 'MOVE', sourcePath: out?.locationDisplayName || out?.locationCode || null, targetPath: inbound?.locationDisplayName || inbound?.locationCode || null }); }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, Number(q.pageSize || 20));
  }

  async saveRule(user: AuthUser, locationId: string, itemId: string, dto: any) {
    const scope = await this.scope('location', locationId, user); const snap = snapshotUser(user);
    await this.db.query(`INSERT INTO location_item_rules(location_id,item_id,allowed,notes,created_by,created_by_username,created_by_name,updated_by,updated_by_username,updated_by_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$5,$6,$7) ON CONFLICT(location_id,item_id) DO UPDATE SET allowed=EXCLUDED.allowed,notes=EXCLUDED.notes,updated_by=EXCLUDED.updated_by,updated_by_username=EXCLUDED.updated_by_username,updated_by_name=EXCLUDED.updated_by_name,updated_at=now()`, [locationId, itemId, dto.allowed !== false, dto.notes || null, snap.userId, snap.username, snap.name]);
    return { locationId, itemId, allowed: dto.allowed !== false, warehouseId: scope.warehouseId };
  }

  async removeRule(user: AuthUser, locationId: string, itemId: string) { await this.scope('location', locationId, user); await this.db.query(`DELETE FROM location_item_rules WHERE location_id=$1 AND item_id=$2`, [locationId, itemId]); return { ok: true }; }

  async lock(user: AuthUser, dto: any) {
    const type = String(dto.scopeType || '').toLowerCase() as ContextType; if (!['warehouse','zone','location'].includes(type)) throw new BusinessException('VALIDATION_ERROR', '锁定层级无效');
    const scope = await this.scope(type, dto.id, user); const snap = snapshotUser(user), scopeType = type.toUpperCase();
    const [row] = await this.db.query(`INSERT INTO warehouse_operation_locks(scope_type,warehouse_id,zone_id,location_id,reason,locked_by,locked_by_username,locked_by_name,locked_by_department)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [scopeType, scope.warehouseId, type === 'warehouse' ? null : scope.zoneId, type === 'location' ? scope.locationId : null, dto.reason?.trim() || '作业锁定', snap.userId, snap.username, snap.name, snap.department]);
    await this.transitionLockAlert(scope.warehouseId, type, dto.id, true, dto.reason?.trim() || '作业锁定'); return row;
  }

  async unlock(user: AuthUser, id: string) {
    const [lock] = await this.db.query(`SELECT * FROM warehouse_operation_locks WHERE id=$1 AND status='ACTIVE'`, [id]); if (!lock) throw new BusinessException('NOT_FOUND', '有效作业锁不存在');
    await this.access.assertWarehouse(user, lock.warehouse_id); const snap = snapshotUser(user);
    await this.db.query(`UPDATE warehouse_operation_locks SET status='RELEASED',released_by=$1,released_by_username=$2,released_by_name=$3,released_at=now(),updated_at=now() WHERE id=$4`, [snap.userId, snap.username, snap.name, id]);
    const nodeId = lock.location_id || lock.zone_id || lock.warehouse_id; await this.transitionLockAlert(lock.warehouse_id, String(lock.scope_type).toLowerCase(), nodeId, false, '作业锁已解除'); return { ok: true };
  }

  async assertOperationAllowed(qr: QueryRunner, locations: Array<string | null | undefined>, itemRules: Array<{ locationId?: string; itemId?: string }> = []) {
    const ids = [...new Set(locations.filter((id): id is string => Boolean(id)))]; if (!ids.length) return;
    const locked = await qr.query(`SELECT l.code,COALESCE(ol.reason,'作业锁定') reason FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouse_operation_locks ol ON ol.status='ACTIVE' AND ol.warehouse_id=l.warehouse_id AND (ol.scope_type='WAREHOUSE' OR (ol.scope_type='ZONE' AND ol.zone_id=z.id) OR (ol.scope_type='LOCATION' AND ol.location_id=l.id)) WHERE l.id=ANY($1::uuid[]) LIMIT 1`, [ids]);
    if (locked.length) throw new BusinessException('WAREHOUSE_OPERATION_LOCKED', `${locked[0].code} 当前禁止库存作业：${locked[0].reason}`, HttpStatus.CONFLICT, { locationId: ids[0] });
    for (const rule of itemRules) if (rule.locationId && rule.itemId) { const [denied] = await qr.query(`SELECT 1 FROM location_item_rules WHERE location_id=$1 AND item_id=$2 AND allowed=false`, [rule.locationId, rule.itemId]); if (denied) throw new BusinessException('LOCATION_ITEM_NOT_ALLOWED', '物料不允许存放到目标库位', HttpStatus.CONFLICT, rule); }
  }

  async refreshInventoryAlerts(executor:Pick<QueryRunner,'query'>,warehouseIds:string[]){
    const ids=[...new Set(warehouseIds.filter(Boolean))];if(!ids.length)return;
    const risks=await executor.query(`WITH incoming AS (SELECT location_id,item_id,sum(quantity) qty FROM location_capacity_reservations WHERE status='ACTIVE' GROUP BY location_id,item_id),stock AS (SELECT warehouse_id,location_id,item_id,sum(on_hand_qty) qty FROM stock_balances GROUP BY warehouse_id,location_id,item_id)
      SELECT 'LOW_STOCK' "alertType",'LOW_STOCK:'||s.warehouse_id||':'||s.item_id "alertKey",s.warehouse_id "warehouseId",NULL::uuid "zoneId",NULL::uuid "locationId",s.item_id "itemId",i.item_code||' '||i.name||' 低于最低库存' message
      FROM (SELECT warehouse_id,item_id,sum(qty) qty FROM stock GROUP BY warehouse_id,item_id) s JOIN items i ON i.id=s.item_id WHERE s.warehouse_id=ANY($1::uuid[]) AND s.qty>0 AND s.qty<=i.minimum_stock
      UNION ALL
      SELECT CASE WHEN s.qty+COALESCE(inc.qty,0)>=c.capacity THEN 'CAPACITY_FULL' ELSE 'CAPACITY_WARNING' END,'CAPACITY:'||l.id||':'||s.item_id,l.warehouse_id,l.zone_id,l.id,s.item_id,l.code||' / '||i.item_code||CASE WHEN s.qty+COALESCE(inc.qty,0)>=c.capacity THEN ' 已满库' ELSE ' 容量使用率达到 80%' END
      FROM stock s JOIN warehouse_locations l ON l.id=s.location_id JOIN items i ON i.id=s.item_id JOIN location_item_capacities c ON c.location_id=s.location_id AND c.item_id=s.item_id LEFT JOIN incoming inc ON inc.location_id=s.location_id AND inc.item_id=s.item_id
      WHERE s.warehouse_id=ANY($1::uuid[]) AND s.qty+COALESCE(inc.qty,0)>=c.capacity*.8`,[ids]);
    const existing=await executor.query(`SELECT id,alert_key "alertKey",alert_type "alertType",warehouse_id "warehouseId",message FROM inventory_alerts WHERE warehouse_id=ANY($1::uuid[]) AND status='OPEN' AND alert_type<>'OPERATION_LOCKED'`,[ids]);
    const next=new Map(risks.map((risk:any)=>[risk.alertKey,risk]));
    for(const risk of risks){if(existing.some((row:any)=>row.alertKey===risk.alertKey&&row.alertType===risk.alertType))continue;await executor.query(`UPDATE inventory_alerts SET status='RESOLVED',resolved_at=now(),updated_at=now() WHERE alert_key=$1 AND status='OPEN'`,[risk.alertKey]);await executor.query(`INSERT INTO inventory_alerts(alert_key,alert_type,warehouse_id,zone_id,location_id,item_id,message) VALUES($1,$2,$3,$4,$5,$6,$7)`,[risk.alertKey,risk.alertType,risk.warehouseId,risk.zoneId,risk.locationId,risk.itemId,risk.message]);await this.notifyWarehouseManagers(executor,risk.warehouseId,'库存风险提醒',risk.message);}
    for(const row of existing){if(next.has(row.alertKey))continue;await executor.query(`UPDATE inventory_alerts SET status='RESOLVED',resolved_at=now(),updated_at=now() WHERE id=$1 AND status='OPEN'`,[row.id]);await this.notifyWarehouseManagers(executor,row.warehouseId,'库存风险已解除',row.message);}
  }

  private async scope(type: ContextType, id: string, user: AuthUser) {
    const [row] = await this.db.query(type === 'warehouse' ? `SELECT id "warehouseId" FROM warehouses WHERE id=$1 AND deleted_at IS NULL` : type === 'zone' ? `SELECT warehouse_id "warehouseId",id "zoneId" FROM warehouse_zones WHERE id=$1 AND deleted_at IS NULL` : `SELECT warehouse_id "warehouseId",zone_id "zoneId",id "locationId" FROM warehouse_locations WHERE id=$1 AND is_archived=false`, [id]);
    if (!row) throw new BusinessException('NOT_FOUND', '仓储空间不存在'); await this.access.assertWarehouse(user, row.warehouseId); return row;
  }

  private effectiveLock(executor: Pick<DataSource, 'query'>, warehouseId: string, zoneId?: string, locationId?: string) { return executor.query(`SELECT id,scope_type "scopeType",reason,locked_by_name "lockedByName",created_at "createdAt" FROM warehouse_operation_locks WHERE status='ACTIVE' AND warehouse_id=$1 AND (scope_type='WAREHOUSE' OR (scope_type='ZONE' AND zone_id=$2) OR (scope_type='LOCATION' AND location_id=$3)) ORDER BY CASE scope_type WHEN 'LOCATION' THEN 1 WHEN 'ZONE' THEN 2 ELSE 3 END LIMIT 1`, [warehouseId, zoneId || null, locationId || null]); }

  private locationState(row: any) { const onHand=Number(row.onHandQty||0);if (row.status !== 'ACTIVE') return 'DISABLED';if(row.fullRisk)return 'FULL';if (row.locked) return 'LOCKED';if(row.warningRisk)return 'WARNING';return onHand > 0 ? 'NORMAL' : 'EMPTY'; }
  private locationStateSql() { return `SELECT l.id,l.warehouse_id "warehouseId",l.zone_id "zoneId",l.code,l.code "locationDisplayName",l.name,NULLIF(z.actual_location,'未填写') "actualPosition",l.status,COALESCE(s.item_count,0)::int "itemTypeCount",COALESCE(s.on_hand,0)::text "onHandQty",COALESCE(s.frozen,0)::text "frozenQty",COALESCE(s.reserved,0)::text "reservedQty",COALESCE(s.incoming,0)::text "pendingInboundQty",COALESCE(c.capacity_count,0)::int "capacityCount",COALESCE(c.full_risk,false) "fullRisk",COALESCE(c.warning_risk,false) "warningRisk",COALESCE(locks.locked,false) locked FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id LEFT JOIN LATERAL (SELECT count(DISTINCT sb.item_id) FILTER(WHERE sb.on_hand_qty>0) item_count,sum(sb.on_hand_qty) on_hand,sum(sb.frozen_qty) frozen,COALESCE((SELECT sum(sr.quantity) FROM stock_reservations sr WHERE sr.status='ACTIVE' AND sr.location_id=l.id),0) reserved,COALESCE((SELECT sum(cr.quantity) FROM location_capacity_reservations cr WHERE cr.status='ACTIVE' AND cr.location_id=l.id),0) incoming FROM stock_balances sb WHERE sb.location_id=l.id) s ON true LEFT JOIN LATERAL (SELECT count(*) capacity_count,bool_or(COALESCE((SELECT sum(sb.on_hand_qty) FROM stock_balances sb WHERE sb.location_id=l.id AND sb.item_id=cap.item_id),0)+COALESCE((SELECT sum(cr.quantity) FROM location_capacity_reservations cr WHERE cr.status='ACTIVE' AND cr.location_id=l.id AND cr.item_id=cap.item_id),0)>=cap.capacity) full_risk,bool_or(COALESCE((SELECT sum(sb.on_hand_qty) FROM stock_balances sb WHERE sb.location_id=l.id AND sb.item_id=cap.item_id),0)+COALESCE((SELECT sum(cr.quantity) FROM location_capacity_reservations cr WHERE cr.status='ACTIVE' AND cr.location_id=l.id AND cr.item_id=cap.item_id),0)>=cap.capacity*.8) warning_risk FROM location_item_capacities cap WHERE cap.location_id=l.id) c ON true LEFT JOIN LATERAL (SELECT true locked FROM warehouse_operation_locks ol WHERE ol.status='ACTIVE' AND ol.warehouse_id=l.warehouse_id AND (ol.scope_type='WAREHOUSE' OR ol.zone_id=l.zone_id OR ol.location_id=l.id) LIMIT 1) locks ON true` as string; }
  private metricsSql() { return `WITH reserved AS (SELECT warehouse_id,location_id,item_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id), incoming AS (SELECT warehouse_id,location_id,item_id,sum(quantity) qty FROM location_capacity_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id), balances AS (SELECT warehouse_id,location_id,item_id,sum(on_hand_qty) on_hand,sum(frozen_qty) frozen FROM stock_balances GROUP BY warehouse_id,location_id,item_id),dimensions AS (SELECT warehouse_id,location_id,item_id FROM balances UNION SELECT warehouse_id,location_id,item_id FROM reserved UNION SELECT warehouse_id,location_id,item_id FROM incoming) SELECT i.unit,COALESCE(sum(sb.on_hand),0)::numeric(18,0)::text "onHandQty",COALESCE(sum(sb.frozen),0)::numeric(18,0)::text "frozenQty",COALESCE(sum(r.qty),0)::numeric(18,0)::text "reservedQty",GREATEST(COALESCE(sum(sb.on_hand),0)-COALESCE(sum(sb.frozen),0)-COALESCE(sum(r.qty),0),0)::numeric(18,0)::text "availableQty",COALESCE(sum(inc.qty),0)::numeric(18,0)::text "pendingInboundQty",count(DISTINCT d.item_id) FILTER(WHERE COALESCE(sb.on_hand,0)>0)::int "itemTypeCount" FROM warehouse_locations l JOIN dimensions d ON d.location_id=l.id JOIN items i ON i.id=d.item_id LEFT JOIN balances sb ON sb.warehouse_id=d.warehouse_id AND sb.location_id=d.location_id AND sb.item_id=d.item_id LEFT JOIN reserved r ON r.warehouse_id=d.warehouse_id AND r.location_id=d.location_id AND r.item_id=d.item_id LEFT JOIN incoming inc ON inc.warehouse_id=d.warehouse_id AND inc.location_id=d.location_id AND inc.item_id=d.item_id` as string; }

  private async transitionLockAlert(warehouseId: string, type: string, nodeId: string, open: boolean, message: string) {
    const key = `OPERATION_LOCKED:${type}:${nodeId}`;
    if (open) await this.db.query(`INSERT INTO inventory_alerts(alert_key,alert_type,warehouse_id,zone_id,location_id,message) SELECT $1,'OPERATION_LOCKED',$2,CASE WHEN $3='zone' THEN $4::uuid WHEN $3='location' THEN l.zone_id END,CASE WHEN $3='location' THEN $4::uuid END,$5 FROM (SELECT 1) x LEFT JOIN warehouse_locations l ON l.id=CASE WHEN $3='location' THEN $4::uuid END ON CONFLICT DO NOTHING`, [key, warehouseId, type, nodeId, message]);
    else await this.db.query(`UPDATE inventory_alerts SET status='RESOLVED',resolved_at=now(),updated_at=now() WHERE alert_key=$1 AND status='OPEN'`, [key]);
    const managers = await this.db.query(`SELECT wm.user_id "userId" FROM warehouse_manager wm JOIN users u ON u.id=wm.user_id WHERE wm.warehouse_id=$1 AND u.status='ACTIVE' AND u.deleted_at IS NULL`, [warehouseId]);
    for (const manager of managers) await this.db.query(`INSERT INTO notification(receiver_user_id,type,title,content,business_type,business_id) VALUES($1,'INVENTORY_ALERT',$2,$3,'WAREHOUSE',$4)`, [manager.userId, open ? '仓储空间已锁定' : '仓储空间已解锁', message, warehouseId]);
  }

  private async notifyWarehouseManagers(executor:Pick<QueryRunner,'query'>,warehouseId:string,title:string,content:string){const managers=await executor.query(`SELECT wm.user_id "userId" FROM warehouse_manager wm JOIN users u ON u.id=wm.user_id WHERE wm.warehouse_id=$1 AND u.status='ACTIVE' AND u.deleted_at IS NULL`,[warehouseId]);for(const manager of managers)await executor.query(`INSERT INTO notification(receiver_user_id,type,title,content,business_type,business_id) VALUES($1,'INVENTORY_ALERT',$2,$3,'WAREHOUSE',$4)`,[manager.userId,title,content,warehouseId]);}
}
