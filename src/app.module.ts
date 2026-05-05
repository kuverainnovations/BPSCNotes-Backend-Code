import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { join } from 'path';
// import * as redisStore from 'cache-manager-redis-store';
import { redisStore } from 'cache-manager-ioredis-yet';

import { allConfigs } from './config';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor, LoggingInterceptor } from './common/interceptors';
import { JwtAuthGuard } from './common/guards';

import { AuthModule } from './modules/auth/auth.module';
import { CoursesModule } from './modules/courses/courses.module';
import { AdminModule } from './modules/admin/admin.module';

// Inline small modules to keep file count manageable
import { QuizzesModule } from './modules/quizzes/quizzes.module';
import { LibraryModule } from './modules/library/library.module';
import { CurrentAffairsModule, JobsModule, SubscriptionsModule, NotificationsModule, CoinsModule } from './modules/combined-modules-1.module';
import { StudyRoomsModule, UsersModule, BannersModule, ExamsModule } from './modules/combined-modules-2.module';

import { DailyTargetsModule } from './modules/combined-modules-2.module';








@Module({
  imports: [
    // ── Config ────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: allConfigs,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),

    // ── Database ──────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('database.host'),
        port: config.get('database.port'),
        database: config.get('database.name'),
        username: config.get('database.user'),
        password: config.get('database.password'),
        ssl: config.get('database.ssl') ? { rejectUnauthorized: false } : false,
        autoLoadEntities: true,
        migrations: [join(__dirname, 'database/migrations/*{.ts,.js}')],
        synchronize: true,
        logging: config.get('database.logging'),
        extra: {
          min: config.get('database.poolMin'),
          max: config.get('database.poolMax'),
          idleTimeoutMillis: 30000,
        },
      }),
    }),

    // ── Redis Cache ───────────────────────────────────────────
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        return {
          store: await redisStore({
            host: config.get('redis.host') || 'redis',
            port: config.get('redis.port') || 6379,
            password: config.get('redis.password') || undefined,
            db: config.get('redis.db') || 0,
            ttl: config.get('redis.ttl') || 300,
          }),
        };
      },
    }),

    // ── Rate Limiting ─────────────────────────────────────────
    // ThrottlerModule.forRootAsync({
    //   inject:     [ConfigService],
    //   useFactory: (config: ConfigService) => ({
    //     throttlers: [{
    //       ttl:   config.get('throttle.ttl') * 1000,
    //       limit: config.get('throttle.limit'),
    //     }],
    //   }),
    // }),

    //DEV PURPOSE
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isDev = config.get('app.env') === 'development';

        return {
          throttlers: [{
            ttl: 60 * 1000,
            limit: isDev ? 1000 : config.get('throttle.limit'), // 🔥 FIX
          }],
        };
      },
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
    DailyTargetsModule
  ],

  providers: [
    // Global guards
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },

    // Global filters
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },

    // Global interceptors
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule { }
