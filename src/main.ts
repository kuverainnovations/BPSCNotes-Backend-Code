import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import * as compression from 'compression';
import * as morgan from 'morgan';
import * as cookieParser from 'cookie-parser';
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

// ════════════════════════════════════════════════════════════
// JWT secret validation — HARD FAIL in production
//
// The tokens are HS256. A weak/guessable/shared secret lets anyone forge
// user tokens ({userId}) AND admin tokens ({adminId}) → total takeover.
// In production we REFUSE TO BOOT rather than run with an insecure secret.
// In non-production we only warn so local development isn't blocked.
//
// Generate strong secrets (one per type) with:
//   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
// ════════════════════════════════════════════════════════════
function validateJwtSecrets() {
  const isProd = process.env.NODE_ENV === 'production';
  const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ADMIN_JWT_SECRET'];
  const knownWeak = new Set([
    'secret', 'secret123', 'changeme', 'change_this', 'password', 'test',
    'CHANGE_THIS_TO_64_CHAR_RANDOM_STRING_IN_PRODUCTION',
    'CHANGE_THIS_TO_ANOTHER_64_CHAR_RANDOM_STRING',
    'CHANGE_THIS_TO_YET_ANOTHER_64_CHAR_RANDOM_STRING',
  ]);

  const problems: string[] = [];
  for (const name of required) {
    const v = process.env[name];
    if (!v)                    { problems.push(`${name} is not set`); continue; }
    if (v.length < 32)          problems.push(`${name} is too short (${v.length} chars — need at least 32)`);
    if (knownWeak.has(v))       problems.push(`${name} is a known-weak / placeholder value`);
  }
  // Distinctness: reusing one value across user/refresh/admin means a single
  // leak compromises all three token types at once.
  const values = required.map(n => process.env[n]).filter(Boolean) as string[];
  if (values.length === required.length && new Set(values).size !== values.length) {
    problems.push('JWT secrets must be DISTINCT from each other (the same value is reused across user/refresh/admin)');
  }

  if (problems.length === 0) return;

  const report = `Insecure JWT configuration:\n  - ${problems.join('\n  - ')}`;
  if (isProd) {
    console.error(
      `\n❌ REFUSING TO START — ${report}\n\n` +
      `Set strong, distinct secrets in the server environment. Generate each with:\n` +
      `  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"\n`,
    );
    process.exit(1);
  }
  console.warn(`\n⚠️  ${report}\n(Permitted in non-production only — DO NOT ship this to production.)\n`);
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // ── Validate JWT secrets — hard-fails in production on weak/shared values ──
  validateJwtSecrets();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  // ── Cookie parser — required for httpOnly admin JWT cookie ──
  app.use(cookieParser());

  // ── Increase body size limit for video/file uploads (200MB) ─
  // Default NestJS/Express limit is 100KB — way too small for videos
  app.use(require('express').json({ limit: '10mb' }));
  app.use(require('express').urlencoded({ limit: '200mb', extended: true }));

  // ── Increase request timeout for large file uploads ─────────
  // Default Node.js HTTP timeout is 5s — videos need much longer
  const server = app.getHttpServer();
  server.setTimeout(10 * 60 * 1000); // 10 minutes

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
        'https://admin-stg.bpscnotes.in',
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
    allowedHeaders:       ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Cookie'],
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