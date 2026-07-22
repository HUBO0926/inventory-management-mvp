import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
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
      map((data) => ({ code: 'OK', message: 'success', data, requestId: request.requestId })),
    );
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
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
    }

    response.status(status).json({ code, message, data: details ?? null, requestId });
  }
}
