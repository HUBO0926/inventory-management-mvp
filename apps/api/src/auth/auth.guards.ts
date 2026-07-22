import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { AuthUser, Role } from '../common/constants';
import { BusinessException } from '../common/business.exception';
import { HttpStatus } from '@nestjs/common';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }
  canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    return super.canActivate(context);
  }
}

@Injectable()
export class RolesGuard {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest().user as AuthUser;
    if (user && roles.includes(user.role)) return true;
    throw new BusinessException('FORBIDDEN', '无权执行此操作', HttpStatus.FORBIDDEN);
  }
}
