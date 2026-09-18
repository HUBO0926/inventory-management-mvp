import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from './migrations/1710000000000-InitialSchema';
import { DashboardIndexes1720000000000 } from './migrations/1720000000000-DashboardIndexes';
import { FinishedInbound1730000000000 } from './migrations/1730000000000-FinishedInbound';
import { V110Foundation1740000000000 } from './migrations/1740000000000-V110Foundation';
import { V110Refactor1750000000000 } from './migrations/1750000000000-V110Refactor';
import { ItemArchiveImages1760000000000 } from './migrations/1760000000000-ItemArchiveImages';
import { ItemCategoryTypes1770000000000 } from './migrations/1770000000000-ItemCategoryTypes';
import { MasterDataFlexibility1780000000000 } from './migrations/1780000000000-MasterDataFlexibility';
import { DefectiveWarehouseAndMove1790000000000 } from './migrations/1790000000000-DefectiveWarehouseAndMove';
import { VirtualWarehousePermissions1800000000000 } from './migrations/1800000000000-VirtualWarehousePermissions';
import { WarehouseLocationManagement1810000000000 } from './migrations/1810000000000-WarehouseLocationManagement';
import { ApprovalCenter1820000000000 } from './migrations/1820000000000-ApprovalCenter';
import { ApprovalHistoryDocumentRetention1830000000000 } from './migrations/1830000000000-ApprovalHistoryDocumentRetention';
import { ProductionPicking1840000000000 } from './migrations/1840000000000-ProductionPicking';
import { InventoryManagement1850000000000 } from './migrations/1850000000000-InventoryManagement';
import { IntegerQuantityDefectiveProcessing1860000000000 } from './migrations/1860000000000-IntegerQuantityDefectiveProcessing';
import { OrganizationApprovalBinding1870000000000 } from './migrations/1870000000000-OrganizationApprovalBinding';
import { ApprovalStateIntegrity1880000000000 } from './migrations/1880000000000-ApprovalStateIntegrity';
import { ProductionBomManagement1890000000000 } from './migrations/1890000000000-ProductionBomManagement';
import { LocationItemCapacities1900000000000 } from './migrations/1900000000000-LocationItemCapacities';
import { RemoveSemiFinished1910000000000 } from './migrations/1910000000000-RemoveSemiFinished';
import { CapacityReservationsAndNotes1920000000000 } from './migrations/1920000000000-CapacityReservationsAndNotes';
import { WarehouseWorkspacePermissions1930000000000 } from './migrations/1930000000000-WarehouseWorkspacePermissions';
import { WarehouseManagementWorkbench1940000000000 } from './migrations/1940000000000-WarehouseManagementWorkbench';
import { FunctionalWarehouseTestRuns1950000000000 } from './migrations/1950000000000-FunctionalWarehouseTestRuns';

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
    migrations: [
      InitialSchema1710000000000,
      DashboardIndexes1720000000000,
      FinishedInbound1730000000000,
      V110Foundation1740000000000,
      V110Refactor1750000000000,
      ItemArchiveImages1760000000000,
      ItemCategoryTypes1770000000000,
      MasterDataFlexibility1780000000000,
      DefectiveWarehouseAndMove1790000000000,
      VirtualWarehousePermissions1800000000000,
      WarehouseLocationManagement1810000000000,
      ApprovalCenter1820000000000,
      ApprovalHistoryDocumentRetention1830000000000,
      ProductionPicking1840000000000,
      InventoryManagement1850000000000,
      IntegerQuantityDefectiveProcessing1860000000000,
      OrganizationApprovalBinding1870000000000,
      ApprovalStateIntegrity1880000000000,
      ProductionBomManagement1890000000000,
      LocationItemCapacities1900000000000,
      RemoveSemiFinished1910000000000,
      CapacityReservationsAndNotes1920000000000,
      WarehouseWorkspacePermissions1930000000000,
    WarehouseManagementWorkbench1940000000000,
    FunctionalWarehouseTestRuns1950000000000,
    ],
    extra: { options: '-c timezone=Asia/Shanghai' },
    logging: process.env.DB_LOGGING === 'true',
  });
};

export default createDataSource();
