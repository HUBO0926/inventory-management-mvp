import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { BusinessException } from '../common/business.exception';
import { AuditService } from '../audit/audit.service';
import { parsePage } from '../common/validation';
import { AuthUser } from '../common/constants';
import { snapshotUser } from '../common/snapshot';

@Injectable()
export class UsersService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService) {}

  async list(q: any) {
    const page = parsePage(q.page, 1);
    const pageSize = parsePage(q.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    const params: any[] = [];
    const where: string[] = ['u.deleted_at IS NULL'];
    if (q.keyword) {
      params.push(`%${q.keyword}%`);
      where.push(`(u.username ILIKE $${params.length} OR u.employee_name ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`u.status=$${params.length}`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const [{ count }] = await this.db.query(
      `SELECT count(*)::int count FROM users u ${clause}`, params,
    );
    params.push(pageSize, offset);
    const rows = await this.db.query(
      `SELECT u.id,u.username,u.name,u.employee_name "employeeName",u.employee_no "employeeNo",
        u.department,u.department_name "departmentName",u.position,u.position_type "positionType",u.manager_user_id "managerUserId",m.name "managerName",u.can_approve "canApprove",u.phone,u.email,r.code role,r.id "roleId",r.name "roleName",
        u.status,u.last_login_at "lastLoginAt",u.remarks,u.created_at "createdAt"
       FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN users m ON m.id=u.manager_user_id
       ${clause} ORDER BY u.username LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total: count, page, pageSize };
  }

  async create(dto: any, userId: string, operator: AuthUser) {
    try {
      const employeeName = dto.employeeName?.trim() || dto.name?.trim();
      if (!dto.password || dto.password.length < 8) {
        throw new BusinessException('VALIDATION_ERROR', '密码至少需要 8 位');
      }
      if (!employeeName) {
        throw new BusinessException('VALIDATION_ERROR', '人员姓名不能为空');
      }
      await this.validateOrganization(dto, undefined, operator);
      const hash = await bcrypt.hash(dto.password, 12);
      const [role] = await this.db.query(
        `SELECT id,code FROM roles WHERE id=$1 AND status='ACTIVE'`, [dto.roleId],
      );
      if (!role) throw new BusinessException('VALIDATION_ERROR', '角色不存在或已停用');
      const [row] = await this.db.query(
        `INSERT INTO users(username,name,password_hash,role,role_id,employee_name,employee_no,department,position,phone,email,remarks,position_type,manager_user_id,department_name,can_approve)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id,username,name,role,role_id "roleId",status,employee_name "employeeName",position_type "positionType",manager_user_id "managerUserId",department_name "departmentName",can_approve "canApprove"`,
        [dto.username.trim(), employeeName, hash, role.code, role.id,
          employeeName, dto.employeeNo?.trim() || null, dto.department?.trim() || null,
          dto.position?.trim() || null, dto.phone?.trim() || null, dto.email?.trim() || null,
          dto.remarks?.trim() || null, dto.positionType || null, dto.managerUserId || null,
          dto.departmentName?.trim() || dto.department?.trim() || null, Boolean(dto.canApprove)],
      );
      await this.audit.log(userId, 'CREATE_USER', 'users', row.id, dto);
      return row;
    } catch (e: any) {
      if (e.code === '23505') throw new BusinessException('DUPLICATE_CODE', '账号已存在');
      throw e;
    }
  }

  async update(id: string, dto: any, userId: string) {
    const [operator] = await this.db.query(`SELECT id,role FROM users WHERE id=$1`, [userId]);
    await this.validateOrganization(dto, id, operator);
    let roleCode: string | undefined;
    if (dto.roleId !== undefined) {
      const [role] = await this.db.query(`SELECT code FROM roles WHERE id=$1 AND status='ACTIVE'`, [dto.roleId]);
      if (!role) throw new BusinessException('VALIDATION_ERROR', '角色不存在或已停用');
      roleCode = role.code;
    }
    const fields: string[] = [];
    const params: any[] = [];
    const map: Record<string, string> = {
      employeeName: 'employee_name', employeeNo: 'employee_no',
      department: 'department', position: 'position',
      phone: 'phone', email: 'email', remarks: 'remarks', status: 'status',
      roleId: 'role_id',
      positionType: 'position_type', managerUserId: 'manager_user_id',
      departmentName: 'department_name', canApprove: 'can_approve',
    };
    for (const [key, col] of Object.entries(map)) {
      if (dto[key] !== undefined) {
        params.push(dto[key]);
        fields.push(`${col}=$${params.length}`);
      }
    }
    if (roleCode) {
      params.push(roleCode);
      fields.push(`role=$${params.length}`);
    }
    // If name field provided, also update employee_name (backward compat)
    if (dto.name !== undefined) {
      params.push(dto.name);
      fields.push(`employee_name=$${params.length}`);
      params.push(dto.name);
      fields.push(`name=$${params.length}`);
    }
    if (!fields.length) throw new BusinessException('VALIDATION_ERROR', '没有可更新的字段');
    params.push(id);
    fields.push(`updated_at=now()`);
    const [row] = await this.db.query(
      `UPDATE users SET ${fields.join(',')} WHERE id=$${params.length} AND deleted_at IS NULL
       RETURNING id,username,name,role,status,employee_name "employeeName",employee_no "employeeNo",department,position`,
      params,
    );
    if (!row) throw new BusinessException('NOT_FOUND', '账号不存在');
    await this.audit.log(userId, 'UPDATE_USER', 'users', id, dto);
    return row;
  }

  async status(id: string, status: string, userId: string) {
    const [row] = await this.db.query(
      `UPDATE users SET status=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL
       RETURNING id,username,name,role,status,employee_name "employeeName"`,
      [status, id],
    );
    if (!row) throw new BusinessException('NOT_FOUND', '账号不存在');
    await this.audit.log(userId, 'UPDATE_USER_STATUS', 'users', id, { status });
    return row;
  }

  async reset(id: string, password: string, userId: string) {
    if (!password || password.length < 8) {
      throw new BusinessException('VALIDATION_ERROR', '密码至少需要 8 位');
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await this.db.query(
      `UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL`,
      [hash, id],
    );
    if (!result[1]) throw new BusinessException('NOT_FOUND', '账号不存在');
    await this.audit.log(userId, 'RESET_PASSWORD', 'users', id);
    return { id };
  }

  async remove(id: string, userId: string) {
    // Check refs before soft-delete
    const refs = await this.db.query(
      `SELECT
        (SELECT count(*) FROM stock_documents WHERE created_by=$1 AND deleted_at IS NULL)::int docs,
        (SELECT count(*) FROM production_orders WHERE created_by=$1)::int orders,
        (SELECT count(*) FROM stock_transactions WHERE created_by=$1)::int txns`,
      [id],
    );
    const [{ docs, orders, txns }] = refs;
    if (docs > 0 || orders > 0 || txns > 0) {
      throw new BusinessException('REFERENCE_CONFLICT',
        '该账号存在业务记录，只能停用，不能删除', 409,
        { stockDocuments: docs, productionOrders: orders, transactions: txns },
      );
    }
    const [row] = await this.db.query(
      `UPDATE users SET deleted_at=now(),status='INACTIVE',updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [id],
    );
    if (!row) throw new BusinessException('NOT_FOUND', '账号不存在');
    await this.audit.log(userId, 'DELETE_USER', 'users', id);
    return { id };
  }

  async me(user: AuthUser) {
    const [row] = await this.db.query(
      `SELECT u.id,u.username,u.name,u.employee_name "employeeName",u.employee_no "employeeNo",
        u.department,u.position,u.phone,u.email,r.code role,r.id "roleId",r.name "roleName",
        u.status,u.last_login_at "lastLoginAt",u.remarks,u.created_at "createdAt",
        COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL),'{}') permissions
       FROM users u JOIN roles r ON r.id=u.role_id
       LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
       WHERE u.id=$1 AND u.deleted_at IS NULL GROUP BY u.id,r.id`,
      [user.id],
    );
    if (!row) throw new BusinessException('NOT_FOUND', '账号不存在');
    return row;
  }

  async get(id: string) {
    const [row] = await this.db.query(`SELECT u.id,u.username,u.name,u.employee_name "employeeName",u.department,u.department_name "departmentName",
      u.position,u.position_type "positionType",u.manager_user_id "managerUserId",m.name "managerName",u.can_approve "canApprove",u.status,
      r.code role,r.name "roleName" FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN users m ON m.id=u.manager_user_id
      WHERE u.id=$1 AND u.deleted_at IS NULL`, [id]);
    if (!row) throw new BusinessException('NOT_FOUND', '账号不存在');
    row.warehouses = await this.warehouses(id);
    return row;
  }

  async approvalManager(id: string) {
    const [row] = await this.db.query(`SELECT m.id,m.username,m.name "employeeName",m.position_type "positionType",m.department_name "departmentName",m.can_approve "canApprove"
      FROM users u LEFT JOIN users m ON m.id=u.manager_user_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
      WHERE u.id=$1 AND u.deleted_at IS NULL`, [id]);
    if (!row) throw new BusinessException('NOT_FOUND', '账号不存在');
    if (!row.id || !row.canApprove) throw new BusinessException('APPROVAL_MANAGER_MISSING', '当前账号尚未配置有效的上级审批人员');
    return row;
  }

  async warehouses(id: string) {
    return this.db.query(`SELECT w.id,w.warehouse_code "warehouseCode",w.display_name "displayName",wm.created_at "boundAt",u.name "boundByName"
      FROM warehouse_manager wm JOIN warehouses w ON w.id=wm.warehouse_id LEFT JOIN users u ON u.id=wm.created_by
      WHERE wm.user_id=$1 AND w.deleted_at IS NULL ORDER BY w.warehouse_code`, [id]);
  }

  async setWarehouses(userId: string, warehouseIds: string[], operatorId: string) {
    const unique = [...new Set(warehouseIds)];
    const qr = this.db.createQueryRunner(); await qr.connect(); await qr.startTransaction();
    try {
      const [manager] = await qr.query(`SELECT id FROM users WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL AND position_type='WAREHOUSE_MANAGER'`, [userId]);
      if (!manager) throw new BusinessException('VALIDATION_ERROR', '只能为启用的仓库管理员绑定仓库');
      const [{ count }] = await qr.query(`SELECT count(*)::int count FROM warehouses WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`, [unique]);
      if (Number(count) !== unique.length) throw new BusinessException('VALIDATION_ERROR', '包含不存在的仓库');
      await qr.query(`DELETE FROM warehouse_manager WHERE user_id=$1`, [userId]);
      if (unique.length) await qr.query(`INSERT INTO warehouse_manager(warehouse_id,user_id,created_by) SELECT unnest($1::uuid[]),$2,$3`, [unique, userId, operatorId]);
      await qr.commitTransaction();
      await this.audit.log(operatorId, 'UPDATE_WAREHOUSE_MANAGERS', 'users', userId, { warehouseIds: unique });
      return this.warehouses(userId);
    } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
  }

  private async validateOrganization(dto: any, targetId: string | undefined, operator: any) {
    let current: any;
    if (targetId) [current] = await this.db.query(`SELECT manager_user_id,position_type FROM users WHERE id=$1 AND deleted_at IS NULL`, [targetId]);
    const managerId = dto.managerUserId === undefined ? current?.manager_user_id : dto.managerUserId;
    const positionType = dto.positionType === undefined ? current?.position_type : dto.positionType;
    if (managerId === undefined && positionType === undefined) return;
    if (managerId && targetId && managerId === targetId) throw new BusinessException('VALIDATION_ERROR', '不能绑定自己为上级');
    if (managerId) {
      const [manager] = await this.db.query(`SELECT id FROM users WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL AND can_approve=true AND position_type IN ('MANAGER','SYSTEM_ADMIN')`, [managerId]);
      if (!manager) throw new BusinessException('VALIDATION_ERROR', '上级必须是启用且具备审批权限的人员');
      let cursor = managerId;
      for (let i = 0; i < 30; i++) {
        const [next] = await this.db.query(`SELECT manager_user_id FROM users WHERE id=$1`, [cursor]);
        if (!next?.manager_user_id) break;
        if (next.manager_user_id === targetId) throw new BusinessException('VALIDATION_ERROR', '上级关系不能形成循环');
        cursor = next.manager_user_id;
      }
    }
    if (['PRODUCTION','WAREHOUSE_MANAGER'].includes(positionType) && !managerId) throw new BusinessException('VALIDATION_ERROR', '生产人员和仓库管理员必须绑定上级审批人');
    if (targetId && operator?.role !== 'ADMIN' && (managerId !== undefined || dto.positionType !== undefined)) {
      throw new BusinessException('FORBIDDEN', '只有系统管理员可以维护人员组织关系');
    }
  }
}
