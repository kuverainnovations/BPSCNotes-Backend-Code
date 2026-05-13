import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { join } from 'path';
import { redisStore } from 'cache-manager-ioredis-yet';

import { allConfigs } from './config';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor, LoggingInterceptor } from './common/interceptors';
import { JwtAuthGuard } from './common/guards';

import { AuthModule }        from './modules/auth/auth.module';
import { CoursesModule }     from './modules/courses/courses.module';
import { AdminModule }       from './modules/admin/admin.module';
import { QuizzesModule }     from './modules/quizzes/quizzes.module';
import { LibraryModule }     from './modules/library/library.module';
import { HealthController }  from './health.controller';

import {
  CurrentAffairsModule, JobsModule, SubscriptionsModule,
  NotificationsModule, CoinsModule,
} from './modules/combined-modules-1.module';

import {
  StudyRoomsModule, UsersModule, BannersModule, ExamsModule, DailyTargetsModule,
  FlashcardsModule,
} from './modules/combined-modules-2.module';
import { TierRoomsModule } from './modules/tier-rooms/tier-rooms.module';

@Module({
  imports: [
    // ── Config ────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal:    true,
      load:        allConfigs,
      envFilePath: ['.env.local', '.env'],
      cache:       true,
    }),

    // ── Database ──────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = config.get('app.isProd');
        return {
          type:     'postgres',
          host:     config.get('database.host'),
          port:     config.get('database.port'),
          database: config.get('database.name'),
          username: config.get('database.user'),
          password: config.get('database.password'),
          ssl:      config.get('database.ssl') ? { rejectUnauthorized: false } : false,

          autoLoadEntities: true,
          migrations: [join(__dirname, 'database/migrations/*{.ts,.js}')],

          // BUG FIX 6: synchronize:true in production is DANGEROUS.
          // It runs ALTER TABLE on every restart, can cause data loss and
          // startup race conditions. Use explicit migrations instead.
          synchronize: !isProd,   // true in dev, false in production
          migrationsRun: false,  // auto-run migrations on start in production

          logging:  config.get('database.logging'),
          extra: {
            min: config.get('database.poolMin'),
            max: config.get('database.poolMax'),
            idleTimeoutMillis:    30000,
            connectionTimeoutMillis: 5000,
          },
        };
      },
    }),

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => ({
        store: await redisStore({
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          db: config.get<number>('REDIS_DB', 0),
          ttl: config.get<number>('REDIS_TTL', 300),
        }),
      }),
    }),

    
    // ── Rate Limiting ─────────────────────────────────────────
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{
          ttl:   config.get<number>('throttle.ttl', 60) * 1000,
          limit: config.get<number>('throttle.limit', 100),
        }],
      }),
    }),

    // ── Feature Modules ───────────────────────────────────────
    AuthModule,
    AdminModule,
    CoursesModule,
    QuizzesModule,
    LibraryModule,
    CurrentAffairsModule,
    JobsModule,
    SubscriptionsModule,
    NotificationsModule,
    CoinsModule,
    StudyRoomsModule,
    UsersModule,
    BannersModule,
    ExamsModule,
    DailyTargetsModule,
    FlashcardsModule,
    TierRoomsModule,
  ],

  controllers: [HealthController],

  providers: [
    { provide: APP_GUARD,       useClass: ThrottlerGuard },
    { provide: APP_GUARD,       useClass: JwtAuthGuard },
    { provide: APP_FILTER,      useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
