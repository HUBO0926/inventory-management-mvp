import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Observable, tap } from 'rxjs';

@Injectable()
export class AuditRequestInterceptor implements NestInterceptor {
  constructor(private readonly db: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const startedAt = Date.now();
    const write = (result: 'SUCCESS' | 'FAILED', error?: any) => {
      const forwarded = request.headers['x-forwarded-for'];
      const ip = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || request.ip || '').split(',')[0].trim().slice(0, 64);
      const path = String(request.originalUrl || request.url || '').split('?')[0].slice(0, 120);
      const errorBody = error?.getResponse?.() || {};
      void this.db.query(
        `INSERT INTO operation_logs(user_id,action,entity_type,details,request_id,ip,result,error_code,app_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          request.user?.id || null,
          `${request.method} ${path}`.slice(0, 100),
          'http_request',
          JSON.stringify({ durationMs: Date.now() - startedAt }),
          request.requestId || request.headers['x-request-id'] || null,
          ip || null,
          result,
          result === 'FAILED' ? (errorBody.code || `HTTP_${error?.getStatus?.() || 500}`) : null,
          process.env.APP_VERSION || '1.8.0',
        ],
      ).catch(() => undefined);
    };
    return next.handle().pipe(tap({ next: () => write('SUCCESS'), error: error => write('FAILED', error) }));
  }
}
