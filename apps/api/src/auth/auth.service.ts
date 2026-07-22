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
      `SELECT id, username, name, password_hash, role, status FROM users WHERE username = $1`,
      [username],
    );
    if (!row || row.status !== 'ACTIVE' || !(await bcrypt.compare(password, row.password_hash))) {
      throw new UnauthorizedException('账号或密码错误');
    }
    const user: AuthUser = { id: row.id, username: row.username, name: row.name, role: row.role };
    return { accessToken: await this.jwt.signAsync(user), user };
  }
}
