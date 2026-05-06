--
-- PostgreSQL database dump
--

\restrict 8itYPvrfzeTUrDY0m6bSNQnp8LCswtjzXRflI8GgtbY4REGiBIVdLgNcE7j8dKH

-- Dumped from database version 14.22 (Homebrew)
-- Dumped by pg_dump version 14.22 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: content_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.content_status AS ENUM (
    'draft',
    'review',
    'published',
    'rejected'
);


ALTER TYPE public.content_status OWNER TO postgres;

--
-- Name: difficulty; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.difficulty AS ENUM (
    'easy',
    'medium',
    'hard'
);


ALTER TYPE public.difficulty OWNER TO postgres;

--
-- Name: job_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.job_status AS ENUM (
    'active',
    'expired',
    'upcoming'
);


ALTER TYPE public.job_status OWNER TO postgres;

--
-- Name: note_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.note_type AS ENUM (
    'pdf',
    'pyq',
    'book',
    'video'
);


ALTER TYPE public.note_type OWNER TO postgres;

--
-- Name: notif_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.notif_status AS ENUM (
    'draft',
    'scheduled',
    'sent',
    'failed'
);


ALTER TYPE public.notif_status OWNER TO postgres;

--
-- Name: notif_target; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.notif_target AS ENUM (
    'all',
    'free',
    'pro',
    'exam',
    'custom',
    'user'
);


ALTER TYPE public.notif_target OWNER TO postgres;

--
-- Name: pay_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.pay_status AS ENUM (
    'pending',
    'success',
    'failed',
    'refunded'
);


ALTER TYPE public.pay_status OWNER TO postgres;

--
-- Name: prep_level; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.prep_level AS ENUM (
    'beginner',
    'intermediate',
    'advanced'
);


ALTER TYPE public.prep_level OWNER TO postgres;

--
-- Name: quiz_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.quiz_type AS ENUM (
    'daily',
    'topic',
    'mock'
);


ALTER TYPE public.quiz_type OWNER TO postgres;

--
-- Name: room_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.room_status AS ENUM (
    'active',
    'ended',
    'archived'
);


ALTER TYPE public.room_status OWNER TO postgres;

--
-- Name: sub_plan; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.sub_plan AS ENUM (
    'monthly',
    'quarterly',
    'annual'
);


ALTER TYPE public.sub_plan OWNER TO postgres;

--
-- Name: sub_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.sub_status AS ENUM (
    'active',
    'expired',
    'cancelled',
    'pending'
);


ALTER TYPE public.sub_status OWNER TO postgres;

--
-- Name: txn_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.txn_type AS ENUM (
    'earned',
    'spent'
);


ALTER TYPE public.txn_type OWNER TO postgres;

--
-- Name: user_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.user_role AS ENUM (
    'student',
    'instructor',
    'admin'
);


ALTER TYPE public.user_role OWNER TO postgres;

--
-- Name: user_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'banned',
    'pending',
    'deleted'
);


ALTER TYPE public.user_status OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.admin_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(200) NOT NULL,
    password_hash character varying(255) NOT NULL,
    permissions text[] DEFAULT '{}'::text[],
    status character varying(20) DEFAULT 'active'::character varying,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.admin_users OWNER TO postgres;

--
-- Name: affairs_bookmarks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.affairs_bookmarks (
    user_id uuid NOT NULL,
    affair_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.affairs_bookmarks OWNER TO postgres;

--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_settings (
    key character varying(100) NOT NULL,
    value text NOT NULL,
    description character varying(255),
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.app_settings OWNER TO postgres;

--
-- Name: banners; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.banners (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    subtitle character varying(255),
    image_url text,
    action_link character varying(255),
    type character varying(30) DEFAULT 'promotion'::character varying NOT NULL,
    target character varying(100) DEFAULT 'all'::character varying NOT NULL,
    bg_gradient character varying(100),
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    click_count integer DEFAULT 0 NOT NULL,
    impression_count integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.banners OWNER TO postgres;

--
-- Name: certificates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.certificates (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    course_id uuid NOT NULL,
    certificate_url text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.certificates OWNER TO postgres;

--
-- Name: coin_rules; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coin_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    action character varying(50) NOT NULL,
    description character varying(255) NOT NULL,
    coins_awarded integer NOT NULL,
    max_per_day integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.coin_rules OWNER TO postgres;

--
-- Name: coin_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coin_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    type public.txn_type NOT NULL,
    amount integer NOT NULL,
    description character varying(255) NOT NULL,
    action character varying(50),
    ref_id uuid,
    balance integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.coin_transactions OWNER TO postgres;

--
-- Name: coupons; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coupons (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    code character varying(30) NOT NULL,
    type character varying(10) NOT NULL,
    value integer NOT NULL,
    description character varying(255),
    applies_to character varying(20) DEFAULT 'both'::character varying NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    max_uses integer,
    is_active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupons_type_check CHECK (((type)::text = ANY ((ARRAY['flat'::character varying, 'percent'::character varying])::text[])))
);


ALTER TABLE public.coupons OWNER TO postgres;

--
-- Name: course_chapters; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.course_chapters (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    course_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.course_chapters OWNER TO postgres;

--
-- Name: course_lessons; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.course_lessons (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    chapter_id uuid NOT NULL,
    course_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    duration_mins integer DEFAULT 0 NOT NULL,
    type character varying(20) DEFAULT 'video'::character varying NOT NULL,
    video_url text,
    notes_url text,
    is_free_preview boolean DEFAULT false NOT NULL,
    is_locked boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.course_lessons OWNER TO postgres;

--
-- Name: course_reviews; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.course_reviews (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    course_id uuid NOT NULL,
    user_id uuid NOT NULL,
    rating numeric(2,1) NOT NULL,
    comment text,
    is_verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.course_reviews OWNER TO postgres;

--
-- Name: courses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.courses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    slug character varying(300),
    description text,
    instructor character varying(100),
    instructor_bio text,
    subject character varying(100),
    price integer DEFAULT 0 NOT NULL,
    original_price integer DEFAULT 0 NOT NULL,
    is_paid boolean DEFAULT false NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    is_limited_offer boolean DEFAULT false NOT NULL,
    offer_ends_at timestamp with time zone,
    thumbnail_url text,
    total_lessons integer DEFAULT 0 NOT NULL,
    total_hours numeric(5,1) DEFAULT 0 NOT NULL,
    rating numeric(3,2) DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    enrollment_count integer DEFAULT 0 NOT NULL,
    bpsc_relevance integer DEFAULT 0 NOT NULL,
    syllabus_coverage integer DEFAULT 0 NOT NULL,
    language character varying(50) DEFAULT 'Hindi + English'::character varying,
    trial_lesson_title character varying(255),
    exam_tags text[] DEFAULT '{}'::text[],
    status public.content_status DEFAULT 'draft'::public.content_status NOT NULL,
    meta_keywords text[],
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.courses OWNER TO postgres;

--
-- Name: current_affairs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.current_affairs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(500) NOT NULL,
    summary text NOT NULL,
    full_content text,
    category character varying(100),
    source character varying(200),
    date date DEFAULT CURRENT_DATE NOT NULL,
    is_important boolean DEFAULT false NOT NULL,
    exam_tags text[] DEFAULT '{}'::text[],
    tags text[] DEFAULT '{}'::text[],
    view_count integer DEFAULT 0 NOT NULL,
    bookmark_count integer DEFAULT 0 NOT NULL,
    status public.content_status DEFAULT 'draft'::public.content_status NOT NULL,
    author character varying(100),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.current_affairs OWNER TO postgres;

--
-- Name: daily_targets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.daily_targets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    subject text DEFAULT 'General'::text,
    difficulty text DEFAULT 'medium'::text,
    time_slot text DEFAULT 'morning'::text,
    estimated_minutes integer DEFAULT 25,
    total_questions integer DEFAULT 10,
    attempted_questions integer DEFAULT 0,
    is_completed boolean DEFAULT false,
    is_carried_forward boolean DEFAULT false,
    target_date date NOT NULL,
    completed_at timestamp without time zone,
    source_quiz_id uuid,
    source_note_id uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.daily_targets OWNER TO postgres;

--
-- Name: exams; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.exams (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    full_name character varying(255) NOT NULL,
    category character varying(50) NOT NULL,
    emoji character varying(10),
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.exams OWNER TO postgres;

--
-- Name: flashcards; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.flashcards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    front text NOT NULL,
    back text NOT NULL,
    subject character varying(100),
    exam_tags text[] DEFAULT '{}'::text[],
    difficulty public.difficulty DEFAULT 'medium'::public.difficulty NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.flashcards OWNER TO postgres;

--
-- Name: job_saves; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.job_saves (
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.job_saves OWNER TO postgres;

--
-- Name: job_vacancies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.job_vacancies (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    organization character varying(255) NOT NULL,
    category character varying(100),
    total_posts integer DEFAULT 0 NOT NULL,
    notification_date date,
    last_date date NOT NULL,
    exam_date date,
    age_limit character varying(50),
    qualification character varying(255),
    application_link text,
    description text,
    status public.job_status DEFAULT 'active'::public.job_status NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    save_count integer DEFAULT 0 NOT NULL,
    exam_tags text[] DEFAULT '{}'::text[],
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.job_vacancies OWNER TO postgres;

--
-- Name: lesson_progress; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.lesson_progress (
    user_id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    is_completed boolean DEFAULT false NOT NULL,
    watch_time_secs integer DEFAULT 0 NOT NULL,
    completed_at timestamp with time zone
);


ALTER TABLE public.lesson_progress OWNER TO postgres;

--
-- Name: library_notes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.library_notes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    subject character varying(100),
    type public.note_type NOT NULL,
    author character varying(100),
    uploaded_by_id uuid,
    file_url text,
    thumbnail_url text,
    pages integer DEFAULT 0 NOT NULL,
    file_size_mb numeric(6,2) DEFAULT 0 NOT NULL,
    is_premium boolean DEFAULT false NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    is_trending boolean DEFAULT false NOT NULL,
    download_count integer DEFAULT 0 NOT NULL,
    rating numeric(3,2) DEFAULT 0 NOT NULL,
    status public.content_status DEFAULT 'draft'::public.content_status NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    exam_tags text[] DEFAULT '{}'::text[],
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.library_notes OWNER TO postgres;

--
-- Name: live_class_registrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.live_class_registrations (
    live_class_id uuid NOT NULL,
    user_id uuid NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.live_class_registrations OWNER TO postgres;

--
-- Name: live_classes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.live_classes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    instructor character varying(100),
    subject character varying(100),
    description text,
    meeting_link text,
    thumbnail_url text,
    scheduled_at timestamp with time zone NOT NULL,
    duration_mins integer DEFAULT 60 NOT NULL,
    exam_tags text[] DEFAULT '{}'::text[],
    registered_count integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'scheduled'::character varying NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.live_classes OWNER TO postgres;

--
-- Name: migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);


ALTER TABLE public.migrations OWNER TO postgres;

--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.migrations_id_seq OWNER TO postgres;

--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: note_bookmarks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.note_bookmarks (
    user_id uuid NOT NULL,
    note_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.note_bookmarks OWNER TO postgres;

--
-- Name: note_downloads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.note_downloads (
    user_id uuid NOT NULL,
    note_id uuid NOT NULL,
    downloaded_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.note_downloads OWNER TO postgres;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    type character varying(50),
    target public.notif_target DEFAULT 'all'::public.notif_target NOT NULL,
    target_exam character varying(100),
    target_user_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.notif_status DEFAULT 'draft'::public.notif_status NOT NULL,
    scheduled_at timestamp with time zone,
    sent_at timestamp with time zone,
    total_sent integer DEFAULT 0 NOT NULL,
    total_opened integer DEFAULT 0 NOT NULL,
    total_clicked integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.notifications OWNER TO postgres;

--
-- Name: otps; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.otps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    mobile character varying(15) NOT NULL,
    otp_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    is_used boolean DEFAULT false NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.otps OWNER TO postgres;

--
-- Name: quiz_attempts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quiz_attempts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    quiz_id uuid NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    total_questions integer DEFAULT 0 NOT NULL,
    correct_answers integer DEFAULT 0 NOT NULL,
    time_taken_secs integer DEFAULT 0 NOT NULL,
    coins_earned integer DEFAULT 0 NOT NULL,
    answers jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_passed boolean DEFAULT false NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    submitted_at timestamp with time zone
);


ALTER TABLE public.quiz_attempts OWNER TO postgres;

--
-- Name: quiz_questions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quiz_questions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    quiz_id uuid NOT NULL,
    question_text text NOT NULL,
    option_a text NOT NULL,
    option_b text NOT NULL,
    option_c text NOT NULL,
    option_d text NOT NULL,
    correct_option character(1) NOT NULL,
    explanation text,
    subject character varying(100),
    difficulty public.difficulty DEFAULT 'medium'::public.difficulty NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quiz_questions_correct_option_check CHECK ((correct_option = ANY (ARRAY['a'::bpchar, 'b'::bpchar, 'c'::bpchar, 'd'::bpchar])))
);


ALTER TABLE public.quiz_questions OWNER TO postgres;

--
-- Name: quizzes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.quizzes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    subject character varying(100),
    type public.quiz_type DEFAULT 'topic'::public.quiz_type NOT NULL,
    difficulty public.difficulty DEFAULT 'medium'::public.difficulty NOT NULL,
    total_questions integer DEFAULT 10 NOT NULL,
    duration_mins integer DEFAULT 15 NOT NULL,
    passing_score integer DEFAULT 60 NOT NULL,
    coins_reward integer DEFAULT 10 NOT NULL,
    exam_tags text[] DEFAULT '{}'::text[],
    attempt_count integer DEFAULT 0 NOT NULL,
    avg_score numeric(5,2) DEFAULT 0 NOT NULL,
    status public.content_status DEFAULT 'draft'::public.content_status NOT NULL,
    scheduled_for date,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.quizzes OWNER TO postgres;

--
-- Name: room_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.room_members (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone
);


ALTER TABLE public.room_members OWNER TO postgres;

--
-- Name: study_rooms; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.study_rooms (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    subject character varying(100),
    host_id uuid NOT NULL,
    max_members integer DEFAULT 20 NOT NULL,
    is_private boolean DEFAULT false NOT NULL,
    join_code character varying(10),
    status public.room_status DEFAULT 'active'::public.room_status NOT NULL,
    exam_tags text[] DEFAULT '{}'::text[],
    total_sessions integer DEFAULT 0 NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.study_rooms OWNER TO postgres;

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    plan public.sub_plan NOT NULL,
    amount integer NOT NULL,
    original_amount integer NOT NULL,
    coins_used integer DEFAULT 0 NOT NULL,
    coin_discount integer DEFAULT 0 NOT NULL,
    coupon_code character varying(20),
    coupon_discount integer DEFAULT 0 NOT NULL,
    final_amount integer NOT NULL,
    payment_method character varying(50),
    upi_id character varying(100),
    razorpay_order_id character varying(100),
    razorpay_payment_id character varying(100),
    payment_status public.pay_status DEFAULT 'pending'::public.pay_status NOT NULL,
    status public.sub_status DEFAULT 'pending'::public.sub_status NOT NULL,
    auto_renew boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.subscriptions OWNER TO postgres;

--
-- Name: user_enrollments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_enrollments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    course_id uuid NOT NULL,
    completed_lessons integer DEFAULT 0 NOT NULL,
    last_lesson_id uuid,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


ALTER TABLE public.user_enrollments OWNER TO postgres;

--
-- Name: user_flashcard_progress; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_flashcard_progress (
    user_id uuid NOT NULL,
    flashcard_id uuid NOT NULL,
    ease_factor numeric(4,2) DEFAULT 2.5 NOT NULL,
    "interval" integer DEFAULT 1 NOT NULL,
    repetitions integer DEFAULT 0 NOT NULL,
    next_review date DEFAULT CURRENT_DATE NOT NULL,
    last_reviewed timestamp with time zone
);


ALTER TABLE public.user_flashcard_progress OWNER TO postgres;

--
-- Name: user_notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    notification_id uuid,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    type character varying(50),
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.user_notifications OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(200),
    mobile character varying(15) NOT NULL,
    mobile_verified boolean DEFAULT false NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    avatar_url text,
    bio text,
    district character varying(100),
    state character varying(100) DEFAULT 'Bihar'::character varying,
    role public.user_role DEFAULT 'student'::public.user_role NOT NULL,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    primary_exam character varying(100),
    secondary_exam character varying(100),
    prep_level public.prep_level DEFAULT 'beginner'::public.prep_level,
    target_year smallint,
    streak integer DEFAULT 0 NOT NULL,
    longest_streak integer DEFAULT 0 NOT NULL,
    last_study_date date,
    coins integer DEFAULT 0 NOT NULL,
    total_coins_earned integer DEFAULT 0 NOT NULL,
    rank integer,
    total_study_minutes integer DEFAULT 0 NOT NULL,
    accuracy numeric(5,2) DEFAULT 0 NOT NULL,
    quizzes_attempted integer DEFAULT 0 NOT NULL,
    fcm_token text,
    refresh_token text,
    referral_code character varying(20),
    referred_by uuid,
    is_verified boolean DEFAULT false NOT NULL,
    notification_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: migrations PK_8c82d7f526340ab734260ea46be; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id);


--
-- Name: admin_users admin_users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_email_key UNIQUE (email);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: affairs_bookmarks affairs_bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.affairs_bookmarks
    ADD CONSTRAINT affairs_bookmarks_pkey PRIMARY KEY (user_id, affair_id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: banners banners_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.banners
    ADD CONSTRAINT banners_pkey PRIMARY KEY (id);


--
-- Name: certificates certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_pkey PRIMARY KEY (id);


--
-- Name: certificates certificates_user_id_course_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_user_id_course_id_key UNIQUE (user_id, course_id);


--
-- Name: coin_rules coin_rules_action_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coin_rules
    ADD CONSTRAINT coin_rules_action_key UNIQUE (action);


--
-- Name: coin_rules coin_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coin_rules
    ADD CONSTRAINT coin_rules_pkey PRIMARY KEY (id);


--
-- Name: coin_transactions coin_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coin_transactions
    ADD CONSTRAINT coin_transactions_pkey PRIMARY KEY (id);


--
-- Name: coupons coupons_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_code_key UNIQUE (code);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: course_chapters course_chapters_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_chapters
    ADD CONSTRAINT course_chapters_pkey PRIMARY KEY (id);


--
-- Name: course_lessons course_lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_lessons
    ADD CONSTRAINT course_lessons_pkey PRIMARY KEY (id);


--
-- Name: course_reviews course_reviews_course_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_reviews
    ADD CONSTRAINT course_reviews_course_id_user_id_key UNIQUE (course_id, user_id);


--
-- Name: course_reviews course_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_reviews
    ADD CONSTRAINT course_reviews_pkey PRIMARY KEY (id);


--
-- Name: courses courses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_pkey PRIMARY KEY (id);


--
-- Name: courses courses_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_slug_key UNIQUE (slug);


--
-- Name: current_affairs current_affairs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.current_affairs
    ADD CONSTRAINT current_affairs_pkey PRIMARY KEY (id);


--
-- Name: daily_targets daily_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_targets
    ADD CONSTRAINT daily_targets_pkey PRIMARY KEY (id);


--
-- Name: exams exams_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_name_key UNIQUE (name);


--
-- Name: exams exams_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_pkey PRIMARY KEY (id);


--
-- Name: flashcards flashcards_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.flashcards
    ADD CONSTRAINT flashcards_pkey PRIMARY KEY (id);


--
-- Name: job_saves job_saves_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_saves
    ADD CONSTRAINT job_saves_pkey PRIMARY KEY (user_id, job_id);


--
-- Name: job_vacancies job_vacancies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_vacancies
    ADD CONSTRAINT job_vacancies_pkey PRIMARY KEY (id);


--
-- Name: lesson_progress lesson_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_pkey PRIMARY KEY (user_id, lesson_id);


--
-- Name: library_notes library_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.library_notes
    ADD CONSTRAINT library_notes_pkey PRIMARY KEY (id);


--
-- Name: live_class_registrations live_class_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.live_class_registrations
    ADD CONSTRAINT live_class_registrations_pkey PRIMARY KEY (live_class_id, user_id);


--
-- Name: live_classes live_classes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.live_classes
    ADD CONSTRAINT live_classes_pkey PRIMARY KEY (id);


--
-- Name: note_bookmarks note_bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_bookmarks
    ADD CONSTRAINT note_bookmarks_pkey PRIMARY KEY (user_id, note_id);


--
-- Name: note_downloads note_downloads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_downloads
    ADD CONSTRAINT note_downloads_pkey PRIMARY KEY (user_id, note_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: otps otps_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.otps
    ADD CONSTRAINT otps_pkey PRIMARY KEY (id);


--
-- Name: quiz_attempts quiz_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quiz_attempts
    ADD CONSTRAINT quiz_attempts_pkey PRIMARY KEY (id);


--
-- Name: quiz_questions quiz_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quiz_questions
    ADD CONSTRAINT quiz_questions_pkey PRIMARY KEY (id);


--
-- Name: quizzes quizzes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quizzes
    ADD CONSTRAINT quizzes_pkey PRIMARY KEY (id);


--
-- Name: room_members room_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: study_rooms study_rooms_join_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.study_rooms
    ADD CONSTRAINT study_rooms_join_code_key UNIQUE (join_code);


--
-- Name: study_rooms study_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.study_rooms
    ADD CONSTRAINT study_rooms_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: user_enrollments user_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_enrollments
    ADD CONSTRAINT user_enrollments_pkey PRIMARY KEY (id);


--
-- Name: user_enrollments user_enrollments_user_id_course_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_enrollments
    ADD CONSTRAINT user_enrollments_user_id_course_id_key UNIQUE (user_id, course_id);


--
-- Name: user_flashcard_progress user_flashcard_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_flashcard_progress
    ADD CONSTRAINT user_flashcard_progress_pkey PRIMARY KEY (user_id, flashcard_id);


--
-- Name: user_notifications user_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_mobile_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_mobile_key UNIQUE (mobile);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_referral_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);


--
-- Name: idx_affairs_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_affairs_category ON public.current_affairs USING btree (category);


--
-- Name: idx_affairs_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_affairs_date ON public.current_affairs USING btree (date DESC, status);


--
-- Name: idx_affairs_fts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_affairs_fts ON public.current_affairs USING gin (to_tsvector('english'::regconfig, (((title)::text || ' '::text) || summary)));


--
-- Name: idx_attempts_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_attempts_user ON public.quiz_attempts USING btree (user_id, attempted_at DESC);


--
-- Name: idx_banners_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_banners_active ON public.banners USING btree (is_active, sort_order);


--
-- Name: idx_coin_txns_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_coin_txns_user ON public.coin_transactions USING btree (user_id, created_at DESC);


--
-- Name: idx_courses_exam_tags; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_courses_exam_tags ON public.courses USING gin (exam_tags);


--
-- Name: idx_courses_fts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_courses_fts ON public.courses USING gin (to_tsvector('english'::regconfig, (((title)::text || ' '::text) || COALESCE(description, ''::text))));


--
-- Name: idx_courses_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_courses_status ON public.courses USING btree (status);


--
-- Name: idx_courses_subject; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_courses_subject ON public.courses USING btree (subject);


--
-- Name: idx_enrollments_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enrollments_user ON public.user_enrollments USING btree (user_id, status);


--
-- Name: idx_jobs_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_jobs_status ON public.job_vacancies USING btree (status, last_date);


--
-- Name: idx_library_exam_tags; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_library_exam_tags ON public.library_notes USING gin (exam_tags);


--
-- Name: idx_library_fts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_library_fts ON public.library_notes USING gin (to_tsvector('english'::regconfig, (((title)::text || ' '::text) || COALESCE(description, ''::text))));


--
-- Name: idx_library_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_library_status ON public.library_notes USING btree (status);


--
-- Name: idx_library_tags; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_library_tags ON public.library_notes USING gin (tags);


--
-- Name: idx_library_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_library_type ON public.library_notes USING btree (type);


--
-- Name: idx_live_classes_sched; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_live_classes_sched ON public.live_classes USING btree (scheduled_at, status);


--
-- Name: idx_notifs_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifs_user ON public.user_notifications USING btree (user_id, is_read, created_at DESC);


--
-- Name: idx_otps_mobile; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_otps_mobile ON public.otps USING btree (mobile, is_used);


--
-- Name: idx_quizzes_scheduled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_quizzes_scheduled ON public.quizzes USING btree (scheduled_for);


--
-- Name: idx_quizzes_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_quizzes_type ON public.quizzes USING btree (type, status);


--
-- Name: idx_rooms_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rooms_status ON public.study_rooms USING btree (status);


--
-- Name: idx_subs_ends_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_subs_ends_at ON public.subscriptions USING btree (ends_at);


--
-- Name: idx_subs_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_subs_user ON public.subscriptions USING btree (user_id, status);


--
-- Name: idx_users_exam; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_exam ON public.users USING btree (primary_exam);


--
-- Name: idx_users_last_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_last_active ON public.users USING btree (last_active_at DESC);


--
-- Name: idx_users_mobile; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_mobile ON public.users USING btree (mobile);


--
-- Name: idx_users_rank; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_rank ON public.users USING btree (rank);


--
-- Name: idx_users_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_status ON public.users USING btree (status);


--
-- Name: affairs_bookmarks affairs_bookmarks_affair_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.affairs_bookmarks
    ADD CONSTRAINT affairs_bookmarks_affair_id_fkey FOREIGN KEY (affair_id) REFERENCES public.current_affairs(id) ON DELETE CASCADE;


--
-- Name: affairs_bookmarks affairs_bookmarks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.affairs_bookmarks
    ADD CONSTRAINT affairs_bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: banners banners_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.banners
    ADD CONSTRAINT banners_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: certificates certificates_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: certificates certificates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: coin_transactions coin_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coin_transactions
    ADD CONSTRAINT coin_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: coupons coupons_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: course_chapters course_chapters_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_chapters
    ADD CONSTRAINT course_chapters_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: course_lessons course_lessons_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_lessons
    ADD CONSTRAINT course_lessons_chapter_id_fkey FOREIGN KEY (chapter_id) REFERENCES public.course_chapters(id) ON DELETE CASCADE;


--
-- Name: course_lessons course_lessons_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_lessons
    ADD CONSTRAINT course_lessons_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: course_reviews course_reviews_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_reviews
    ADD CONSTRAINT course_reviews_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: course_reviews course_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.course_reviews
    ADD CONSTRAINT course_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: courses courses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: current_affairs current_affairs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.current_affairs
    ADD CONSTRAINT current_affairs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: flashcards flashcards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.flashcards
    ADD CONSTRAINT flashcards_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: job_saves job_saves_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_saves
    ADD CONSTRAINT job_saves_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.job_vacancies(id) ON DELETE CASCADE;


--
-- Name: job_saves job_saves_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_saves
    ADD CONSTRAINT job_saves_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: job_vacancies job_vacancies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_vacancies
    ADD CONSTRAINT job_vacancies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: lesson_progress lesson_progress_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.course_lessons(id) ON DELETE CASCADE;


--
-- Name: lesson_progress lesson_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: library_notes library_notes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.library_notes
    ADD CONSTRAINT library_notes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: library_notes library_notes_uploaded_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.library_notes
    ADD CONSTRAINT library_notes_uploaded_by_id_fkey FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: live_class_registrations live_class_registrations_live_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.live_class_registrations
    ADD CONSTRAINT live_class_registrations_live_class_id_fkey FOREIGN KEY (live_class_id) REFERENCES public.live_classes(id) ON DELETE CASCADE;


--
-- Name: live_class_registrations live_class_registrations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.live_class_registrations
    ADD CONSTRAINT live_class_registrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: live_classes live_classes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.live_classes
    ADD CONSTRAINT live_classes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: note_bookmarks note_bookmarks_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_bookmarks
    ADD CONSTRAINT note_bookmarks_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.library_notes(id) ON DELETE CASCADE;


--
-- Name: note_bookmarks note_bookmarks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_bookmarks
    ADD CONSTRAINT note_bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: note_downloads note_downloads_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_downloads
    ADD CONSTRAINT note_downloads_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.library_notes(id) ON DELETE CASCADE;


--
-- Name: note_downloads note_downloads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.note_downloads
    ADD CONSTRAINT note_downloads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: quiz_attempts quiz_attempts_quiz_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quiz_attempts
    ADD CONSTRAINT quiz_attempts_quiz_id_fkey FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE;


--
-- Name: quiz_attempts quiz_attempts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quiz_attempts
    ADD CONSTRAINT quiz_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: quiz_questions quiz_questions_quiz_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quiz_questions
    ADD CONSTRAINT quiz_questions_quiz_id_fkey FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE;


--
-- Name: quizzes quizzes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.quizzes
    ADD CONSTRAINT quizzes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: room_members room_members_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.study_rooms(id) ON DELETE CASCADE;


--
-- Name: room_members room_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: study_rooms study_rooms_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.study_rooms
    ADD CONSTRAINT study_rooms_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_enrollments user_enrollments_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_enrollments
    ADD CONSTRAINT user_enrollments_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: user_enrollments user_enrollments_last_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_enrollments
    ADD CONSTRAINT user_enrollments_last_lesson_id_fkey FOREIGN KEY (last_lesson_id) REFERENCES public.course_lessons(id) ON DELETE SET NULL;


--
-- Name: user_enrollments user_enrollments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_enrollments
    ADD CONSTRAINT user_enrollments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_flashcard_progress user_flashcard_progress_flashcard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_flashcard_progress
    ADD CONSTRAINT user_flashcard_progress_flashcard_id_fkey FOREIGN KEY (flashcard_id) REFERENCES public.flashcards(id) ON DELETE CASCADE;


--
-- Name: user_flashcard_progress user_flashcard_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_flashcard_progress
    ADD CONSTRAINT user_flashcard_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_notifications user_notifications_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL;


--
-- Name: user_notifications user_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_referred_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict 8itYPvrfzeTUrDY0m6bSNQnp8LCswtjzXRflI8GgtbY4REGiBIVdLgNcE7j8dKH

