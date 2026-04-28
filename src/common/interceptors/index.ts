import {
  Injectable, NestInterceptor, ExecutionContext,
  CallHandler, Logger,
} from '@nestjs/common';
import { Observable, tap, map } from 'rxjs';

// ── Transform Interceptor — wraps all responses ───────────────
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map(data => {
        // If the response is already our ApiResponse format, return as-is
        if (data && typeof data === 'object' && 'success' in data) return data;
        return {
          success:   true,
          message:   'Success',
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}

// ── Logging Interceptor ───────────────────────────────────────
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req   = ctx.switchToHttp().getRequest();
    const start = Date.now();
    const { method, url, ip } = req;
    const userId = req.user?.id || req.admin?.id || 'anonymous';

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          this.logger.log(`${method} ${url} [${userId}] ${ms}ms`);
        },
        error: (err) => {
          const ms = Date.now() - start;
          this.logger.error(`${method} ${url} [${userId}] ${ms}ms — ${err.message}`);
        },
      }),
    );
  }
}
