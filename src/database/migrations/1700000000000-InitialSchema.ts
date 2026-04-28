import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extensions
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ── Enums ──────────────────────────────────────────────────
    await queryRunner.query(`CREATE TYPE user_status    AS ENUM ('active','banned','pending','deleted')`);
    await queryRunner.query(`CREATE TYPE user_role      AS ENUM ('student','instructor','admin')`);
    await queryRunner.query(`CREATE TYPE prep_level     AS ENUM ('beginner','intermediate','advanced')`);
    await queryRunner.query(`CREATE TYPE sub_plan       AS ENUM ('monthly','quarterly','annual')`);
    await queryRunner.query(`CREATE TYPE sub_status     AS ENUM ('active','expired','cancelled','pending')`);
    await queryRunner.query(`CREATE TYPE content_status AS ENUM ('draft','review','published','rejected')`);
    await queryRunner.query(`CREATE TYPE note_type      AS ENUM ('pdf','pyq','book','video')`);
    await queryRunner.query(`CREATE TYPE quiz_type      AS ENUM ('daily','topic','mock')`);
    await queryRunner.query(`CREATE TYPE difficulty     AS ENUM ('easy','medium','hard')`);
    await queryRunner.query(`CREATE TYPE txn_type       AS ENUM ('earned','spent')`);
    await queryRunner.query(`CREATE TYPE notif_target   AS ENUM ('all','free','pro','exam','custom','user')`);
    await queryRunner.query(`CREATE TYPE notif_status   AS ENUM ('draft','scheduled','sent','failed')`);
    await queryRunner.query(`CREATE TYPE job_status     AS ENUM ('active','expired','upcoming')`);
    await queryRunner.query(`CREATE TYPE room_status    AS ENUM ('active','ended','archived')`);
    await queryRunner.query(`CREATE TYPE pay_status     AS ENUM ('pending','success','failed','refunded')`);

    // ── Admin Users ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE admin_users (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name           VARCHAR(100) NOT NULL,
        email          VARCHAR(200) UNIQUE NOT NULL,
        password_hash  VARCHAR(255) NOT NULL,
        permissions    TEXT[] DEFAULT '{}',
        status         VARCHAR(20) DEFAULT 'active',
        last_login_at  TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Users ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE users (
        id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name                   VARCHAR(100) NOT NULL,
        email                  VARCHAR(200) UNIQUE,
        mobile                 VARCHAR(15) UNIQUE NOT NULL,
        mobile_verified        BOOLEAN NOT NULL DEFAULT FALSE,
        email_verified         BOOLEAN NOT NULL DEFAULT FALSE,
        avatar_url             TEXT,
        bio                    TEXT,
        district               VARCHAR(100),
        state                  VARCHAR(100) DEFAULT 'Bihar',
        role                   user_role NOT NULL DEFAULT 'student',
        status                 user_status NOT NULL DEFAULT 'active',
        primary_exam           VARCHAR(100),
        secondary_exam         VARCHAR(100),
        prep_level             prep_level DEFAULT 'beginner',
        target_year            SMALLINT,
        streak                 INTEGER NOT NULL DEFAULT 0,
        longest_streak         INTEGER NOT NULL DEFAULT 0,
        last_study_date        DATE,
        coins                  INTEGER NOT NULL DEFAULT 0,
        total_coins_earned     INTEGER NOT NULL DEFAULT 0,
        rank                   INTEGER,
        total_study_minutes    INTEGER NOT NULL DEFAULT 0,
        accuracy               DECIMAL(5,2) NOT NULL DEFAULT 0,
        quizzes_attempted      INTEGER NOT NULL DEFAULT 0,
        fcm_token              TEXT,
        refresh_token          TEXT,
        referral_code          VARCHAR(20) UNIQUE,
        referred_by            UUID REFERENCES users(id) ON DELETE SET NULL,
        is_verified            BOOLEAN NOT NULL DEFAULT FALSE,
        notification_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at             TIMESTAMPTZ
      )
    `);

    // ── OTP ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE otps (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        mobile      VARCHAR(15) NOT NULL,
        otp_hash    VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        is_used     BOOLEAN NOT NULL DEFAULT FALSE,
        attempts    INTEGER NOT NULL DEFAULT 0,
        ip_address  INET,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Exams ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE exams (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name        VARCHAR(100) UNIQUE NOT NULL,
        full_name   VARCHAR(255) NOT NULL,
        category    VARCHAR(50) NOT NULL,
        emoji       VARCHAR(10),
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Courses ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE courses (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title             VARCHAR(255) NOT NULL,
        slug              VARCHAR(300) UNIQUE,
        description       TEXT,
        instructor        VARCHAR(100),
        instructor_bio    TEXT,
        subject           VARCHAR(100),
        price             INTEGER NOT NULL DEFAULT 0,
        original_price    INTEGER NOT NULL DEFAULT 0,
        is_paid           BOOLEAN NOT NULL DEFAULT FALSE,
        is_featured       BOOLEAN NOT NULL DEFAULT FALSE,
        is_limited_offer  BOOLEAN NOT NULL DEFAULT FALSE,
        offer_ends_at     TIMESTAMPTZ,
        thumbnail_url     TEXT,
        total_lessons     INTEGER NOT NULL DEFAULT 0,
        total_hours       DECIMAL(5,1) NOT NULL DEFAULT 0,
        rating            DECIMAL(3,2) NOT NULL DEFAULT 0,
        review_count      INTEGER NOT NULL DEFAULT 0,
        enrollment_count  INTEGER NOT NULL DEFAULT 0,
        bpsc_relevance    INTEGER NOT NULL DEFAULT 0,
        syllabus_coverage INTEGER NOT NULL DEFAULT 0,
        language          VARCHAR(50) DEFAULT 'Hindi + English',
        trial_lesson_title VARCHAR(255),
        exam_tags         TEXT[] DEFAULT '{}',
        status            content_status NOT NULL DEFAULT 'draft',
        meta_keywords     TEXT[],
        created_by        UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE course_chapters (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title       VARCHAR(255) NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE course_lessons (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        chapter_id      UUID NOT NULL REFERENCES course_chapters(id) ON DELETE CASCADE,
        course_id       UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title           VARCHAR(255) NOT NULL,
        duration_mins   INTEGER NOT NULL DEFAULT 0,
        type            VARCHAR(20) NOT NULL DEFAULT 'video',
        video_url       TEXT,
        notes_url       TEXT,
        is_free_preview BOOLEAN NOT NULL DEFAULT FALSE,
        is_locked       BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE course_reviews (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating      DECIMAL(2,1) NOT NULL,
        comment     TEXT,
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(course_id, user_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE user_enrollments (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id         UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        completed_lessons INTEGER NOT NULL DEFAULT 0,
        last_lesson_id    UUID REFERENCES course_lessons(id) ON DELETE SET NULL,
        status            VARCHAR(20) NOT NULL DEFAULT 'active',
        enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at      TIMESTAMPTZ,
        UNIQUE(user_id, course_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE lesson_progress (
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lesson_id        UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
        is_completed     BOOLEAN NOT NULL DEFAULT FALSE,
        watch_time_secs  INTEGER NOT NULL DEFAULT 0,
        completed_at     TIMESTAMPTZ,
        PRIMARY KEY (user_id, lesson_id)
      )
    `);

    // ── Library ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE library_notes (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(255) NOT NULL,
        description     TEXT,
        subject         VARCHAR(100),
        type            note_type NOT NULL,
        author          VARCHAR(100),
        uploaded_by_id  UUID REFERENCES users(id) ON DELETE SET NULL,
        file_url        TEXT,
        thumbnail_url   TEXT,
        pages           INTEGER NOT NULL DEFAULT 0,
        file_size_mb    DECIMAL(6,2) NOT NULL DEFAULT 0,
        is_premium      BOOLEAN NOT NULL DEFAULT FALSE,
        is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
        is_trending     BOOLEAN NOT NULL DEFAULT FALSE,
        download_count  INTEGER NOT NULL DEFAULT 0,
        rating          DECIMAL(3,2) NOT NULL DEFAULT 0,
        status          content_status NOT NULL DEFAULT 'draft',
        tags            TEXT[] DEFAULT '{}',
        exam_tags       TEXT[] DEFAULT '{}',
        created_by      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE note_bookmarks (
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note_id    UUID NOT NULL REFERENCES library_notes(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, note_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE note_downloads (
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note_id       UUID NOT NULL REFERENCES library_notes(id) ON DELETE CASCADE,
        downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, note_id)
      )
    `);

    // ── Quizzes ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE quizzes (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(255) NOT NULL,
        description     TEXT,
        subject         VARCHAR(100),
        type            quiz_type NOT NULL DEFAULT 'topic',
        difficulty      difficulty NOT NULL DEFAULT 'medium',
        total_questions INTEGER NOT NULL DEFAULT 10,
        duration_mins   INTEGER NOT NULL DEFAULT 15,
        passing_score   INTEGER NOT NULL DEFAULT 60,
        coins_reward    INTEGER NOT NULL DEFAULT 10,
        exam_tags       TEXT[] DEFAULT '{}',
        attempt_count   INTEGER NOT NULL DEFAULT 0,
        avg_score       DECIMAL(5,2) NOT NULL DEFAULT 0,
        status          content_status NOT NULL DEFAULT 'draft',
        scheduled_for   DATE,
        created_by      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE quiz_questions (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        quiz_id         UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_text   TEXT NOT NULL,
        option_a        TEXT NOT NULL,
        option_b        TEXT NOT NULL,
        option_c        TEXT NOT NULL,
        option_d        TEXT NOT NULL,
        correct_option  CHAR(1) NOT NULL CHECK (correct_option IN ('a','b','c','d')),
        explanation     TEXT,
        subject         VARCHAR(100),
        difficulty      difficulty NOT NULL DEFAULT 'medium',
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE quiz_attempts (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quiz_id         UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        score           INTEGER NOT NULL DEFAULT 0,
        total_questions INTEGER NOT NULL DEFAULT 0,
        correct_answers INTEGER NOT NULL DEFAULT 0,
        time_taken_secs INTEGER NOT NULL DEFAULT 0,
        coins_earned    INTEGER NOT NULL DEFAULT 0,
        answers         JSONB NOT NULL DEFAULT '[]',
        is_passed       BOOLEAN NOT NULL DEFAULT FALSE,
        attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Current Affairs ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE current_affairs (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(500) NOT NULL,
        summary         TEXT NOT NULL,
        full_content    TEXT,
        category        VARCHAR(100),
        source          VARCHAR(200),
        date            DATE NOT NULL DEFAULT CURRENT_DATE,
        is_important    BOOLEAN NOT NULL DEFAULT FALSE,
        exam_tags       TEXT[] DEFAULT '{}',
        tags            TEXT[] DEFAULT '{}',
        view_count      INTEGER NOT NULL DEFAULT 0,
        bookmark_count  INTEGER NOT NULL DEFAULT 0,
        status          content_status NOT NULL DEFAULT 'draft',
        author          VARCHAR(100),
        created_by      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE affairs_bookmarks (
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        affair_id  UUID NOT NULL REFERENCES current_affairs(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, affair_id)
      )
    `);

    // ── Jobs ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE job_vacancies (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title             VARCHAR(255) NOT NULL,
        organization      VARCHAR(255) NOT NULL,
        category          VARCHAR(100),
        total_posts       INTEGER NOT NULL DEFAULT 0,
        notification_date DATE,
        last_date         DATE NOT NULL,
        exam_date         DATE,
        age_limit         VARCHAR(50),
        qualification     VARCHAR(255),
        application_link  TEXT,
        description       TEXT,
        status            job_status NOT NULL DEFAULT 'active',
        view_count        INTEGER NOT NULL DEFAULT 0,
        save_count        INTEGER NOT NULL DEFAULT 0,
        exam_tags         TEXT[] DEFAULT '{}',
        created_by        UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE job_saves (
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id     UUID NOT NULL REFERENCES job_vacancies(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, job_id)
      )
    `);

    // ── Subscriptions ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE subscriptions (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan                  sub_plan NOT NULL,
        amount                INTEGER NOT NULL,
        original_amount       INTEGER NOT NULL,
        coins_used            INTEGER NOT NULL DEFAULT 0,
        coin_discount         INTEGER NOT NULL DEFAULT 0,
        coupon_code           VARCHAR(20),
        coupon_discount       INTEGER NOT NULL DEFAULT 0,
        final_amount          INTEGER NOT NULL,
        payment_method        VARCHAR(50),
        upi_id                VARCHAR(100),
        razorpay_order_id     VARCHAR(100),
        razorpay_payment_id   VARCHAR(100),
        payment_status        pay_status NOT NULL DEFAULT 'pending',
        status                sub_status NOT NULL DEFAULT 'pending',
        auto_renew            BOOLEAN NOT NULL DEFAULT TRUE,
        starts_at             TIMESTAMPTZ,
        ends_at               TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Coupons ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE coupons (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        code        VARCHAR(30) UNIQUE NOT NULL,
        type        VARCHAR(10) NOT NULL CHECK (type IN ('flat','percent')),
        value       INTEGER NOT NULL,
        description VARCHAR(255),
        applies_to  VARCHAR(20) NOT NULL DEFAULT 'both',
        used_count  INTEGER NOT NULL DEFAULT 0,
        max_uses    INTEGER,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at  TIMESTAMPTZ,
        created_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Coins ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE coin_rules (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        action        VARCHAR(50) UNIQUE NOT NULL,
        description   VARCHAR(255) NOT NULL,
        coins_awarded INTEGER NOT NULL,
        max_per_day   INTEGER NOT NULL DEFAULT 1,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE coin_transactions (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        txn_type NOT NULL,
        amount      INTEGER NOT NULL,
        description VARCHAR(255) NOT NULL,
        action      VARCHAR(50),
        ref_id      UUID,
        balance     INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Notifications ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE notifications (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(255) NOT NULL,
        body            TEXT NOT NULL,
        type            VARCHAR(50),
        target          notif_target NOT NULL DEFAULT 'all',
        target_exam     VARCHAR(100),
        target_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
        data            JSONB NOT NULL DEFAULT '{}',
        status          notif_status NOT NULL DEFAULT 'draft',
        scheduled_at    TIMESTAMPTZ,
        sent_at         TIMESTAMPTZ,
        total_sent      INTEGER NOT NULL DEFAULT 0,
        total_opened    INTEGER NOT NULL DEFAULT 0,
        total_clicked   INTEGER NOT NULL DEFAULT 0,
        created_by      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE user_notifications (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
        title           VARCHAR(255) NOT NULL,
        body            TEXT NOT NULL,
        type            VARCHAR(50),
        is_read         BOOLEAN NOT NULL DEFAULT FALSE,
        read_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Study Rooms ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE study_rooms (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name            VARCHAR(100) NOT NULL,
        subject         VARCHAR(100),
        host_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        max_members     INTEGER NOT NULL DEFAULT 20,
        is_private      BOOLEAN NOT NULL DEFAULT FALSE,
        join_code       VARCHAR(10) UNIQUE,
        status          room_status NOT NULL DEFAULT 'active',
        exam_tags       TEXT[] DEFAULT '{}',
        total_sessions  INTEGER NOT NULL DEFAULT 0,
        ended_at        TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE room_members (
        room_id    UUID NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        left_at    TIMESTAMPTZ,
        PRIMARY KEY (room_id, user_id)
      )
    `);

    // ── Live Classes ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE live_classes (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title             VARCHAR(255) NOT NULL,
        instructor        VARCHAR(100),
        subject           VARCHAR(100),
        description       TEXT,
        meeting_link      TEXT,
        thumbnail_url     TEXT,
        scheduled_at      TIMESTAMPTZ NOT NULL,
        duration_mins     INTEGER NOT NULL DEFAULT 60,
        exam_tags         TEXT[] DEFAULT '{}',
        registered_count  INTEGER NOT NULL DEFAULT 0,
        status            VARCHAR(20) NOT NULL DEFAULT 'scheduled',
        created_by        UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE live_class_registrations (
        live_class_id UUID NOT NULL REFERENCES live_classes(id) ON DELETE CASCADE,
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (live_class_id, user_id)
      )
    `);

    // ── Certificates ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE certificates (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        certificate_url  TEXT,
        issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, course_id)
      )
    `);

    // ── Banners ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE banners (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title             VARCHAR(255) NOT NULL,
        subtitle          VARCHAR(255),
        image_url         TEXT,
        action_link       VARCHAR(255),
        type              VARCHAR(30) NOT NULL DEFAULT 'promotion',
        target            VARCHAR(100) NOT NULL DEFAULT 'all',
        bg_gradient       VARCHAR(100),
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        click_count       INTEGER NOT NULL DEFAULT 0,
        impression_count  INTEGER NOT NULL DEFAULT 0,
        created_by        UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── App Settings ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE app_settings (
        key         VARCHAR(100) PRIMARY KEY,
        value       TEXT NOT NULL,
        description VARCHAR(255),
        updated_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Flashcards ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE flashcards (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        front       TEXT NOT NULL,
        back        TEXT NOT NULL,
        subject     VARCHAR(100),
        exam_tags   TEXT[] DEFAULT '{}',
        difficulty  difficulty NOT NULL DEFAULT 'medium',
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE user_flashcard_progress (
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        flashcard_id  UUID NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
        ease_factor   DECIMAL(4,2) NOT NULL DEFAULT 2.5,
        interval      INTEGER NOT NULL DEFAULT 1,
        repetitions   INTEGER NOT NULL DEFAULT 0,
        next_review   DATE NOT NULL DEFAULT CURRENT_DATE,
        last_reviewed TIMESTAMPTZ,
        PRIMARY KEY (user_id, flashcard_id)
      )
    `);

    // ═══════════════════════════════════════════════════════════
    // INDEXES — Critical for performance
    // ═══════════════════════════════════════════════════════════
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_users_mobile       ON users(mobile)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_users_exam         ON users(primary_exam)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_users_status       ON users(status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_users_last_active  ON users(last_active_at DESC)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_users_rank         ON users(rank ASC NULLS LAST)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_otps_mobile        ON otps(mobile, is_used)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_courses_status     ON courses(status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_courses_subject    ON courses(subject)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_courses_exam_tags  ON courses USING gin(exam_tags)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_library_status     ON library_notes(status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_library_type       ON library_notes(type)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_library_exam_tags  ON library_notes USING gin(exam_tags)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_quizzes_type       ON quizzes(type, status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_quizzes_scheduled  ON quizzes(scheduled_for)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_affairs_date       ON current_affairs(date DESC, status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_affairs_category   ON current_affairs(category)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_jobs_status        ON job_vacancies(status, last_date)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_subs_user          ON subscriptions(user_id, status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_subs_ends_at       ON subscriptions(ends_at)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_coin_txns_user     ON coin_transactions(user_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_notifs_user        ON user_notifications(user_id, is_read, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_enrollments_user   ON user_enrollments(user_id, status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_attempts_user      ON quiz_attempts(user_id, attempted_at DESC)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_rooms_status       ON study_rooms(status)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_banners_active     ON banners(is_active, sort_order)`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_live_classes_sched ON live_classes(scheduled_at, status)`);

    // Full-text search indexes
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_courses_fts   ON courses USING gin(to_tsvector('english', title || ' ' || COALESCE(description,'')))`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_affairs_fts   ON current_affairs USING gin(to_tsvector('english', title || ' ' || summary))`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_library_fts   ON library_notes USING gin(to_tsvector('english', title || ' ' || COALESCE(description,'')))`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_library_tags  ON library_notes USING gin(tags)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = [
      'user_flashcard_progress','flashcards','app_settings','banners',
      'certificates','live_class_registrations','live_classes',
      'room_members','study_rooms','user_notifications','notifications',
      'coin_transactions','coin_rules','coupons','subscriptions',
      'job_saves','job_vacancies','affairs_bookmarks','current_affairs',
      'quiz_attempts','quiz_questions','quizzes','note_downloads',
      'note_bookmarks','library_notes','lesson_progress','user_enrollments',
      'course_reviews','course_lessons','course_chapters','courses',
      'exams','otps','users','admin_users',
    ];
    for (const t of tables) await queryRunner.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    const enums = ['user_status','user_role','prep_level','sub_plan','sub_status','content_status','note_type','quiz_type','difficulty','txn_type','notif_target','notif_status','job_status','room_status','pay_status'];
    for (const e of enums) await queryRunner.query(`DROP TYPE IF EXISTS ${e}`);
  }
}
