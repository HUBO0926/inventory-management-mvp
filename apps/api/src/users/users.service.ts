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
        u.department,u.position,u.phone,u.email,r.code role,r.id "roleId",r.name "roleName",
        u.status,u.last_login_at "lastLoginAt",u.remarks,u.created_at "createdAt"
       FROM users u JOIN roles r ON r.id=u.role_id
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
      const hash = await bcrypt.hash(dto.password, 12);
      const [role] = await this.db.query(
        `SELECT id,code FROM roles WHERE id=$1 AND status='ACTIVE'`, [dto.roleId],
      );
      if (!role) throw new BusinessException('VALIDATION_ERROR', '角色不存在或已停用');
      const [row] = await this.db.query(
        `INSERT INTO users(username,name,password_hash,role,role_id,employee_name,employee_no,department,position,phone,email,remarks)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id,username,name,role,role_id "roleId",status,employee_name "employeeName"`,
        [dto.username.trim(), employeeName, hash, role.code, role.id,
          employeeName, dto.employeeNo?.trim() || null, dto.department?.trim() || null,
          dto.position?.trim() || null, dto.phone?.trim() || null, dto.email?.trim() || null,
          dto.remarks?.trim() || null],
      );
      await this.audit.log(userId, 'CREATE_USER', 'users', row.id, dto);
      return row;
    } catch (e: any) {
      if (e.code === '23505') throw new BusinessException('DUPLICATE_CODE', '账号已存在');
      throw e;
    }
  }

  async update(id: string, dto: any, userId: string) {
    const fields: string[] = [];
    const params: any[] = [];
    const map: Record<string, string> = {
      employeeName: 'employee_name', employeeNo: 'employee_no',
      department: 'department', position: 'position',
      phone: 'phone', email: 'email', remarks: 'remarks', status: 'status',
      roleId: 'role_id',
    };
    for (const [key, col] of Object.entries(map)) {
      if (dto[key] !== undefined) {
        params.push(dto[key]);
        fields.push(`${col}=$${params.length}`);
      }
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
}
