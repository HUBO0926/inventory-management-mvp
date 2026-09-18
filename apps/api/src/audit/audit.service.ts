import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class AuditService {
  constructor(private readonly db: DataSource) {}

  log(
    userId: string | null,
    action: string,
    entityType: string,
    entityId?: string,
    details?: unknown,
    manager?: EntityManager,
    requestId?: string,
  ) {
    const executor = manager || this.db.manager;
    return executor.query(
      `INSERT INTO operation_logs(user_id,action,entity_type,entity_id,details,app_version)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        userId, action, entityType, entityId || null,
        details ? JSON.stringify(details) : null,
        process.env.APP_VERSION || '1.7.0',
      ],
    );
  }

  /** Write detailed business operation log with before/after data */
  async businessLog(params: {
    module?: string;
    businessType: string;
    businessId?: string;
    businessNo?: string;
    action: string;
    actionDescription?: string;
    operatorUserId?: string;
    operatorUsername?: string;
    operatorName?: string;
    operatorDepartment?: string;
    beforeData?: unknown;
    afterData?: unknown;
    reason?: string;
    operationResult?: string;
    failureReason?: string;
    requestId?: string;
    ipAddress?: string;
    manager?: EntityManager;
  }) {
    const executor = params.manager || this.db.manager;

    // Compute changed fields from before/after
    let changeFields: string[] | null = null;
    if (params.beforeData && params.afterData && typeof params.beforeData === 'object' && typeof params.afterData === 'object') {
      const before = params.beforeData as Record<string, unknown>;
      const after = params.afterData as Record<string, unknown>;
      changeFields = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    }

    await executor.query(
      `INSERT INTO business_operation_logs(
        module,business_type,business_id,business_no,action,action_description,
        operator_user_id,operator_username,operator_name,operator_department,
        before_data,after_data,change_fields,reason,
        ip_address,request_id,operation_result,failure_reason
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        params.module || 'system', params.businessType, params.businessId || null, params.businessNo || null,
        params.action, params.actionDescription || null,
        params.operatorUserId || null, params.operatorUsername || null, params.operatorName || null, params.operatorDepartment || null,
        params.beforeData ? JSON.stringify(params.beforeData) : null,
        params.afterData ? JSON.stringify(params.afterData) : null,
        changeFields ? JSON.stringify(changeFields) : null,
        params.reason || null,
        params.ipAddress || null, null,
        params.requestId || null,
        params.operationResult || 'SUCCESS', params.failureReason || null,
      ],
    );
  }
}
