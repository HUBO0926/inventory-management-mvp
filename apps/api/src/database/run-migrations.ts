import { createDataSource } from './data-source';

async function run() {
  const db = createDataSource();
  await db.initialize();
  const migrations = await db.runMigrations();
  console.log(`Migrations executed: ${migrations.map((m) => m.name).join(', ') || 'none'}`);
  await db.destroy();
}

run().catch((error) => { console.error(error); process.exit(1); });
