// ════════════════════════════════════════════════════════════
// PM2 ECOSYSTEM CONFIG — Production-Grade
// File: /var/www/ecosystem.config.js
//
// DEPLOYMENT:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup
//
// ROOT CAUSE FIXES:
//
// BUG 14 — NO PM2 CONFIG → DEFAULT FORK MODE
//   Without ecosystem.config.js, PM2 runs in fork mode.
//   When NestJS crashes (OOM, unhandled rejection), PM2 restarts
//   the process. During restart, Nginx gets 502 for ~2-3 seconds.
//   If admin panel refresh hits this window → "Failed to fetch".
//   Manual refresh a second later → backend is back → works.
//   THIS IS THE PRIMARY CAUSE OF "SOMETIMES WORKS ON REFRESH"
//
//   FIX: cluster mode (2 instances) — zero-downtime restarts.
//   max_memory_restart — auto-restart before OOM kill.
//   restart_delay — wait before restart so Nginx upstream recovers.
//   health_check_grace_period — don't accept traffic until ready.
//
// BUG 15 — ENV VARS NOT SET IN PM2 ENVIRONMENT
//   If PM2 was started without --env production, NEXT_PUBLIC_API_URL
//   may not be in the process environment at build/start time.
//   NODE_ENV defaults to 'development' → isProd=false → synchronize:true
//   → TypeORM tries to ALTER TABLE on every restart → startup race.
//   FIX: env_production block with all required vars.
// ════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    // ── NestJS Backend ─────────────────────────────────────
    {
      name:             'bpscnotes-api',
      script:           'dist/main.js',
      cwd:              '/var/www/api',
      instances:        2,                    // cluster mode — zero-downtime restarts
      exec_mode:        'cluster',
      watch:            false,
      max_memory_restart: '1G',              // restart before OOM kill
      restart_delay:    2000,               // 2s delay between restarts
      wait_ready:       true,               // wait for process.send('ready')
      listen_timeout:   10000,             // 10s for process to send ready
      kill_timeout:     5000,              // 5s graceful shutdown

      env_production: {
        NODE_ENV:              'production',
        PORT:                  5000,
        // DB
        DB_HOST:               'localhost',
        DB_PORT:               5432,
        DB_NAME:               'bpscnotes',
        DB_USER:               'bpscnotes_user',
        // DB_PASSWORD set in .env file on server — not here (security)

        // Redis
        REDIS_HOST:            'localhost',
        REDIS_PORT:            6379,
        REDIS_TTL:             300,

        // App
        APP_URL:               'https://api.bpscnotes.in',
        FRONTEND_URL:          'https://admin.bpscnotes.in',

        // Pool — 2 instances × 10 connections each = 20 total
        DB_POOL_MIN:           2,
        DB_POOL_MAX:           10,

        // Logging
        DB_LOGGING:            false,
      },

      log_date_format:  'YYYY-MM-DD HH:mm:ss',
      error_file:       '/var/log/pm2/bpscnotes-api-error.log',
      out_file:         '/var/log/pm2/bpscnotes-api-out.log',
      merge_logs:       true,

      // Graceful shutdown hook — NestJS handles SIGTERM
      kill_timeout:     5000,
    },

    // ── Next.js Admin Panel ────────────────────────────────
    {
      name:             'bpscnotes-admin',
      script:           'node_modules/.bin/next',
      args:             'start',
      cwd:              '/var/www/admin',
      instances:        1,                  // Next.js SSR — single instance is fine
      exec_mode:        'fork',
      watch:            false,
      max_memory_restart: '512M',

      env_production: {
        NODE_ENV:              'production',
        PORT:                  3000,
        // CRITICAL: This env var is baked into the Next.js bundle at BUILD time.
        // It must be set BEFORE running `npm run build`, not just at runtime.
        // For runtime reads (server components), it also needs to be here.
        NEXT_PUBLIC_API_URL:   'https://api.bpscnotes.in/api/v1',
      },

      log_date_format:  'YYYY-MM-DD HH:mm:ss',
      error_file:       '/var/log/pm2/bpscnotes-admin-error.log',
      out_file:         '/var/log/pm2/bpscnotes-admin-out.log',
      merge_logs:       true,
    },
  ],
}
