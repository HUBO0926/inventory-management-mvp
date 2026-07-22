import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from './migrations/1710000000000-InitialSchema';
import { DashboardIndexes1720000000000 } from './migrations/1720000000000-DashboardIndexes';
import { FinishedInbound1730000000000 } from './migrations/1730000000000-FinishedInbound';

export const createDataSource = () => {
  const connection = process.env.DATABASE_URL
    ? { url: process.env.DATABASE_URL }
    : {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: Number(process.env.POSTGRES_PORT || 5434),
        database: process.env.POSTGRES_DB || 'inventory',
        username: process.env.POSTGRES_USER || 'inventory',
        password: process.env.POSTGRES_PASSWORD || 'inventory_dev',
      };

  return new DataSource({
    type: 'postgres',
    ...connection,
    migrations: [InitialSchema1710000000000, DashboardIndexes1720000000000, FinishedInbound1730000000000],
    logging: process.env.DB_LOGGING === 'true',
  });
};

export default createDataSource();
