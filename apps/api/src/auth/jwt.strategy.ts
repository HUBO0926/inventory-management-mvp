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
    const [user] = await this.db.query(`SELECT id, username, name, role FROM users WHERE id=$1 AND status='ACTIVE'`, [payload.id]);
    return user || null;
  }
}
