import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class AuditService {
  constructor(private readonly db: DataSource) {}
  log(userId: string | null, action: string, entityType: string, entityId?: string, details?: unknown, manager?: EntityManager) {
    const executor = manager || this.db.manager;
    return executor.query(
      `INSERT INTO operation_logs(user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)`,
      [userId, action, entityType, entityId || null, details ? JSON.stringify(details) : null],
    );
  }
}
