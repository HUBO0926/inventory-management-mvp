import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { AuthUser, Role } from '../common/constants';

/** Central server-side boundary for warehouse-scoped business operations. */
@Injectable()
export class WarehouseAccessService {
  constructor(private readonly db: DataSource) {}

  isGlobal(user?: AuthUser) {
    return user?.role === Role.ADMIN || Boolean(user?.permissions?.includes('warehouse.view-all'));
  }

  /** Returns null for a global user, otherwise the warehouses explicitly assigned to them. */
  async getAccessibleWarehouseIds(user?: AuthUser): Promise<string[] | null> {
    if (!user || this.isGlobal(user)) return null;
    const rows = await this.db.query(`SELECT warehouse_id "warehouseId" FROM warehouse_manager WHERE user_id=$1`, [user.id]);
    return rows.map((row: any) => row.warehouseId);
  }

  /** @deprecated Use getAccessibleWarehouseIds so every warehouse query has one vocabulary. */
  async managedWarehouseIds(user?: AuthUser): Promise<string[] | null> {
    return this.getAccessibleWarehouseIds(user);
  }

  async assertWarehouse(user: AuthUser | undefined, warehouseId: string, message = '当前账号未绑定该仓库') {
    if (this.isGlobal(user)) return;
    const [row] = await this.db.query(`SELECT 1 FROM warehouse_manager WHERE warehouse_id=$1 AND user_id=$2`, [warehouseId, user?.id]);
    if (!row) throw new BusinessException('FORBIDDEN', message, HttpStatus.FORBIDDEN);
  }

  async assertWarehouses(user: AuthUser | undefined, warehouseIds: Array<string | null | undefined>) {
    if (this.isGlobal(user)) return;
    const unique = [...new Set(warehouseIds.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return;
    const rows = await this.db.query(`SELECT warehouse_id "warehouseId" FROM warehouse_manager WHERE user_id=$1 AND warehouse_id=ANY($2::uuid[])`, [user?.id, unique]);
    if (rows.length !== unique.length) throw new BusinessException('FORBIDDEN', '移库操作需要同时具备来源仓和目标仓权限', HttpStatus.FORBIDDEN);
  }
}
