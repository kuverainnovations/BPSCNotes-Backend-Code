import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import * as compression from 'compression';
import * as morgan from 'morgan';
import { AppModule } from './app.module';

// ════════════════════════════════════════════════════════════
// main.ts — Production
//
// BUG 5 FIX: REMOVED DOUBLE CORS MIDDLEWARE
//
// The previous main.ts had BOTH of these, in this order:
//
//   1. app.enableCors({ origin: ['https://admin.bpscnotes.in', ...] })
//   2. app.use((req, res, next) => {
//        res.header('Access-Control-Allow-Origin', 'https://admin.bpscnotes.in')
//        ...
//      })
//
// Why this breaks CORS intermittently:
//
//   app.enableCors() works correctly for the first pass — it reads the
//   incoming `Origin` header and echoes it back if it's in the allowed list.
//   Example: request from admin.bpscnotes.in gets:
//     Access-Control-Allow-Origin: https://admin.bpscnotes.in  ← correct
//
//   Then app.use() runs AFTER enableCors and OVERWRITES the header:
//     Access-Control-Allow-Origin: https://admin.bpscnotes.in  ← same value, OK for admin
//
//   But for preflight OPTIONS requests from the browser:
//     enableCors() handles OPTIONS and calls next() with preflightContinue:false
//     THEN app.use() intercepts it AGAIN and sends sendStatus(204) a second time
//     → double response → nginx sees malformed response → 502/503 intermittently
//
//   For any origin that isn't exactly 'https://admin.bpscnotes.in':
//     enableCors() correctly echoes the allowed origin
//     app.use() overwrites it with 'https://admin.bpscnotes.in' (hardcoded)
//     → CORS header is wrong → browser blocks the request
//
// FIX: Use ONLY app.enableCors() with function-form origin validator.
//      Delete the manual app.use() CORS block entirely.
//      Nginx adds ZERO CORS headers (see proxy_params.conf).
// ════════════════════════════════════════════════════════════

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  const config = app.get(ConfigService);

  // ── Serve uploaded files statically ──────────────────────
  // This makes https://api.bpscnotes.in/uploads/<file> work
  // without needing nginx /uploads/ location block.
  const uploadDir = config.get<string>('UPLOAD_DIR') ?? join(process.cwd(), 'uploads');
  app.useStaticAssets(uploadDir, { prefix: '/uploads' });

  const port   = config.get<number>('app.port', 5000);
  const prefix = config.get<string>('app.apiPrefix', 'api/v1');
  const env    = config.get<string>('app.env', 'development');
  const appUrl = config.get<string>('app.url', 'http://localhost:5000');

  // ── Security ───────────────────────────────────────────────
  app.use(
    helmet.default({
      contentSecurityPolicy:     false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  // ── CORS — single source of truth, function-form origin ───
  // FIX BUG 5: Only this block. No manual app.use() after this.
  app.enableCors({
    origin: (requestOrigin: string | undefined, callback) => {
      const allowed = [
        'https://admin.bpscnotes.in',
        'https://api.bpscnotes.in',
        'http://localhost:3000',
        'http://localhost:3001',
      ];
      // No origin = mobile app, Postman, curl → allow
      if (!requestOrigin || allowed.includes(requestOrigin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked: ${requestOrigin}`));
      }
    },
    methods:              ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders:       ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    credentials:          true,
    preflightContinue:    false,   // NestJS handles OPTIONS, returns 204
    optionsSuccessStatus: 204,
  });

  // ── NO manual app.use() CORS middleware ────────────────────
  // That was the bug. Deleted.

  // ── Compression ────────────────────────────────────────────
  app.use(compression());

  // ── HTTP Logging ───────────────────────────────────────────
  if (env !== 'test') {
    app.use(morgan(env === 'production' ? 'combined' : 'dev'));
  }

  // ── Global prefix ──────────────────────────────────────────
  app.setGlobalPrefix(prefix);

  // ── Validation ─────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:            true,
      forbidNonWhitelisted: false,
      transform:            true,
      transformOptions:     { enableImplicitConversion: true },
      errorHttpStatusCode:  422,
    }),
  );

  // ── Swagger (non-production only) ──────────────────────────
  if (env !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('BPSCNotes API')
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addServer(appUrl, 'Current Server')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`📚 Swagger: ${appUrl}/docs`);
  }

  // ── Health endpoints (registered BEFORE global prefix) ─────
  const adapter = app.getHttpAdapter();
  adapter.get('/health', (_req: any, res: any) => {
    res.json({
      status: 'ok', env,
      version:   process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    });
  });
  adapter.get('/health/ready', (_req: any, res: any) => {
    res.json({ status: 'ready' });
  });

  // ── Start ──────────────────────────────────────────────────
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 ${appUrl}/${prefix}/ [${env}]`);
}

bootstrap().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});