import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/constants';
import { WarehouseAccessService } from './warehouse-access.service';

type Status = 'DISABLED' | 'FULL' | 'LOCKED' | 'WARNING' | 'LOW' | 'NORMAL' | 'EMPTY';
const rank: Record<Status, number> = { DISABLED: 7, FULL: 6, LOCKED: 5, WARNING: 4, LOW: 3, NORMAL: 2, EMPTY: 1 };

/** One stock/reservation/capacity calculation used by both warehouse workbenches. */
@Injectable()
export class WarehouseStateService {
  constructor(private readonly db: DataSource, private readonly access: WarehouseAccessService) {}

  async tree(user: AuthUser, requestedWarehouseId?: string) {
    if (requestedWarehouseId) await this.access.assertWarehouse(user, requestedWarehouseId);
    const accessible = requestedWarehouseId ? [requestedWarehouseId] : await this.access.getAccessibleWarehouseIds(user);
    const locations = await this.db.query(this.locationSql(), [accessible]);
    return this.toTree(locations);
  }

  async locationDetail(user: AuthUser, locationId: string) {
    const [location] = await this.db.query(`SELECT warehouse_id "warehouseId" FROM warehouse_locations WHERE id=$1`, [locationId]);
    if (!location) return null;
    await this.access.assertWarehouse(user, location.warehouseId);
    const rows = await this.db.query(`${this.locationSql()} AND l.id=$2`, [[location.warehouseId], locationId]);
    const tree = this.toTree(rows);
    const detail = tree.locations[0];
    return detail ? { ...detail, items: rows.map((row: any) => this.metric(row)) } : null;
  }

  async workspace(user: AuthUser, warehouseId: string) {
    const tree = await this.tree(user, warehouseId);
    const [warehouse] = tree.warehouses;
    const recentTransactions = await this.db.query(`SELECT t.id,t.created_at "createdAt",t.delta_qty "deltaQty",t.balance_after "balanceAfter",d.document_type "documentType",i.item_code "itemCode",i.name "itemName",l.code "locationCode",l.code "locationDisplayName",NULLIF(z.actual_location,'未填写') "actualPosition",COALESCE(t.operator_name,u.employee_name,u.name,u.username,'—') "operator" FROM stock_transactions t JOIN stock_documents d ON d.id=t.source_document_id JOIN items i ON i.id=t.item_id JOIN warehouse_locations l ON l.id=t.location_id JOIN warehouse_zones z ON z.id=l.zone_id LEFT JOIN users u ON u.id=t.created_by WHERE t.warehouse_id=$1 ORDER BY t.created_at DESC LIMIT 10`, [warehouseId]);
    const recentDocuments = await this.db.query(`SELECT id,document_no "documentNo",document_type "documentType",status,created_at "createdAt",posted_at "postedAt" FROM stock_documents WHERE warehouse_id=$1 ORDER BY created_at DESC LIMIT 10`, [warehouseId]);
    return { warehouse, zones: tree.zones, locations: tree.locations, summary: tree.summary, unitStatistics: tree.unitStatistics, recentTransactions, recentDocuments };
  }

  private locationSql() {
    return `WITH stock AS (
      SELECT warehouse_id,location_id,item_id,COALESCE(sum(on_hand_qty),0) on_hand,COALESCE(sum(frozen_qty),0) frozen
      FROM stock_balances GROUP BY warehouse_id,location_id,item_id
    ), outbound AS (
      SELECT warehouse_id,location_id,item_id,COALESCE(sum(quantity),0) quantity FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id
    ), incoming AS (
      SELECT warehouse_id,location_id,item_id,COALESCE(sum(quantity),0) quantity FROM location_capacity_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,location_id,item_id
    ), dimensions AS (
      SELECT warehouse_id,location_id,item_id FROM stock UNION SELECT warehouse_id,location_id,item_id FROM outbound UNION SELECT warehouse_id,location_id,item_id FROM incoming UNION SELECT l.warehouse_id,c.location_id,c.item_id FROM location_item_capacities c JOIN warehouse_locations l ON l.id=c.location_id
    )
    SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.display_name "warehouseName",w.name,w.warehouse_type "warehouseType",
      z.id "zoneId",z.code "zoneCode",z.name "zoneName",NULLIF(z.actual_location,'未填写') "actualPosition",z.status "zoneStatus",l.id "locationId",l.code "locationCode",l.code "locationDisplayName",l.name "locationName",l.status "locationStatus",l.is_archived "isArchived",
      i.id "itemId",i.item_code "itemCode",i.name "itemName",i.model,i.unit,i.minimum_stock "minimumStock",i.item_type "itemType",c.capacity::text "capacityQty",c.notes,
      EXISTS(SELECT 1 FROM warehouse_operation_locks ol WHERE ol.status='ACTIVE' AND ol.warehouse_id=l.warehouse_id AND (ol.scope_type='WAREHOUSE' OR ol.zone_id=l.zone_id OR ol.location_id=l.id)) "operationLocked",
      COALESCE(s.on_hand,0)::text "onHandQty",COALESCE(s.frozen,0)::text "frozenQty",COALESCE(o.quantity,0)::text "outboundReservedQty",COALESCE(inc.quantity,0)::text "pendingInboundQty",
      GREATEST(COALESCE(s.on_hand,0)-COALESCE(s.frozen,0)-COALESCE(o.quantity,0),0)::text "availableQty"
    FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id JOIN warehouse_zones z ON z.id=l.zone_id
      LEFT JOIN dimensions d ON d.location_id=l.id LEFT JOIN items i ON i.id=d.item_id LEFT JOIN stock s ON s.location_id=l.id AND s.item_id=d.item_id
      LEFT JOIN outbound o ON o.location_id=l.id AND o.item_id=d.item_id LEFT JOIN incoming inc ON inc.location_id=l.id AND inc.item_id=d.item_id
      LEFT JOIN location_item_capacities c ON c.location_id=l.id AND c.item_id=d.item_id
    WHERE w.deleted_at IS NULL AND z.deleted_at IS NULL AND ($1::uuid[] IS NULL OR w.id=ANY($1::uuid[]))`;
  }

  private metric(row: any) {
    const onHand = Number(row.onHandQty || 0), frozen = Number(row.frozenQty || 0), outbound = Number(row.outboundReservedQty || 0), incoming = Number(row.pendingInboundQty || 0);
    const hasCapacity = row.capacityQty !== null && row.capacityQty !== undefined;
    const capacity = hasCapacity ? Number(row.capacityQty) : null;
    const occupied = onHand + incoming;
    const usageRate = capacity ? Math.round((occupied / capacity) * 1000) / 10 : null;
    const configuredCapacity = capacity ?? 0;
    const capacityStatus = !hasCapacity ? 'UNLIMITED' : occupied >= configuredCapacity ? 'FULL' : occupied / configuredCapacity >= .8 ? 'WARNING' : 'NORMAL';
    let status: Status = row.locationStatus !== 'ACTIVE' || row.zoneStatus !== 'ACTIVE' || row.isArchived ? 'DISABLED' : 'EMPTY';
    if (status !== 'DISABLED') {
      if (capacityStatus === 'FULL') status = 'FULL';
      else if (row.operationLocked) status = 'LOCKED';
      else if (capacityStatus === 'WARNING') status = 'WARNING';
      else if (onHand > 0 && onHand <= Number(row.minimumStock || 0)) status = 'LOW';
      else if (onHand > 0) status = 'NORMAL';
    }
    return { ...row, onHandQty: String(onHand), frozenQty: String(frozen), outboundReservedQty: String(outbound), pendingInboundQty: String(incoming), availableQty: String(Math.max(onHand - frozen - outbound, 0)), capacityQty: capacity === null ? null : String(capacity), remainingCapacityQty: capacity === null ? null : String(Math.max(capacity - occupied, 0)), usageRate, capacityStatus, status };
  }

  private toTree(rows: any[]) {
    const mapped = rows.map(row => this.metric(row));
    const locations = new Map<string, any>();
    for (const row of mapped) {
      if (!locations.has(row.locationId)) locations.set(row.locationId, { ...row, items: [], status: row.status, itemTypeCount: 0 });
      const location = locations.get(row.locationId);
      if (row.itemId) { location.items.push(row); location.itemTypeCount += 1; }
      if (rank[row.status as Status] > rank[location.status as Status]) location.status = row.status;
    }
    const list = [...locations.values()];
    const zones = new Map<string, any>();
    for (const location of list) {
      if (!zones.has(location.zoneId)) zones.set(location.zoneId, { id: location.zoneId, code: location.zoneCode, name: location.zoneName, status: location.zoneStatus, locations: [], locationCount: 0, itemTypeCount: 0, _itemIds: new Set<string>(), state: 'EMPTY' });
      const zone = zones.get(location.zoneId); zone.locations.push(location); zone.locationCount += 1; for(const item of location.items)zone._itemIds.add(item.itemId);zone.itemTypeCount=zone._itemIds.size;if (rank[location.status as Status] > rank[zone.state as Status]) zone.state = location.status;
    }
    const warehouses = new Map<string, any>();
    for (const location of list) {
      if (!warehouses.has(location.warehouseId)) warehouses.set(location.warehouseId, { id: location.warehouseId, warehouseCode: location.warehouseCode, name: location.warehouseName || location.name, warehouseType: location.warehouseType, zones: [], locationCount: 0, itemTypeCount: 0, _itemIds:new Set<string>() });
      const warehouse = warehouses.get(location.warehouseId); warehouse.locationCount += 1;for(const item of location.items)warehouse._itemIds.add(item.itemId);warehouse.itemTypeCount=warehouse._itemIds.size;
    }
    for (const zone of zones.values()) {const {_itemIds,...publicZone}=zone;warehouses.get(zone.locations[0].warehouseId).zones.push(publicZone);}
    const byUnit = new Map<string, { unit: string; onHandQty: number; availableQty: number; pendingInboundQty: number }>();
    for (const row of mapped.filter(row => row.itemId)) { const stat = byUnit.get(row.unit) || { unit: row.unit, onHandQty: 0, availableQty: 0, pendingInboundQty: 0 }; stat.onHandQty += Number(row.onHandQty); stat.availableQty += Number(row.availableQty); stat.pendingInboundQty += Number(row.pendingInboundQty); byUnit.set(row.unit, stat); }
    const summary = { warehouseCount: warehouses.size, zoneCount: zones.size, locationCount: list.length, itemTypeCount: new Set(mapped.filter(row => row.itemId).map(row=>row.itemId)).size, lowStockCount: list.filter(row => row.status === 'LOW').length, fullLocationCount: list.filter(row => row.status === 'FULL').length };
    const warehouseRows=[...warehouses.values()].map(({_itemIds,...row})=>row),zoneRows=[...zones.values()].map(({_itemIds,...row})=>row);
    return { warehouses: warehouseRows, zones: zoneRows, locations: list, unitStatistics: [...byUnit.values()].map(row => ({ ...row, onHandQty: String(row.onHandQty), availableQty: String(row.availableQty), pendingInboundQty: String(row.pendingInboundQty) })), summary };
  }
}
