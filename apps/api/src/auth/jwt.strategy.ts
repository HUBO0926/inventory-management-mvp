import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly db: DataSource) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET || 'local-development-secret',
    });
  }
  async validate(payload: AuthUser) {
    const [user] = await this.db.query(`SELECT u.id,u.username,u.name,r.id "roleId",r.code role,
      u.employee_name "employeeName",u.employee_no "employeeNo",u.department,u.position,
      COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL),'{}') permissions
      FROM users u JOIN roles r ON r.id=u.role_id AND r.status='ACTIVE'
      LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
      WHERE u.id=$1 AND u.status='ACTIVE' AND u.deleted_at IS NULL GROUP BY u.id,r.id`, [payload.id]);
    return user || null;
  }
}
