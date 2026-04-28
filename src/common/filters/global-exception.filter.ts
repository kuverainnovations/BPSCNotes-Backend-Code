// ─────────────────────────────────────────────────────────────
// Global Exception Filter
// ─────────────────────────────────────────────────────────────
import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx      = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request  = ctx.getRequest<Request>();

    let status  = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = null;

    if (exception instanceof HttpException) {
      status  = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : (res as any).message || message;
      errors  = typeof res === 'object' ? (res as any).errors : null;

    } else if (exception instanceof QueryFailedError) {
      const pgError = exception as any;
      if (pgError.code === '23505') {
        status  = HttpStatus.CONFLICT;
        message = 'Record already exists';
      } else if (pgError.code === '23503') {
        status  = HttpStatus.BAD_REQUEST;
        message = 'Referenced record not found';
      } else {
        this.logger.error(`Database error: ${pgError.message}`, pgError.stack);
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
    }

    this.logger.error(
      `${request.method} ${request.url} → ${status}`,
      process.env.NODE_ENV !== 'production' ? (exception as any)?.stack : undefined,
    );

    response.status(status).json({
      success:   false,
      message:   Array.isArray(message) ? message[0] : message,
      ...(errors && { errors }),
      ...(process.env.NODE_ENV !== 'production' && status >= 500 && {
        debug: (exception as any)?.message,
      }),
      timestamp: new Date().toISOString(),
      path:      request.url,
    });
  }
}
