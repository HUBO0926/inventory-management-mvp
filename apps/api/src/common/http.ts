import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    request.requestId = request.headers['x-request-id'] || randomUUID();
    return next.handle().pipe(
      map((data) => ({ success:true,code: 'OK', message: 'success', data,details:null, requestId: request.requestId })),
    );
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const requestId = request.requestId || request.headers['x-request-id'] || randomUUID();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = '服务器内部错误';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (typeof body === 'string') message = body;
      else {
        code = body.code || (status === 403 ? 'FORBIDDEN' : status === 401 ? 'UNAUTHORIZED' : 'VALIDATION_ERROR');
        message = Array.isArray(body.message) ? body.message.join('; ') : body.message || exception.message;
        details = body.details;
      }
    } else {
      // 非 HttpException（多为数据库/运行时异常）：把原始原因带出来，否则前端只能看到"服务器内部错误"，排查必须翻终端
      if (exception instanceof Error && exception.message) message = exception.message;
      this.logger.error(`[${requestId}] ${request.method} ${request.originalUrl} -> ${message}`, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(status).json({ success:false,code, message, data:null,details:details??null, requestId });
  }
}
