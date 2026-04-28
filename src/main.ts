import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import * as compression from 'compression';
import * as morgan from 'morgan';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
    bufferLogs: true,
  });

  const config = app.get(ConfigService);

  // 🔥 ADD THIS
console.log('🚨 DB CONFIG CHECK:', {
  host: config.get('database.host'),
  port: config.get('database.port'),
  db: config.get('database.name'),
  user: config.get('database.user'),
  env: config.get('app.env'),
});

  const port      = config.get<number>('app.port', 5000);
  const prefix    = config.get<string>('app.apiPrefix', 'api/v1');
  const env       = config.get<string>('app.env', 'development');
  const appUrl    = config.get<string>('app.url', 'http://localhost:5000');

  // ── Security ──────────────────────────────────────────────
  app.use(helmet.default({
    contentSecurityPolicy: env === 'production',
    crossOriginEmbedderPolicy: false,
  }));

  // ── CORS ──────────────────────────────────────────────────
  app.enableCors({
    origin:         [
      config.get('app.frontendUrl'),
      'http://localhost:3000',
      'http://localhost:5173',
      /\.bpscnotes\.com$/,
    ],
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials:    true,
    maxAge:         86400,
  });

  // ── Compression ───────────────────────────────────────────
  app.use(compression());

  // ── HTTP Logging ──────────────────────────────────────────
  if (env !== 'test') {
    app.use(morgan(env === 'development' ? 'dev' : 'combined'));
  }

  // ── Global prefix ─────────────────────────────────────────
  app.setGlobalPrefix(prefix);

  // ── Global Validation ─────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:            true,
      forbidNonWhitelisted: false,
      transform:            true,
      transformOptions:     { enableImplicitConversion: true },
      errorHttpStatusCode:  422,
    }),
  );

  // ── Swagger API Docs ──────────────────────────────────────
  if (env !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('BPSCNotes API')
      .setDescription(`
## BPSCNotes Backend API

**Mobile App APIs** — Authentication, Courses, Quizzes, Library, Current Affairs, Jobs, Subscriptions

**Admin Panel APIs** — All CRUD operations. Changes reflect **instantly** in the mobile app via shared PostgreSQL database.

### Authentication
- **Mobile users**: \`Authorization: Bearer <accessToken>\`
- **Admin panel**: \`Authorization: Bearer <adminToken>\`

### How Admin → Mobile Sync Works
The admin panel and mobile app share the same PostgreSQL database. When an admin creates/updates/publishes any content, it's immediately available in the mobile app on the next API call. No cache invalidation needed for content updates (Redis cache has short TTL).
      `)
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addServer(appUrl, 'Current Server')
      .addTag('Auth', 'Mobile authentication — OTP, register, login, refresh, logout')
      .addTag('Courses', 'Course listing, enrollment, progress tracking')
      .addTag('Quizzes', 'Daily quizzes, topic tests, mock tests')
      .addTag('Library', 'E-Library — PDF notes, PYQs, books, video notes')
      .addTag('Current Affairs', 'Daily current affairs content')
      .addTag('Jobs', 'Government job vacancies')
      .addTag('Subscriptions', 'Plans, payments, coupon codes')
      .addTag('Notifications', 'User notification inbox')
      .addTag('Coins', 'Coin balance and transaction history')
      .addTag('Study Rooms', 'Group study room management')
      .addTag('Users', 'User profile, stats, leaderboard')
      .addTag('Admin — Auth', 'Admin login')
      .addTag('Admin — Dashboard', 'Stats, analytics, charts')
      .addTag('Admin — Users', 'User management — ban, verify, award coins')
      .addTag('Admin — Courses', 'Course CRUD — reflects in mobile instantly')
      .addTag('Admin — Settings', 'App settings — maintenance mode, coin value, etc.')
      .addTag('App Config', 'Public app configuration for mobile')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
      },
      customSiteTitle: 'BPSCNotes API Docs',
      customCss: `.swagger-ui .topbar { background: #1565C0 }`,
    });

    logger.log(`📚 Swagger: ${appUrl}/docs`);
  }

  // ── Health endpoint (before global prefix) ────────────────
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', async (req: any, res: any) => {
    res.json({
      status:    'ok',
      env,
      version:   process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    });
  });

  httpAdapter.get('/health/ready', async (req: any, res: any) => {
    // Could add DB ping here
    res.json({ status: 'ready' });
  });

  // ── Start ─────────────────────────────────────────────────
  await app.listen(port, '0.0.0.0');

  logger.log(`
  ╔══════════════════════════════════════════════════╗
  ║        BPSCNotes Backend — Running               ║
  ║   ${appUrl}${' '.repeat(Math.max(0, 38 - appUrl.length))}║
  ║   ENV: ${env}${' '.repeat(Math.max(0, 43 - env.length))}║
  ╚══════════════════════════════════════════════════╝

  🌐 API:    ${appUrl}/${prefix}/
  📚 Docs:   ${appUrl}/docs
  ❤️  Health: ${appUrl}/health
  `);
}

bootstrap().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
