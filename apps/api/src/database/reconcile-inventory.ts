import 'reflect-metadata';
import { createDataSource } from './data-source';

async function run() {
  const db = createDataSource();
  await db.initialize();
  try {
    const differences = await db.query(`
      WITH ledger AS (
        SELECT warehouse_id,location_id,item_id,batch_id,sum(delta_qty)::numeric(18,4) ledger_qty
        FROM stock_transactions GROUP BY warehouse_id,location_id,item_id,batch_id
      )
      SELECT w.warehouse_code warehouse,loc.code location,i.item_code item,
        batch.batch_no batch,COALESCE(sb.on_hand_qty,0)::text balance,
        COALESCE(l.ledger_qty,0)::text ledger,
        (COALESCE(sb.on_hand_qty,0)-COALESCE(l.ledger_qty,0))::text difference
      FROM stock_balances sb
      FULL OUTER JOIN ledger l ON l.warehouse_id=sb.warehouse_id
        AND l.location_id=sb.location_id AND l.item_id=sb.item_id
        AND l.batch_id IS NOT DISTINCT FROM sb.batch_id
      JOIN warehouses w ON w.id=COALESCE(sb.warehouse_id,l.warehouse_id)
      JOIN warehouse_locations loc ON loc.id=COALESCE(sb.location_id,l.location_id)
      JOIN items i ON i.id=COALESCE(sb.item_id,l.item_id)
      LEFT JOIN inventory_batches batch ON batch.id=COALESCE(sb.batch_id,l.batch_id)
      WHERE COALESCE(sb.on_hand_qty,0)<>COALESCE(l.ledger_qty,0)
      ORDER BY warehouse,location,item,batch NULLS FIRST
    `);
    if (differences.length) {
      console.error(JSON.stringify({ consistent: false, differences }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ consistent: true, checkedAt: new Date().toISOString() }));
  } finally {
    await db.destroy();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
