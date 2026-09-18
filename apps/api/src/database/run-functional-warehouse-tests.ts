import { createDataSource } from './data-source';
import { seedFunctionalWarehouse } from './seed-functional-warehouse';

const baseUrl = (process.env.FUNCTIONAL_API_BASE_URL || 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const defaultPassword = process.env.INITIAL_DEMO_PASSWORD || 'Demo@123456';
const passwordFor = (username: string) => process.env[`FUNCTIONAL_${username.toUpperCase().replace(/-/g, '_')}_PASSWORD`] || defaultPassword;
const runKey = `TEST-RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
type Token = { value: string; username: string };
const report: Array<{ name: string; status: 'PASSED' | 'FAILED'; detail?: unknown }> = [];

function unwrap(body: any) { return body?.success === true ? body.data : body; }
async function call(token: Token | undefined, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token.value}` } : {}), ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    const error: any = new Error(body?.message || `HTTP ${response.status}`);
    error.status = response.status; error.body = body; throw error;
  }
  return unwrap(body);
}
async function expectFailure(name: string, action: () => Promise<unknown>, expectedCode?: string) {
  try { await action(); throw new Error('操作意外成功'); }
  catch (error: any) {
    const code = error.body?.code;
    if (error.message === '操作意外成功' || (expectedCode && code !== expectedCode)) throw error;
    report.push({ name, status: 'PASSED', detail: { status: error.status, code, message: error.message } });
  }
}
async function test(name: string, action: () => Promise<void>) {
  try { await action(); report.push({ name, status: 'PASSED' }); }
  catch (error: any) { report.push({ name, status: 'FAILED', detail: { message: error.message, status: error.status, body: error.body } }); throw error; }
}
async function login(username: string): Promise<Token> {
  const auth = await call(undefined, '/auth/login', { method: 'POST', body: JSON.stringify({ username, password: passwordFor(username) }) });
  return { username, value: auth.accessToken };
}
async function submitAndApprove(creator: Token, admin: Token, endpoint: string, body: any, allocations?: (doc: any) => any[]) {
  const doc = await call(creator, endpoint, { method: 'POST', body: JSON.stringify({ ...body, notes: `${runKey} ${body.notes || ''}`.trim() }) });
  await call(creator, `/stock-documents/${doc.id}/submit`, { method: 'POST' });
  const detail = await call(admin, `/stock-documents/${doc.id}`);
  await call(admin, `/approvals/${doc.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-${doc.id}` }, body: JSON.stringify(allocations ? { receiptAllocations: allocations(detail) } : {}) });
  const posted = await call(admin, `/stock-documents/${doc.id}`);
  if (posted.status !== 'POSTED') throw new Error(`单据 ${doc.documentNo} 未过账：${posted.status}`);
  return posted;
}

async function collectFailureDiagnostics(db: ReturnType<typeof createDataSource>) {
  const marker = `${runKey}%`;
  const [documents, approvals, balances, transactions, reservations, capacities, rules, locks] = await Promise.all([
    db.query(`SELECT id,document_no,document_type,status,warehouse_id,submitted_at,posted_at FROM stock_documents WHERE notes LIKE $1 ORDER BY created_at`, [marker]),
    db.query(`SELECT a.document_id,a.status,at.approver_name,at.status task_status,at.approved_at FROM approval_instance a JOIN stock_documents d ON d.id=a.document_id LEFT JOIN approval_task at ON at.approval_instance_id=a.id WHERE d.notes LIKE $1 ORDER BY a.created_at,at.created_at`, [marker]),
    db.query(`SELECT w.warehouse_code,l.code location_code,i.item_code,b.batch_id,b.on_hand_qty,b.frozen_qty FROM stock_balances b JOIN warehouses w ON w.id=b.warehouse_id JOIN warehouse_locations l ON l.id=b.location_id JOIN items i ON i.id=b.item_id WHERE w.warehouse_code LIKE 'TEST-FUNC-%' ORDER BY w.warehouse_code,l.code,i.item_code`, []),
    db.query(`SELECT d.document_no,t.direction,t.delta_qty,t.warehouse_id,t.location_id,t.item_id,t.batch_id,t.created_at FROM stock_transactions t JOIN stock_documents d ON d.id=t.source_document_id WHERE d.notes LIKE $1 ORDER BY t.created_at`, [marker]),
    db.query(`SELECT r.document_id,r.document_line_id,r.quantity,r.status FROM stock_reservations r JOIN stock_documents d ON d.id=r.document_id WHERE d.notes LIKE $1 ORDER BY r.created_at`, [marker]),
    db.query(`SELECT c.location_id,i.item_code,c.capacity,c.notes FROM location_item_capacities c JOIN items i ON i.id=c.item_id JOIN warehouse_locations l ON l.id=c.location_id JOIN warehouses w ON w.id=l.warehouse_id WHERE w.warehouse_code LIKE 'TEST-FUNC-%'`, []),
    db.query(`SELECT r.location_id,i.item_code,r.allowed,r.notes FROM location_item_rules r JOIN items i ON i.id=r.item_id JOIN warehouse_locations l ON l.id=r.location_id JOIN warehouses w ON w.id=l.warehouse_id WHERE w.warehouse_code LIKE 'TEST-FUNC-%'`, []),
    db.query(`SELECT scope_type,warehouse_id,zone_id,location_id,status,reason FROM warehouse_operation_locks WHERE warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_code LIKE 'TEST-FUNC-%')`, []),
  ]);
  return { runKey, documents, approvals, balances, transactions, reservations, capacities, rules, locks };
}

async function run() {
  const db = createDataSource();
  await db.initialize();
  await seedFunctionalWarehouse(db);
  await db.query(`INSERT INTO functional_test_runs(run_key,status,report) VALUES($1,'RUNNING','[]'::jsonb)`, [runKey]);
  try {
    const admin = await login('admin'); const warehouse = await login('warehouse'); const limited = await login('warehouse-limited'); const production = await login('production');
    const rows = await db.query(`SELECT w.warehouse_code code,w.id warehouse_id,z.code zone_code,z.id zone_id,l.code location_code,l.id location_id
      FROM warehouses w JOIN warehouse_zones z ON z.warehouse_id=w.id JOIN warehouse_locations l ON l.zone_id=z.id WHERE w.warehouse_code LIKE 'TEST-FUNC-%'`);
    const row = (warehouseCode: string, suffix: string) => {
      const match = rows.find((value: any) => value.code === warehouseCode && value.location_code.endsWith(suffix));
      if (!match) throw new Error(`缺少测试库位 ${warehouseCode} ${suffix}`); return match;
    };
    const rawA = row('TEST-FUNC-RAW-A', 'A-01'), rawA2 = row('TEST-FUNC-RAW-A', 'A-02'), rawWarn = row('TEST-FUNC-RAW-A', 'B-01'), rawFull = row('TEST-FUNC-RAW-A', 'B-02');
    const rawB = row('TEST-FUNC-RAW-B', 'A-01'), rawRule = row('TEST-FUNC-RAW-B', 'B-01'), rawLocked = row('TEST-FUNC-RAW-B', 'B-02'), fgA = row('TEST-FUNC-FG-A', 'A-01'), fgB = row('TEST-FUNC-FG-B', 'A-01'), fgB2 = row('TEST-FUNC-FG-B', 'A-02'), defect = row('TEST-FUNC-DEF', 'A-01');
    const items = await db.query(`SELECT id,item_code code FROM items WHERE item_code LIKE 'TEST-FUNC-%'`);
    const item = (code: string) => items.find((value: any) => value.code === code)?.id;
    const motor = item('TEST-FUNC-M-001'), shell = item('TEST-FUNC-M-002'), bolt = item('TEST-FUNC-M-003'), resin = item('TEST-FUNC-M-004'), device = item('TEST-FUNC-FG-001');
    const batches = await db.query(`SELECT b.id,b.batch_no,i.item_code FROM inventory_batches b JOIN items i ON i.id=b.item_id WHERE b.batch_no LIKE 'TEST-FUNC-%'`);
    const batch = (batchNo: string) => batches.find((value: any) => value.batch_no === batchNo)?.id;

    await test('V2 基线在每个适用测试仓为每种物料保留至少 10 个可用库存', async () => {
      const available = await db.query(`WITH reserved AS (SELECT warehouse_id,item_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY warehouse_id,item_id)
        SELECT w.warehouse_code "warehouseCode",i.item_code "itemCode",(COALESCE(sum(b.on_hand_qty-b.frozen_qty),0)-COALESCE(max(r.qty),0))::numeric(18,0)::text quantity
        FROM warehouses w JOIN items i ON (w.warehouse_type='RAW' AND i.item_type='MATERIAL') OR (w.warehouse_type='FG' AND i.item_type='FINISHED_GOOD')
        LEFT JOIN stock_balances b ON b.warehouse_id=w.id AND b.item_id=i.id LEFT JOIN reserved r ON r.warehouse_id=w.id AND r.item_id=i.id
        WHERE w.warehouse_code IN ('TEST-FUNC-RAW-A','TEST-FUNC-RAW-B','TEST-FUNC-FG-A','TEST-FUNC-FG-B') AND i.item_code LIKE 'TEST-FUNC-%'
        GROUP BY w.warehouse_code,i.item_code ORDER BY w.warehouse_code,i.item_code`);
      const missing = available.filter((row: any) => Number(row.quantity) < 10);
      if (missing.length) throw new Error(`V2 测试库存不足：${missing.map((row: any) => `${row.warehouseCode}/${row.itemCode}=${row.quantity}`).join(', ')}`);
    });

    await test('仓管创建原材料入库，管理员审批并过账', async () => {
      const doc = await submitAndApprove(warehouse, admin, '/stock-documents/material-inbound', { warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '7', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A') }] }, detail => detail.lines.map((line: any) => ({ documentLineId: line.id, disposition: 'NORMAL', warehouseId: rawA.warehouse_id, locationId: rawA.location_id, batchId: line.batchId, quantity: line.quantity })));
      if (!doc.transactions?.length) throw new Error('入库过账未生成流水');
    });
    await test('相同审批幂等键不会重复过账', async () => {
      const doc = await call(warehouse, '/stock-documents/material-inbound', { method: 'POST', body: JSON.stringify({ warehouseId: rawA.warehouse_id, notes: runKey, lines: [{ itemId: motor, quantity: '1', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A') }] }) });
      await call(warehouse, `/stock-documents/${doc.id}/submit`, { method: 'POST' });
      const detail = await call(admin, `/stock-documents/${doc.id}`);
      const key = `${runKey}-idempotent-approve`;
      const body = { receiptAllocations: detail.lines.map((line: any) => ({ documentLineId: line.id, disposition: 'NORMAL', warehouseId: rawA.warehouse_id, locationId: rawA.location_id, batchId: line.batchId, quantity: line.quantity })) };
      await call(admin, `/approvals/${doc.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const [{ count: before }] = await db.query(`SELECT count(*)::int count FROM stock_transactions WHERE source_document_id=$1`, [doc.id]);
      await call(admin, `/approvals/${doc.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const [{ count: after }] = await db.query(`SELECT count(*)::int count FROM stock_transactions WHERE source_document_id=$1`, [doc.id]);
      if (Number(before) !== Number(after) || Number(after) !== 1) throw new Error('审批幂等重试重复生成了库存流水');
    });
    await test('成品出库与跨仓移库均完成审批过账', async () => {
      await submitAndApprove(warehouse, admin, '/stock-documents/finished-inbound', { warehouseId: fgB.warehouse_id, lines: [{ itemId: device, quantity: '2', locationId: fgB2.location_id, batchId: batch('TEST-FUNC-FG1-B') }] }, detail => detail.lines.map((line: any) => ({ documentLineId: line.id, disposition: 'NORMAL', warehouseId: fgB.warehouse_id, locationId: fgB2.location_id, batchId: line.batchId, quantity: line.quantity })));
      await submitAndApprove(warehouse, admin, '/stock-documents/finished-outbound', { warehouseId: fgB.warehouse_id, lines: [{ itemId: device, quantity: '1', locationId: fgB2.location_id, batchId: batch('TEST-FUNC-FG1-B') }] });
      const move = await submitAndApprove(warehouse, admin, '/stock-documents/move', { warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '3', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A'), targetWarehouseId: rawB.warehouse_id, targetLocationId: rawB.location_id, targetBatchId: batch('TEST-FUNC-M1-A') }] });
      if (move.documentType !== 'STOCK_MOVE' || move.transactions.length < 2) throw new Error('移库未生成来源与目标流水');
    });
    await test('自动分配预览按可用库存返回完整方案', async () => {
      const preview = await call(warehouse, '/stock-documents/allocation-preview', { method: 'POST', body: JSON.stringify({ operationType: 'OUTBOUND', warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '5' }] }) });
      if (!preview.allocations?.length) throw new Error('自动分配未返回明细');
    });
    await test('盘点与库存调整走审批及流水闭环', async () => {
      const [balance] = await db.query(`SELECT on_hand_qty::text quantity FROM stock_balances WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3 AND batch_id=$4`, [rawA.warehouse_id, rawA.location_id, motor, batch('TEST-FUNC-M1-A')]);
      if (!balance) throw new Error('盘点前未找到测试库存余额');
      const check = await submitAndApprove(warehouse, admin, '/stock-documents/stock-check', { warehouseId: rawA.warehouse_id, lines: [{ locationId: rawA.location_id, itemId: motor, batchId: batch('TEST-FUNC-M1-A'), countedQty: balance.quantity }] });
      if (check.documentType !== 'STOCK_CHECK') throw new Error('盘点单类型错误');
      await submitAndApprove(warehouse, admin, '/stock-documents/inventory-adjustment', { warehouseId: rawA.warehouse_id, lines: [{ locationId: rawA2.location_id, itemId: motor, batchId: batch('TEST-FUNC-M1-B'), adjustmentQty: '1' }] });
    });
    await test('盘点差异、撤回、驳回重提与账面冲突均受控', async () => {
      const current = async () => (await db.query(`SELECT on_hand_qty::text quantity FROM stock_balances WHERE warehouse_id=$1 AND location_id=$2 AND item_id=$3 AND batch_id=$4`, [rawA.warehouse_id, rawA.location_id, motor, batch('TEST-FUNC-M1-A')]))[0];
      const createCheck = (countedQty: string) => call(warehouse, '/stock-documents/stock-check', { method: 'POST', body: JSON.stringify({ warehouseId: rawA.warehouse_id, notes: runKey, lines: [{ locationId: rawA.location_id, itemId: motor, batchId: batch('TEST-FUNC-M1-A'), countedQty }] }) });
      const before = await current();
      const positive = await createCheck(String(Number(before.quantity) + 2)); await call(warehouse, `/stock-documents/${positive.id}/submit`, { method: 'POST' }); await call(admin, `/approvals/${positive.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-check-positive` }, body: '{}' });
      const positivePosted = await call(admin, `/stock-documents/${positive.id}`); if (positivePosted.stockCheckLines?.[0]?.differenceQty !== '2' || !positivePosted.transactions?.length) throw new Error('正差异盘点未生成正确流水');
      const afterPositive = await current();
      const negative = await createCheck(String(Number(afterPositive.quantity) - 2)); await call(warehouse, `/stock-documents/${negative.id}/submit`, { method: 'POST' }); await call(admin, `/approvals/${negative.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-check-negative` }, body: '{}' });
      const negativePosted = await call(admin, `/stock-documents/${negative.id}`); if (negativePosted.stockCheckLines?.[0]?.differenceQty !== '-2' || !negativePosted.transactions?.length) throw new Error('负差异盘点未生成正确流水');
      const withdraw = await createCheck((await current()).quantity); await call(warehouse, `/stock-documents/${withdraw.id}/submit`, { method: 'POST' }); await call(warehouse, `/approvals/${withdraw.id}/revoke`, { method: 'POST' }); if ((await call(warehouse, `/stock-documents/${withdraw.id}`)).status !== 'DRAFT') throw new Error('盘点撤回未回到草稿');
      const rejected = await createCheck((await current()).quantity); await call(warehouse, `/stock-documents/${rejected.id}/submit`, { method: 'POST' }); await call(admin, `/approvals/${rejected.id}/reject`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-check-reject` }, body: JSON.stringify({ reason: `${runKey} 驳回验证` }) }); if ((await call(warehouse, `/stock-documents/${rejected.id}`)).status !== 'REJECTED') throw new Error('盘点驳回状态错误'); await call(warehouse, `/stock-documents/${rejected.id}/stock-check`, { method: 'PATCH', body: JSON.stringify({ warehouseId: rawA.warehouse_id, notes: runKey, lines: [{ locationId: rawA.location_id, itemId: motor, batchId: batch('TEST-FUNC-M1-A'), countedQty: (await current()).quantity }] }) }); await call(warehouse, `/stock-documents/${rejected.id}/submit`, { method: 'POST' }); await call(admin, `/approvals/${rejected.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-check-resubmit` }, body: '{}' });
      const conflict = await createCheck((await current()).quantity); await call(warehouse, `/stock-documents/${conflict.id}/submit`, { method: 'POST' }); await submitAndApprove(warehouse, admin, '/stock-documents/inventory-adjustment', { warehouseId: rawA.warehouse_id, lines: [{ locationId: rawA.location_id, itemId: motor, batchId: batch('TEST-FUNC-M1-A'), adjustmentQty: '1' }] }); await expectFailure('盘点账面变化阻断审批', () => call(admin, `/approvals/${conflict.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-check-conflict` }, body: '{}' }), 'STOCK_CHECK_SNAPSHOT_CONFLICT');
      await call(warehouse, `/stock-documents/${conflict.id}/stock-check`, { method: 'PATCH', body: JSON.stringify({ warehouseId: rawA.warehouse_id, notes: runKey, lines: [{ locationId: rawA.location_id, itemId: motor, batchId: batch('TEST-FUNC-M1-A'), countedQty: (await current()).quantity }] }) }); await call(warehouse, `/stock-documents/${conflict.id}/submit`, { method: 'POST' }); await call(admin, `/approvals/${conflict.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-check-conflict-retry` }, body: '{}' });
    });
    await test('入库与移库自动分配覆盖拆分、无限容量与目标限制', async () => {
      const inbound = await call(warehouse, '/stock-documents/allocation-preview', { method: 'POST', body: JSON.stringify({ operationType: 'INBOUND', warehouseId: rawA.warehouse_id, lines: [{ itemId: shell, quantity: '30' }] }) });
      if (inbound.allocations.length < 2 || inbound.allocations[0].locationId !== rawWarn.location_id) throw new Error('入库自动分配未优先使用已有物料并按容量拆分');
      const move = await call(warehouse, '/stock-documents/allocation-preview', { method: 'POST', body: JSON.stringify({ operationType: 'MOVE', warehouseId: rawA.warehouse_id, targetWarehouseId: rawB.warehouse_id, lines: [{ itemId: motor, quantity: '5' }] }) });
      if (!move.allocations.length || move.allocations.some((row: any) => row.locationId === row.targetLocationId) || move.moveCategory !== 'TRANSFER_WAREHOUSE') throw new Error('移库自动分配未返回有效跨仓方案');
      await expectFailure('锁定目标库位拒绝自动分配', () => call(warehouse, '/stock-documents/allocation-preview', { method: 'POST', body: JSON.stringify({ operationType: 'INBOUND', warehouseId: rawA.warehouse_id, targetLocationId: rawLocked.location_id, lines: [{ itemId: motor, quantity: '1' }] }) }), 'LOCATION_CAPACITY_EXCEEDED');
      await expectFailure('禁止准入目标拒绝自动分配', () => call(warehouse, '/stock-documents/allocation-preview', { method: 'POST', body: JSON.stringify({ operationType: 'INBOUND', warehouseId: rawB.warehouse_id, targetLocationId: rawRule.location_id, lines: [{ itemId: motor, quantity: '1' }] }) }), 'LOCATION_CAPACITY_EXCEEDED');
    });
    await test('原材料不良品可退货、维修后重新入库', async () => {
      const inbound = await submitAndApprove(warehouse, admin, '/stock-documents/material-inbound', { warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '2', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A') }] }, detail => detail.lines.map((line: any) => ({ documentLineId: line.id, disposition: 'DEFECTIVE', warehouseId: defect.warehouse_id, locationId: defect.location_id, batchId: line.batchId, quantity: line.quantity, defectReason: `${runKey} 来料不良` })));
      const lots = await call(admin, '/approvals/defective-items?keyword=TEST-FUNC-M-001&pageSize=100');
      const lot = lots.items.find((value: any) => value.sourceDocumentNo === inbound.documentNo);
      if (!lot) throw new Error('未生成原材料不良品批次');
      const result = await call(admin, `/approvals/defective-items/${lot.id}/process`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-def-return` }, body: JSON.stringify({ action: 'RETURN', quantity: '1', reason: `${runKey} 供应商退货` }) });
      if (result.remainingQty !== '1') throw new Error('不良品退货剩余数量错误');
      const repaired = await call(admin, `/approvals/defective-items/${lot.id}/process`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-def-repair` }, body: JSON.stringify({ action: 'REPAIR_RESTOCK', quantity: '1', reason: `${runKey} 维修合格重新入库`, targetWarehouseId: rawA.warehouse_id, targetLocationId: rawA2.location_id }) });
      if (repaired.remainingQty !== '0' || repaired.status !== 'POSTED') throw new Error('维修重新入库未完成过账');
    });
    await test('成品不良品可退回生产任务', async () => {
      const order = await call(production, '/production-orders', { method: 'POST', body: JSON.stringify({ finishedGoodId: device, plannedQty: '5', defaultIssueWarehouseId: rawA.warehouse_id, notes: runKey }) });
      await call(production, `/production-orders/${order.id}/release`, { method: 'POST' });
      const inbound = await submitAndApprove(warehouse, admin, '/stock-documents/finished-inbound', { warehouseId: fgA.warehouse_id, lines: [{ itemId: device, quantity: '2', locationId: fgA.location_id, batchId: batch('TEST-FUNC-FG1-A') }] }, detail => detail.lines.map((line: any) => ({ documentLineId: line.id, disposition: 'DEFECTIVE', warehouseId: defect.warehouse_id, locationId: defect.location_id, batchId: line.batchId, quantity: line.quantity, defectReason: `${runKey} 成品不良` })));
      const lots = await call(admin, '/approvals/defective-items?keyword=TEST-FUNC-FG-001&pageSize=100');
      const lot = lots.items.find((value: any) => value.sourceDocumentNo === inbound.documentNo);
      if (!lot) throw new Error('未生成成品不良品批次');
      await call(admin, `/approvals/defective-items/${lot.id}/process`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-def-production` }, body: JSON.stringify({ action: 'RETURN_PRODUCTION', quantity: '1', reason: `${runKey} 返工`, productionOrderId: order.id }) });
    });
    await expectFailure('满库库位拒绝入库', () => call(warehouse, '/stock-documents/material-inbound', { method: 'POST', body: JSON.stringify({ warehouseId: rawFull.warehouse_id, lines: [{ itemId: bolt, quantity: '1', locationId: rawFull.location_id, batchId: batch('TEST-FUNC-M3-A') }] }) }), 'LOCATION_CAPACITY_EXCEEDED');
    await expectFailure('禁止准入规则拒绝入库', () => call(warehouse, '/stock-documents/material-inbound', { method: 'POST', body: JSON.stringify({ warehouseId: rawRule.warehouse_id, lines: [{ itemId: motor, quantity: '1', locationId: rawRule.location_id, batchId: batch('TEST-FUNC-M1-A') }] }) }), 'LOCATION_ITEM_NOT_ALLOWED');
    await expectFailure('作业锁拒绝库存操作', () => call(warehouse, '/stock-documents/material-inbound', { method: 'POST', body: JSON.stringify({ warehouseId: rawLocked.warehouse_id, lines: [{ itemId: motor, quantity: '1', locationId: rawLocked.location_id, batchId: batch('TEST-FUNC-M1-A') }] }) }), 'WAREHOUSE_OPERATION_LOCKED');
    await expectFailure('跨仓型移库被拒绝', () => call(warehouse, '/stock-documents/move', { method: 'POST', body: JSON.stringify({ warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '1', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A'), targetWarehouseId: fgA.warehouse_id, targetLocationId: fgA.location_id }] }) }), 'VALIDATION_ERROR');
    await test('仓库、库区、库位锁拦截操作且解锁后恢复', async () => {
      for (const [scopeType, id] of [['warehouse', rawA.warehouse_id], ['zone', rawA.zone_id], ['location', rawA.location_id]] as const) {
        const lock = await call(admin, '/warehouse-management/operation-locks', { method: 'POST', body: JSON.stringify({ scopeType, id, reason: `${runKey} ${scopeType} 锁验证` }) });
        await expectFailure(`${scopeType} 锁拦截创建`, () => call(warehouse, '/stock-documents/material-inbound', { method: 'POST', body: JSON.stringify({ warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '1', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A') }] }) }), 'WAREHOUSE_OPERATION_LOCKED');
        await call(admin, `/warehouse-management/operation-locks/${lock.id}/release`, { method: 'POST' });
      }
      const draft = await call(warehouse, '/stock-documents/material-inbound', { method: 'POST', body: JSON.stringify({ warehouseId: rawA.warehouse_id, notes: runKey, lines: [{ itemId: motor, quantity: '1', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A') }] }) });
      await call(warehouse, `/stock-documents/${draft.id}/submit`, { method: 'POST' }); const lock = await call(admin, '/warehouse-management/operation-locks', { method: 'POST', body: JSON.stringify({ scopeType: 'location', id: rawA.location_id, reason: `${runKey} 审批锁验证` }) });
      const detail = await call(admin, `/stock-documents/${draft.id}`); const allocation = { receiptAllocations: detail.lines.map((line: any) => ({ documentLineId: line.id, disposition: 'NORMAL', warehouseId: rawA.warehouse_id, locationId: rawA.location_id, batchId: line.batchId, quantity: line.quantity })) };
      await expectFailure('作业锁拦截审批过账', () => call(admin, `/approvals/${draft.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-locked-approve` }, body: JSON.stringify(allocation) }), 'WAREHOUSE_OPERATION_LOCKED'); await call(admin, `/warehouse-management/operation-locks/${lock.id}/release`, { method: 'POST' }); await call(admin, `/approvals/${draft.id}/approve`, { method: 'POST', headers: { 'Idempotency-Key': `${runKey}-unlock-approve` }, body: JSON.stringify(allocation) });
    });
    await test('可用库存不足提交失败且不保留预占', async () => {
      const doc = await call(warehouse, '/stock-documents/finished-outbound', { method: 'POST', body: JSON.stringify({ warehouseId: fgB.warehouse_id, notes: runKey, lines: [{ itemId: device, quantity: '999999', locationId: fgB.location_id, batchId: batch('TEST-FUNC-FG1-A') }] }) });
      await expectFailure('可用库存不足拒绝提交', () => call(warehouse, `/stock-documents/${doc.id}/submit`, { method: 'POST' }), 'INSUFFICIENT_STOCK');
      const [{ count }] = await db.query(`SELECT count(*)::int count FROM stock_reservations WHERE document_id=$1 AND status='ACTIVE'`, [doc.id]);
      if (Number(count)) throw new Error('库存不足失败后仍保留库存预占');
    });
    await expectFailure('生产人员无仓库管理读取权限', () => call(production, '/warehouse-management/warehouses'), 'FORBIDDEN');
    await test('受限仓管仅可访问已绑定仓库且不能跨仓移库', async () => {
      const accessible = await call(limited, '/warehouse-management/warehouses'); if (accessible.length !== 1 || accessible[0].warehouseCode !== 'TEST-FUNC-RAW-A') throw new Error('受限仓管仓库列表未隔离');
      await expectFailure('受限仓管读取未绑定仓库被拒绝', () => call(limited, `/warehouse-management/warehouses/${rawB.warehouse_id}/zones`), 'FORBIDDEN');
      await expectFailure('受限仓管跨仓移库被拒绝', () => call(limited, '/stock-documents/move', { method: 'POST', body: JSON.stringify({ warehouseId: rawA.warehouse_id, lines: [{ itemId: motor, quantity: '1', locationId: rawA.location_id, batchId: batch('TEST-FUNC-M1-A'), targetWarehouseId: rawB.warehouse_id, targetLocationId: rawB.location_id }] }) }), 'FORBIDDEN');
    });
    await test('容量状态、低库存告警与仓管消息均可见', async () => {
      const [normal, warning, full, unlimited] = await Promise.all([rawA, rawWarn, rawFull, rawA2].map((location: any) => call(warehouse, `/warehouse-management/locations/${location.location_id}/materials?pageSize=100`)));
      const find = (result: any, itemId: string) => result.items.find((row: any) => row.itemId === itemId);
      const normalRow = find(normal, resin), warningRow = find(warning, shell), fullRow = find(full, bolt), unlimitedRow = find(unlimited, motor);
      if (!normalRow || Number(normalRow.usageRate) >= 80 || Number(warningRow?.usageRate) < 80 || Number(fullRow?.usageRate) < 100 || unlimitedRow?.capacityQty !== null) throw new Error('容量状态样例不符合不限量/正常/预警/满库规则');
      const detail = await call(warehouse, `/warehouse-management/context/warehouse/${rawA.warehouse_id}`); if (!detail.alerts?.some((row: any) => ['LOW_STOCK', 'CAPACITY_WARNING', 'CAPACITY_FULL'].includes(row.alertType))) throw new Error('仓库风险告警未生成');
      const [{ count }] = await db.query(`SELECT count(*)::int count FROM notification n JOIN users u ON u.id=n.receiver_user_id WHERE u.username='warehouse' AND n.type='INVENTORY_ALERT' AND n.business_id=$1`, [rawA.warehouse_id]); if (!Number(count)) throw new Error('已绑定仓管未收到库存风险消息');
    });
    await test('运行数据余额与流水一致', async () => {
      const [{ mismatch }] = await db.query(`SELECT count(*)::int mismatch FROM stock_balances b WHERE b.warehouse_id IN (SELECT id FROM warehouses WHERE warehouse_code LIKE 'TEST-FUNC-%') AND b.on_hand_qty <> COALESCE((SELECT sum(t.delta_qty) FROM stock_transactions t WHERE t.warehouse_id=b.warehouse_id AND t.location_id=b.location_id AND t.item_id=b.item_id AND t.batch_id IS NOT DISTINCT FROM b.batch_id),0)`);
      if (Number(mismatch)) throw new Error(`发现 ${mismatch} 条余额流水不一致`);
    });
    await db.query(`UPDATE functional_test_runs SET status='PASSED',report=$1,completed_at=now() WHERE run_key=$2`, [JSON.stringify(report), runKey]);
    console.log(JSON.stringify({ runKey, status: 'PASSED', report }, null, 2));
  } catch (error: any) {
    const diagnostics = await collectFailureDiagnostics(db).catch((diagnosticError: any) => ({ diagnosticError: diagnosticError.message }));
    const failedReport = [...report, { name: '执行中断', status: 'FAILED' as const, detail: { message: error.message, status: error.status, body: error.body, diagnostics } }];
    await db.query(`UPDATE functional_test_runs SET status='FAILED',report=$1,completed_at=now() WHERE run_key=$2`, [JSON.stringify(failedReport), runKey]);
    console.error(JSON.stringify({ runKey, status: 'FAILED', report: failedReport, error: { message: error.message, status: error.status, body: error.body } }, null, 2));
    process.exitCode = 1;
  } finally { await db.destroy(); }
}

if (require.main === module) run();
