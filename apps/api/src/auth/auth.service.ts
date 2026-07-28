import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AuthUser } from '../common/constants';

@Injectable()
export class AuthService {
  constructor(private readonly db: DataSource, private readonly jwt: JwtService) {}

  async login(username: string, password: string) {
    const [row] = await this.db.query(
      `SELECT u.id,u.username,u.name,u.employee_name "employeeName",u.employee_no "employeeNo",
        u.department,u.position,u.password_hash,u.status,r.id role_id,r.code role,
        COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL),'{}') permissions
       FROM users u JOIN roles r ON r.id=u.role_id
       LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
       WHERE u.username=$1 AND u.deleted_at IS NULL GROUP BY u.id,r.id`,
      [username],
    );
    if (!row || row.status !== 'ACTIVE' || !(await bcrypt.compare(password, row.password_hash))) {
      throw new UnauthorizedException('账号或密码错误');
    }
    const user: AuthUser = {
      id: row.id, username: row.username, name: row.name,
      employeeName: row.employeeName, employeeNo: row.employeeNo,
      department: row.department, position: row.position,
      role: row.role, roleId: row.role_id, permissions: row.permissions,
    };

    // Update last_login_at
    await this.db.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [row.id]);

    return { accessToken: await this.jwt.signAsync(user as any), user };
  }
}
