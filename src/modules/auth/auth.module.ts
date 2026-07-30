// ════════════════════════════════════════════════════════════
// AUTH MODULE — Full implementation
// ════════════════════════════════════════════════════════════
import * as WhatsAppUtil from '../../common/utils/whatsapp.util';
import {
  Module, Injectable, Controller, Post, Get, Query, Body, Req,
  HttpCode, HttpStatus, HttpException,
  UnauthorizedException, BadRequestException, ConflictException,
  Patch,
  Delete,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan } from 'typeorm';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as bcrypt from 'bcryptjs';
import {
  IsString, IsOptional, IsEmail, Length, Matches,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard, Public } from '../../common/guards';
import { UseGuards, Request } from '@nestjs/common';
import { successResponse } from '../../common/utils/response.util';
import { ActivityLogService, ACTIONS } from '../../common/activity/activity-log.service';

// ── DTOs ──────────────────────────────────────────────────────
class SendOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @IsString()
  @Matches(/^\+?91[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobile: string;
}

class VerifyOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @IsString()
  mobile: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be 6 digits' })
  otp: string;
}

class RegisterDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  tempToken: string;

  @ApiProperty({ example: 'Rahul Kumar' })
  @IsString()
  @Length(2, 100)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  district?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  referralCode?: string;
}

class ExamSelectionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  primaryExam: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  secondaryExam?: string;

  @ApiPropertyOptional({ enum: ['beginner','intermediate','advanced'] })
  @IsOptional()
  @IsString()
  prepLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  targetYear?: number;
}

class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

class FcmTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  fcmToken: string;
}

// ── OTP Service ───────────────────────────────────────────────
@Injectable()
export class OtpService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  async send(mobile: string): Promise<{ success: boolean }> {
    // Per-phone cooldown: 2-minute wait between OTP sends (check BEFORE deleting old OTPs)
    const [lastOtp] = await this.db.query(
      `SELECT created_at FROM otps WHERE mobile = $1 ORDER BY created_at DESC LIMIT 1`,
      [mobile]
    );
    if (lastOtp) {
      const ageSeconds = (Date.now() - new Date(lastOtp.created_at).getTime()) / 1000;
      if (ageSeconds < 120) {
        const retryAfterSeconds = Math.ceil(120 - ageSeconds);
        throw new HttpException(
          { message: 'Please wait before requesting another OTP.', retryAfterSeconds },
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
    }

    // Daily cap: max 5 OTPs per phone per day (count before deletion so we see all today's records)
    const [dailyRow] = await this.db.query(
      `SELECT COUNT(*)::int AS cnt FROM otps
       WHERE mobile = $1 AND created_at::date = CURRENT_DATE`,
      [mobile]
    );
    if (Number(dailyRow?.cnt) >= 5) {
      throw new BadRequestException({
        message: 'Daily OTP limit reached. Please try again tomorrow.',
        retryAfterSeconds: null,
      });
    }

    const otpConfig  = this.config.get('otp');
    const otp        = this.generateOtp();
    const expiryMins = otpConfig.expiryMinutes;

    // Invalidate all previous unused OTPs for this mobile
    await this.db.query(
      `DELETE FROM otps WHERE mobile = $1 AND is_used = FALSE`, [mobile]
    );

    // Store bcrypt-hashed OTP
    const hash = await bcrypt.hash(otp, 6);
    await this.db.query(
      `INSERT INTO otps (mobile, otp_hash, expires_at)
       VALUES ($1, $2, NOW() + $3::INTERVAL)`,
      [mobile, hash, `${expiryMins} minutes`]
    );

    // Development: log OTP to console, skip WhatsApp send
    if (this.config.get('app.env') === 'development') {
      console.log(`📲 DEV OTP for ${mobile}: ${otp}`);
      return { success: true };
    }

    // Production: deliver via WhatsApp Cloud API
    const cfg = WhatsAppUtil.buildWhatsAppConfig({
      phoneNumberId: otpConfig.whatsappPhoneNumberId,
      accessToken:   otpConfig.whatsappAccessToken,
      templateName:  otpConfig.whatsappTemplateName,
      templateLang:  otpConfig.whatsappTemplateLang,
    });

    if (!cfg.phoneNumberId || !cfg.accessToken) {
      // Gateway not configured — log and fail loudly in production
      console.error('WhatsApp OTP: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set');
      throw new Error('OTP delivery service is not configured. Contact support.');
    }

    const result = await WhatsAppUtil.sendWhatsAppRequest(cfg, mobile, otp);

    if (!result.success) {
      console.error(`WhatsApp OTP delivery failed for ${mobile}:`, result.error);
      throw new Error('Failed to send OTP via WhatsApp. Please try again.');
    }

    console.log(`📲 WhatsApp OTP sent to ${mobile} (msgId: ${result.messageId})`);
    return { success: true };
  }

  async verify(mobile: string, otp: string): Promise<void> {
    const otpConfig = this.config.get('otp');
    const result = await this.db.query(
      `SELECT id, otp_hash, expires_at, attempts FROM otps WHERE mobile = $1 AND is_used = FALSE ORDER BY created_at DESC LIMIT 1`,
      [mobile]
    );
    if (!result.length) throw new BadRequestException('OTP not found or already used');

    const record = result[0];
    if (new Date() > new Date(record.expires_at)) {
      await this.db.query(`DELETE FROM otps WHERE id = $1`, [record.id]);
      throw new BadRequestException('OTP has expired. Please request a new one.');
    }
    if (record.attempts >= otpConfig.maxAttempts) {
      await this.db.query(`DELETE FROM otps WHERE id = $1`, [record.id]);
      throw new BadRequestException('Too many wrong attempts. Please request a new OTP.');
    }

    const isValid = await bcrypt.compare(otp, record.otp_hash);
    if (!isValid) {
      await this.db.query(`UPDATE otps SET attempts = attempts + 1 WHERE id = $1`, [record.id]);
      const remaining = otpConfig.maxAttempts - (record.attempts + 1);
      throw new BadRequestException(`Incorrect OTP. ${remaining} attempt(s) remaining.`);
    }

    await this.db.query(`UPDATE otps SET is_used = TRUE WHERE id = $1`, [record.id]);
  }

  // Checks OTP validity WITHOUT consuming it (is_used stays FALSE).
  // Used by the forgot-mpin OTP screen so the OTP remains available
  // for the subsequent /auth/reset-mpin call which does the real consume.
  async validateWithoutConsuming(mobile: string, otp: string): Promise<void> {
    const otpConfig = this.config.get('otp');
    const result = await this.db.query(
      `SELECT id, otp_hash, expires_at, attempts FROM otps WHERE mobile = $1 AND is_used = FALSE ORDER BY created_at DESC LIMIT 1`,
      [mobile]
    );
    if (!result.length) throw new BadRequestException('OTP not found or already used');

    const record = result[0];
    if (new Date() > new Date(record.expires_at)) {
      await this.db.query(`DELETE FROM otps WHERE id = $1`, [record.id]);
      throw new BadRequestException('OTP has expired. Please request a new one.');
    }
    if (record.attempts >= otpConfig.maxAttempts) {
      await this.db.query(`DELETE FROM otps WHERE id = $1`, [record.id]);
      throw new BadRequestException('Too many wrong attempts. Please request a new OTP.');
    }

    const isValid = await bcrypt.compare(otp, record.otp_hash);
    if (!isValid) {
      await this.db.query(`UPDATE otps SET attempts = attempts + 1 WHERE id = $1`, [record.id]);
      const remaining = otpConfig.maxAttempts - (record.attempts + 1);
      throw new BadRequestException(`Incorrect OTP. ${remaining} attempt(s) remaining.`);
    }
    // Intentionally NOT marking is_used = TRUE here
  }

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}

// ── Auth Service ──────────────────────────────────────────────
@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly otpService: OtpService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly activityLog: ActivityLogService,
  ) {
  }
  private generateAdminToken(admin: any) {
    return this.jwtService.sign(
      { adminId: admin.id },
      {
        secret: this.config.get('jwt.adminSecret'),
        expiresIn: '1d',
      }
    )
  }

  async sendOtp(mobile: string) {
    const result = await this.db.query(
      `SELECT id, name FROM users WHERE mobile = $1 AND deleted_at IS NULL`, [mobile]
    );
    const isNewUser = !result.length;
    await this.otpService.send(mobile);
    return { isNewUser };
  }

  async verifyOtp(mobile: string, otp: string) {
    await this.otpService.verify(mobile, otp);

    const result = await this.db.query(
      `SELECT id, name, email, mobile, role, status, coins, streak, primary_exam,
              prep_level, referral_code, is_verified, mpin_hash
       FROM users WHERE mobile = $1 AND deleted_at IS NULL`, [mobile]
    );

    if (!result.length) {
      // New user — issue a short-lived registration token
      const tempToken = this.jwtService.sign(
        { mobile, verified: true, type: 'registration' },
        { secret: this.config.get('jwt.secret'), expiresIn: '30m' }
      );
      return { isNewUser: true, tempToken };
    }

    const user = result[0];
    if (user.status === 'banned') {
      throw new UnauthorizedException('Your account has been suspended. Contact support.');
    }

    const tokens = await this.generateTokens(user.id);
    await this.db.query(
      `UPDATE users SET refresh_token = $1, mobile_verified = TRUE, last_active_at = NOW() WHERE id = $2`,
      [tokens.refreshToken, user.id]
    );
    await this.awardCoins(user.id, 'daily_login');
    await this.activityLog.log(user.id, ACTIONS.USER_LOGIN_OTP, 'Login via OTP', { mobile });

    return {
      isNewUser: false,
      hasMpin:   !!user.mpin_hash,   // tells Android whether to show CreateMpin after this
      ...tokens,
      user: this.sanitizeUser(user),
    };
  }

  async register(dto: RegisterDto) {
    // Admin "New Registrations" switch. The app disables the signup button too,
    // but that is only a courtesy — the switch has to be enforced here or an
    // older build (or anything hitting the API directly) walks straight past it.
    const [flag] = await this.db.query(
      `SELECT value FROM app_settings WHERE key = 'new_registrations'`,
    );
    if (flag && flag.value === 'false') {
      throw new BadRequestException('New registrations are temporarily closed. Please try again later.');
    }

    let decoded: any;
    try {
      decoded = this.jwtService.verify(dto.tempToken, {
        secret: this.config.get('jwt.secret')
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired verification token');
    }
    if (decoded.type !== 'registration' || !decoded.verified) {
      throw new UnauthorizedException('Invalid registration token');
    }

    const mobile = decoded.mobile;
    const existing = await this.db.query(`SELECT id FROM users WHERE mobile = $1`, [mobile]);
    if (existing.length) throw new ConflictException('Mobile already registered. Please login.');

    const refCode = this.generateReferralCode(dto.name);
    let referrerId = null;

    if (dto.referralCode) {
      const ref = await this.db.query(`SELECT id FROM users WHERE referral_code = $1`, [dto.referralCode]);
      if (ref.length) referrerId = ref[0].id;
    }

    const newUser = await this.db.transaction(async (em) => {
      const result = await em.query(
        `INSERT INTO users (name, email, mobile, mobile_verified, district, referral_code, referred_by, onboarding_completed)
         VALUES ($1,$2,$3,TRUE,$4,$5,$6,FALSE) RETURNING *`,
        [dto.name, dto.email || null, mobile, dto.district || null, refCode, referrerId]
      );
      return result[0];
    });

    const tokens = await this.generateTokens(newUser.id);
    await this.db.query(`UPDATE users SET refresh_token = $1 WHERE id = $2`, [tokens.refreshToken, newUser.id]);

    await this.awardCoins(newUser.id, 'daily_login');

    if (referrerId) {
      // ── Ensure referral_milestones table exists (migration-safe) ──
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS referral_milestones (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          referee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          milestone   VARCHAR(30) NOT NULL,   -- 'signup' | 'engagement' | 'active'
          coins       INT NOT NULL DEFAULT 0,
          awarded_at  TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (referrer_id, referee_id, milestone)
        )
      `).catch(() => {});

      // Milestone 1 — signup: award the referrer via the shared
      // awardCoins helper (action='referral_signup', admin-editable on
      // the Coins page, daily cap enforced). referral_milestones still
      // records the per-referee breakdown shown in the wallet's
      // referral tab.
      const existing = await this.db.query(
        `SELECT id FROM referral_milestones
         WHERE referrer_id=$1 AND referee_id=$2 AND milestone='signup'`,
        [referrerId, newUser.id]
      );
      if (!existing.length) {
        const signupCoins = await this.awardCoins(referrerId, 'referral_signup', newUser.id);
        if (signupCoins > 0) {
          await this.db.query(
            `INSERT INTO referral_milestones (referrer_id, referee_id, milestone, coins)
             VALUES ($1,$2,'signup',$3)`,
            [referrerId, newUser.id, signupCoins]
          );
        }
      }

      // Welcome bonus to the new user for signing up via referral
      // (action='referral_joined', admin-editable on the Coins page).
      await this.awardCoins(newUser.id, 'referral_joined');

      // Logged against the referrer — they're the one whose code was used,
      // and the referee already gets a user_registered row just below.
      await this.activityLog.log(
        referrerId, ACTIONS.REFERRAL_USED,
        `Their referral code was used by ${dto.name}`,
        { refereeId: newUser.id, referralCode: dto.referralCode || null },
      );
    }

    await this.activityLog.log(newUser.id, ACTIONS.USER_REGISTERED, `New user registered: ${dto.name}`, { mobile, referralCode: dto.referralCode || null });

    return {
      ...tokens,
      user: {
        id: newUser.id, name: newUser.name, email: newUser.email,
        mobile: newUser.mobile, referralCode: newUser.referral_code,
        isNewUser: true, needsExamSelection: true,
      },
    };
  }

   // ── PATCH /users/profile ─────────────────────────────────────
  // Updates name, email, bio, district, state, target_year, prep_level.
  // Clears user cache so next getMe() returns fresh data.
  async updateProfile(userId: string, dto: {
    name?: string; email?: string; bio?: string;
    district?: string; state?: string; target_year?: number; prep_level?: string;
    onboarding_completed?: boolean; daily_goal_mins?: number;
  }) {
    const sets: string[] = [];
    const vals: any[]    = [];
    let i = 1;

    if (dto.name?.trim())      { sets.push(`name=$${i++}`);        vals.push(dto.name.trim()); }
    if (dto.email !== undefined){ sets.push(`email=$${i++}`);       vals.push(dto.email?.trim() || null); }
    if (dto.bio   !== undefined){ sets.push(`bio=$${i++}`);         vals.push(dto.bio?.trim()   || null); }
    if (dto.district !== undefined){ sets.push(`district=$${i++}`); vals.push(dto.district?.trim() || null); }
    if (dto.state !== undefined){ sets.push(`state=$${i++}`);       vals.push(dto.state?.trim()   || null); }
    if (dto.target_year)        { sets.push(`target_year=$${i++}`); vals.push(dto.target_year); }
    if (dto.prep_level)         { sets.push(`prep_level=$${i++}`);  vals.push(dto.prep_level); }
    if (dto.onboarding_completed !== undefined) { sets.push(`onboarding_completed=$${i++}`); vals.push(dto.onboarding_completed); }
    if (dto.daily_goal_mins != null) { sets.push(`daily_goal_mins=$${i++}`); vals.push(dto.daily_goal_mins); }

    if (!sets.length) throw new BadRequestException('No fields to update');

    sets.push(`updated_at=NOW()`);
    vals.push(userId);

    await this.db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id=$${i} AND deleted_at IS NULL`,
      vals
    );

    // Invalidate user cache so next /auth/me returns updated data
    await this.cache.del(`user:${userId}`);
    await this.cache.del(`profile:${userId}`);
    // Log only which fields changed, not raw values (bio can be huge / contain sensitive text)
    const changedFields = Object.keys(dto).filter(k => dto[k as keyof typeof dto] !== undefined);
    await this.activityLog.log(userId, ACTIONS.USER_PROFILE_UPDATED, 'Profile updated', { fields: changedFields });

    // One-time "complete your profile" bonus (action='profile_complete',
    // admin-editable on the Coins page). Checked via coin_transactions
    // (not coin_rules.max_per_day) so it fires exactly once per user,
    // however many times they edit their profile afterwards.
    const [freshUser] = await this.db.query(
      `SELECT name, email, district, state, target_year, prep_level FROM users WHERE id=$1`,
      [userId]
    );
    const profileIsComplete = !!(freshUser?.name && freshUser?.email && freshUser?.district
      && freshUser?.state && freshUser?.target_year && freshUser?.prep_level);
    if (profileIsComplete) {
      const [already] = await this.db.query(
        `SELECT 1 FROM coin_transactions WHERE user_id=$1 AND action='profile_complete' LIMIT 1`,
        [userId]
      );
      if (!already) await this.awardCoins(userId, 'profile_complete');
    }

    // Return fresh user data
    const user = await this.getMe(userId);
    return successResponse({ user }, 'Profile updated successfully');
  }

  // ── DELETE /users/account ─────────────────────────────────────
  // Soft-delete: sets deleted_at so user cannot log in again.
  // Hard-deletes happen via a scheduled job after 30 days.
  async deleteAccount(userId: string) {
    await this.db.query(
      `UPDATE users SET deleted_at=NOW(), status='deleted', refresh_token=NULL WHERE id=$1`,
      [userId]
    );
    await this.cache.del(`user:${userId}`);
    return successResponse(null, 'Account deleted successfully');
  }


  async examSelection(userId: string, dto: ExamSelectionDto) {
    await this.db.query(
      `UPDATE users SET primary_exam=$1, secondary_exam=$2, prep_level=$3, target_year=$4, updated_at=NOW() WHERE id=$5`,
      [dto.primaryExam, dto.secondaryExam || null, dto.prepLevel || 'beginner', dto.targetYear || null, userId]
    );
    // Invalidate user cache
    await this.cache.del(`user:${userId}`);
  }

  async refreshToken(refreshToken: string) {
    let decoded: any;
    try {
      decoded = this.jwtService.verify(refreshToken, {
        secret: this.config.get('jwt.refreshSecret')
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const result = await this.db.query(
      `SELECT id, status, refresh_token FROM users WHERE id = $1`, [decoded.userId]
    );
    if (!result.length || result[0].refresh_token !== refreshToken) {
      throw new UnauthorizedException('Refresh token not recognized');
    }
    if (result[0].status === 'banned') throw new UnauthorizedException('Account suspended');

    const tokens = await this.generateTokens(decoded.userId);
    await this.db.query(`UPDATE users SET refresh_token = $1 WHERE id = $2`, [tokens.refreshToken, decoded.userId]);
    return tokens;
  }

  async logout(userId: string) {
    await this.db.query(`UPDATE users SET refresh_token = NULL, fcm_token = NULL WHERE id = $1`, [userId]);
    await this.cache.del(`user:${userId}`);
    await this.activityLog.log(userId, ACTIONS.USER_LOGOUT, 'User logged out');
  }

  async updateFcmToken(userId: string, fcmToken: string) {
    await this.db.query(`UPDATE users SET fcm_token = $1 WHERE id = $2`, [fcmToken, userId]);
  }

  async getMe(userId: string) {
    const cacheKey = `user:${userId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.db.query(
      `SELECT u.*,
         (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' AND s.ends_at > NOW()) > 0 AS is_subscribed,
         (SELECT plan FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' AND s.ends_at > NOW() LIMIT 1) AS current_plan,
         -- FIX: compute live rank so it's never null
         -- Uses ROW_NUMBER over active users sorted by coins+accuracy+streak
         (SELECT row_num FROM (
           SELECT id,
             ROW_NUMBER() OVER (
               ORDER BY coins DESC, CAST(accuracy AS FLOAT) DESC, streak DESC
             ) AS row_num
           FROM users
           WHERE status='active' AND deleted_at IS NULL
         ) ranked WHERE ranked.id = u.id) AS live_rank
       FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId]
    );
    if (!result.length) throw new UnauthorizedException('User not found');

    const user = result[0];
    delete user.password_hash;
    delete user.refresh_token;
    delete user.fcm_token;

    // Map live_rank → rank so Android always has a non-null rank
    if (user.live_rank != null && (user.rank == null || user.rank === 0)) {
      user.rank = parseInt(user.live_rank, 10);
    }
    delete user.live_rank;

    await this.cache.set(cacheKey, user, 60); // 60 sec TTL
    return user;
  }

  // ── Helpers ──────────────────────────────────────────────────
  private async generateTokens(userId: string) {
    const jwtConfig = this.config.get('jwt');
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { userId },
        { secret: jwtConfig.secret, expiresIn: jwtConfig.expiresIn }
      ),
      this.jwtService.signAsync(
        { userId, type: 'refresh' },
        { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn }
      ),
    ]);
    return { accessToken, refreshToken };
  }

  // ── COMPREHENSIVE COIN RULES (used when DB coin_rules table has no row) ──────
  // This covers EVERY action used across all modules so coins never silently return 0.
  // DB rows override these defaults (admin can tune via admin panel).
  private static readonly COIN_DEFAULTS: Record<string, { coins: number; maxPerDay: number }> = {
    // Quiz actions — each type has its own daily limit
    daily_quiz:         { coins: 10,  maxPerDay: 1  },  // 1 daily quiz per day
    mock_quiz:          { coins: 10,  maxPerDay: 3  },  // up to 3 mock tests per day
    topic_quiz:         { coins: 15,  maxPerDay: 5  },  // up to 5 topic quizzes per day
    quiz_attempt:       { coins: 10,  maxPerDay: 5  },  // legacy fallback
    // Study actions
    study_session:      { coins: 15,  maxPerDay: 1 },
    study_room:         { coins: 5,   maxPerDay: 2 },
    active_recall:      { coins: 5,   maxPerDay: 3 },
    // Content creation
    material_upload:    { coins: 25,  maxPerDay: 1 },
    // Auth / engagement
    daily_login:        { coins: 5,   maxPerDay: 1 },
    referral:           { coins: 75,  maxPerDay: 5 },
    profile_complete:   { coins: 20,  maxPerDay: 1 },
    // Ads
    ad_watch:           { coins: 5,   maxPerDay: 3 },
    watch_ad:           { coins: 5,   maxPerDay: 3 },  // alias
    // Achievements & leaderboard
    achievement:        { coins: 10,  maxPerDay: 10 },
    leaderboard_reward: { coins: 50,  maxPerDay: 1 },
    tier_promotion:     { coins: 20,  maxPerDay: 1 },
    weekly_challenge:   { coins: 30,  maxPerDay: 1 },
    // Streaks
    streak_7:           { coins: 15,  maxPerDay: 1 },
    streak_30:          { coins: 100, maxPerDay: 1 },
    mock_top10:         { coins: 100, maxPerDay: 1 },
    // Daily targets
    target_complete:    { coins: 1,   maxPerDay: 20 },
    // Subscriptions
    subscription_bonus: { coins: 0,   maxPerDay: 1 },
  };

  // ─────────────────────────────────────────────────────────────
  // awardReferralMilestone — called from any module when a
  // milestone-triggering action happens (enrollment, upload, quiz)
  // Safe to call multiple times — UNIQUE constraint prevents double-award
  // ─────────────────────────────────────────────────────────────
  async awardReferralMilestone(refereeId: string, milestone: 'engagement' | 'active') {
    try {
      if (!(await this.isCoinSystemEnabled())) return;

      // Find who referred this user
      const rows = await this.db.query(
        `SELECT referred_by FROM users WHERE id=$1`, [refereeId]
      );
      if (!rows.length || !rows[0].referred_by) return;
      const referrerId = rows[0].referred_by;

      // Coin amount is admin-controlled via the Coins page
      // (action='referral_engagement' / 'referral_active'), falling
      // back to 50 if that rule is missing or deactivated.
      const action = `referral_${milestone}`;
      const [rule] = await this.db.query(
        `SELECT coins_awarded FROM coin_rules WHERE action=$1 AND is_active=TRUE`, [action]
      );
      const coins = Number(rule?.coins_awarded ?? 50);
      if (coins <= 0) return;

      // Check if already awarded (UNIQUE constraint prevents duplicates but check first for clarity)
      const existing = await this.db.query(
        `SELECT id FROM referral_milestones
         WHERE referrer_id=$1 AND referee_id=$2 AND milestone=$3`,
        [referrerId, refereeId, milestone]
      );
      if (existing.length) return;  // already awarded

      await this.db.query(
        `INSERT INTO referral_milestones (referrer_id, referee_id, milestone, coins)
         VALUES ($1,$2,$3,$4)`,
        [referrerId, refereeId, milestone, coins]
      );
      await this.db.query(
        `UPDATE users SET coins = COALESCE(coins,0) + $1, total_coins_earned = COALESCE(total_coins_earned,0) + $1
         WHERE id = $2`,
        [coins, referrerId]
      );
      const balRow = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [referrerId]))[0];
      const bal = Number(balRow?.coins) || 0;
      const descriptions: Record<string, string> = {
        engagement: 'Friend enrolled in course / uploaded notes (2/3)',
        active:     'Friend completed 5 quizzes — fully active! (3/3)',
      };
      await this.db.query(
        `INSERT INTO coin_transactions (user_id, type, amount, description, action, ref_id, balance)
         VALUES ($1,'earned',$2,$3,$4,$5,$6)`,
        [referrerId, coins, descriptions[milestone], `referral_${milestone}`, refereeId, bal]
      );
      await this.cache.del(`user:${referrerId}`);
    } catch (err: any) {
      console.error('awardReferralMilestone error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // getReferralStats — returns referral list with milestone progress
  // Used by Android wallet screen referral tab
  // ─────────────────────────────────────────────────────────────
  async getReferralStats(userId: string) {
    // Ensure table exists
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS referral_milestones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        milestone   VARCHAR(30) NOT NULL,
        coins       INT NOT NULL DEFAULT 0,
        awarded_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (referrer_id, referee_id, milestone)
      )
    `).catch(() => {});

    // All users referred by this user, with their milestone status
    const referees = await this.db.query(`
      SELECT
        u.id,
        u.name,
        u.created_at              AS joined_at,
        COALESCE(rm_signup.coins,     0)  AS coins_signup,
        COALESCE(rm_engage.coins,     0)  AS coins_engagement,
        COALESCE(rm_active.coins,     0)  AS coins_active,
        rm_signup.awarded_at              AS signup_at,
        rm_engage.awarded_at              AS engagement_at,
        rm_active.awarded_at              AS active_at
      FROM users u
      LEFT JOIN referral_milestones rm_signup
             ON rm_signup.referee_id  = u.id
            AND rm_signup.referrer_id = $1
            AND rm_signup.milestone   = 'signup'
      LEFT JOIN referral_milestones rm_engage
             ON rm_engage.referee_id  = u.id
            AND rm_engage.referrer_id = $1
            AND rm_engage.milestone   = 'engagement'
      LEFT JOIN referral_milestones rm_active
             ON rm_active.referee_id  = u.id
            AND rm_active.referrer_id = $1
            AND rm_active.milestone   = 'active'
      WHERE u.referred_by = $1
      ORDER BY u.created_at DESC
    `, [userId]);

    const totalEarned = referees.reduce((s: number, r: any) =>
      s + Number(r.coins_signup) + Number(r.coins_engagement) + Number(r.coins_active), 0);

    const user = await this.db.query(`SELECT referral_code FROM users WHERE id=$1`, [userId]);

    return {
      referralCode:  user[0]?.referral_code ?? '',
      totalReferrals: referees.length,
      totalEarned,
      referees: referees.map((r: any) => ({
        id:            r.id,
        name:          r.name,
        joinedAt:      r.joined_at,
        milestones: {
          signup:     { earned: Number(r.coins_signup)     > 0, coins: Number(r.coins_signup),     awardedAt: r.signup_at },
          engagement: { earned: Number(r.coins_engagement) > 0, coins: Number(r.coins_engagement), awardedAt: r.engagement_at },
          active:     { earned: Number(r.coins_active)     > 0, coins: Number(r.coins_active),     awardedAt: r.active_at },
        },
        totalCoinsEarned: Number(r.coins_signup) + Number(r.coins_engagement) + Number(r.coins_active),
      })),
    };
  }

  async getLearningProgress(userId: string) {
    const [inProgress, recentAttempts] = await Promise.all([
      this.db.query(
        `SELECT
           qs.id         AS session_id,
           qs.quiz_id,
           q.title       AS quiz_title,
           q.type        AS quiz_type,
           q.subject     AS quiz_subject,
           q.total_questions,
           qs.started_at,
           (SELECT count(*) FROM jsonb_each(qs.answers_so_far))::int AS answers_so_far_count
         FROM quiz_sessions qs
         JOIN quizzes q ON q.id = qs.quiz_id
         WHERE qs.user_id = $1
           AND qs.status  = 'in_progress'
         ORDER BY qs.started_at DESC
         LIMIT 1`,
        [userId]
      ),
      this.db.query(
        `SELECT
           qa.quiz_id,
           q.title  AS quiz_title,
           q.type   AS quiz_type,
           q.subject,
           qa.score,
           qa.correct_answers,
           qa.total_questions,
           qa.submitted_at
         FROM quiz_attempts qa
         JOIN quizzes q ON q.id = qa.quiz_id
         WHERE qa.user_id = $1
           AND qa.total_questions > 0
         ORDER BY qa.submitted_at DESC
         LIMIT 5`,
        [userId]
      ),
    ]);

    return {
      inProgressSession: inProgress[0] ?? null,
      recentAttempts,
    };
  }

  // Shared master switch — admin can disable the entire coin economy
  // from the Coins page (Economy settings). Cached 60s so this very
  // hot path (called on every quiz/session/award) stays cheap. Shares
  // the 'coin:system_enabled' cache key with SubscriptionsService.
  private async isCoinSystemEnabled(): Promise<boolean> {
    let v = await this.cache.get<string>('coin:system_enabled');
    if (v === undefined || v === null) {
      const [row] = await this.db.query(
        `SELECT value FROM app_settings WHERE key='coin_system_enabled'`
      ).catch(() => []);
      v = row?.value ?? 'true';
      await this.cache.set('coin:system_enabled', v, 60);
    }
    return v !== 'false';
  }

  async awardCoins(userId: string, action: string, refId?: string, coinsOverride?: number): Promise<number> {
    try {
      if (!(await this.isCoinSystemEnabled())) return 0;

      const dbRules = await this.db.query(
        `SELECT coins_awarded, max_per_day FROM coin_rules WHERE action = $1 AND is_active = TRUE`,
        [action]
      );

      const defaults    = AuthService.COIN_DEFAULTS[action];
      const dbCoins     = dbRules.length > 0 ? Number(dbRules[0].coins_awarded) : NaN;
      const dbMaxPerDay = dbRules.length > 0 ? Number(dbRules[0].max_per_day)   : NaN;

      const coinsToAward =
        (coinsOverride !== undefined && coinsOverride > 0) ? coinsOverride
        : (!isNaN(dbCoins) && dbCoins >= 0)               ? dbCoins
        : (defaults?.coins ?? -1);

      const maxPerDay = (!isNaN(dbMaxPerDay) && dbMaxPerDay > 0)
        ? dbMaxPerDay
        : (defaults?.maxPerDay ?? 1);

      if (coinsToAward <= 0 || isNaN(coinsToAward)) {
        console.warn(`awardCoins: no valid coins for action '${action}'`);
        return 0;
      }

      // Reject non-UUID strings before they reach Postgres (avoids "invalid UUID" error)
      const safeRefId = refId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refId)
        ? refId : null;

      // Idempotency key prevents double-award for the same logical event:
      // - per-reference: quiz completion, referral (unique refId per event)
      // - per-day: once-per-day actions (daily_login, profile_complete)
      // - null: multi-per-day actions (ad_watch) — count-based cap handles these
      const today = new Date().toISOString().slice(0, 10);
      const idempotencyKey: string | null =
        safeRefId       ? `${action}:${safeRefId}` :
        maxPerDay === 1 ? `${action}:${today}` :
        null;

      const awarded = await this.db.transaction(async (em) => {
        // Lock the user row for the duration of this transaction.
        // Concurrent awardCoins() calls for the same user serialize here —
        // the second call sees the first call's committed idempotency record.
        const [user] = await em.query(
          `SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]
        );
        if (!user) return 0;

        // Idempotency check — inside the lock so concurrent requests can't
        // both pass the check before either commits
        if (idempotencyKey) {
          const [exists] = await em.query(
            `SELECT 1 FROM coin_transactions
             WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
            [userId, idempotencyKey]
          );
          if (exists) return 0;
        }

        // Daily cap check (safe under row lock)
        const [countRow] = await em.query(
          `SELECT COUNT(*)::int AS cnt FROM coin_transactions
           WHERE user_id = $1 AND action = $2 AND created_at::date = CURRENT_DATE`,
          [userId, action]
        );
        // Per-quiz awards use a unique refId as idempotency key — skip the
        // daily cap so a user can earn coins on multiple different quizzes in one day.
        // The idempotency key already ensures each quiz is only rewarded once.
        if (!safeRefId && Number(countRow.cnt) >= maxPerDay) return 0;

        // UPDATE via raw query() returns [rows, affectedCount] — unwrap the
        // rows first. The old code read .coins off the outer array, so every
        // coin transaction recorded balance 0.
        const [updatedRows] = await em.query(
          `UPDATE users
             SET coins              = COALESCE(coins, 0) + $1,
                 total_coins_earned = COALESCE(total_coins_earned, 0) + $1
           WHERE id = $2 RETURNING coins`,
          [coinsToAward, userId]
        );
        if (!updatedRows.length) return 0;
        const newBalance = Number(updatedRows[0].coins) || 0;

        // ON CONFLICT DO NOTHING is a secondary safety net only — the idempotency
        // check above already prevents duplicates under normal operation
        await em.query(
          `INSERT INTO coin_transactions
             (user_id, type, amount, description, action, ref_id, balance, idempotency_key)
           VALUES ($1, 'earned', $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, idempotency_key)
             WHERE idempotency_key IS NOT NULL
           DO NOTHING`,
          [userId, coinsToAward, `${action} reward`, action, safeRefId, newBalance, idempotencyKey]
        );

        await this.cache.del(`user:${userId}`);
        return coinsToAward;
      });

      // Outside the transaction on purpose — the user row is locked inside it,
      // and an audit insert must not extend that lock. A non-zero return means
      // coins genuinely moved (idempotency key and daily cap both return 0),
      // so this can't double-log a replayed event.
      if (awarded > 0) {
        await this.activityLog.log(
          userId, ACTIONS.COINS_AWARDED, `Earned ${awarded} coins — ${action.replace(/_/g, ' ')}`,
          { action, coins: awarded, refId: refId ?? null },
        );
      }

      return awarded;

    } catch (err: any) {
      console.error('awardCoins error:', err.message);
      return 0;
    }
  }



  // ════════════════════════════════════════════════════════
  // MPIN METHODS
  // ════════════════════════════════════════════════════════

  private validateMpinStrength(mpin: string): void {
    if (!/^\d{4}$/.test(mpin))
      throw new BadRequestException('MPIN must be exactly 4 digits');
    if (/^(\d)\1{3}$/.test(mpin))
      throw new BadRequestException('MPIN cannot be all the same digit (e.g. 1111)');
    if (['1234','2345','3456','4567','5678','6789','9876','8765','7654','6543','5432','4321'].includes(mpin))
      throw new BadRequestException('MPIN is too simple. Please choose a less predictable one');
  }

  // ── GET /auth/check-mpin ─────────────────────────────
  async checkMpin(mobile: string) {
    const [user] = await this.db.query(
      `SELECT mpin_hash, mpin_locked_until, mpin_failed_attempts
       FROM users WHERE mobile=$1 AND deleted_at IS NULL`,
      [mobile]
    );
    if (!user) {
      // Return hasMpin:false for unknown mobiles — don't reveal existence
      return { hasMpin: false, isLocked: false, lockedUntilSeconds: 0 };
    }
    const hasMpin = !!user.mpin_hash;
    const lockedUntil: Date | null = user.mpin_locked_until ? new Date(user.mpin_locked_until) : null;
    const isLocked = lockedUntil !== null && lockedUntil > new Date();
    const lockedUntilSeconds = isLocked
      ? Math.ceil((lockedUntil!.getTime() - Date.now()) / 1000)
      : 0;
    return { hasMpin, isLocked, lockedUntilSeconds };
  }

  // ── POST /auth/login-mpin ────────────────────────────
  async loginMpin(mobile: string, mpin: string) {
    const [user] = await this.db.query(
      `SELECT id, name, email, mobile, role, status, coins, streak, primary_exam,
              prep_level, referral_code, is_verified, mpin_hash,
              mpin_failed_attempts, mpin_locked_until
       FROM users WHERE mobile=$1 AND deleted_at IS NULL`,
      [mobile]
    );
    if (!user) throw new UnauthorizedException('Mobile number not registered');
    if (user.status === 'banned') throw new UnauthorizedException('Account suspended. Contact support.');
    if (!user.mpin_hash) throw new UnauthorizedException('No MPIN set. Please login with OTP first.');

    // Check lockout
    if (user.mpin_locked_until && new Date(user.mpin_locked_until) > new Date()) {
      const secsLeft = Math.ceil((new Date(user.mpin_locked_until).getTime() - Date.now()) / 1000);
      const minsLeft = Math.ceil(secsLeft / 60);
      throw new UnauthorizedException(
        `Too many failed attempts. Try again in ${minsLeft} minute${minsLeft > 1 ? 's' : ''}.`
      );
    }

    // Verify MPIN
    const isValid = await bcrypt.compare(mpin, user.mpin_hash);
    if (!isValid) {
      const newAttempts = (user.mpin_failed_attempts || 0) + 1;
      const MAX = 5;
      if (newAttempts >= MAX) {
        // Lock for 5 minutes
        await this.db.query(
          `UPDATE users SET mpin_failed_attempts=$1, mpin_locked_until=NOW()+INTERVAL '5 minutes'
           WHERE id=$2`,
          [newAttempts, user.id]
        );
        throw new UnauthorizedException(
          'Too many failed attempts. MPIN locked for 5 minutes.'
        );
      }
      await this.db.query(
        `UPDATE users SET mpin_failed_attempts=$1 WHERE id=$2`,
        [newAttempts, user.id]
      );
      const remaining = MAX - newAttempts;
      throw new UnauthorizedException(
        `Incorrect MPIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
      );
    }

    // Success — reset lockout counters
    const tokens = await this.generateTokens(user.id);
    await this.db.query(
      `UPDATE users SET
         refresh_token=$1, mobile_verified=TRUE, last_active_at=NOW(),
         mpin_failed_attempts=0, mpin_locked_until=NULL
       WHERE id=$2`,
      [tokens.refreshToken, user.id]
    );
    await this.awardCoins(user.id, 'daily_login');
    await this.activityLog.log(user.id, ACTIONS.USER_LOGIN_MPIN, 'Login via MPIN', { mobile });
    await this.cache.del(`user:${user.id}`);

    return {
      isNewUser:    false,
      hasMpin:      true,
      ...tokens,
      user: this.sanitizeUser(user),
    };
  }

  // ── POST /auth/create-mpin (JWT required) ────────────
  async createMpin(userId: string, mpin: string) {
    this.validateMpinStrength(mpin);
    const hash = await bcrypt.hash(mpin, 12);
    await this.db.query(
      `UPDATE users SET mpin_hash=$1, mpin_created_at=NOW(),
       mpin_failed_attempts=0, mpin_locked_until=NULL
       WHERE id=$2`,
      [hash, userId]
    );
    await this.cache.del(`user:${userId}`);
    await this.activityLog.log(userId, ACTIONS.USER_MPIN_CREATED, 'MPIN created');
    return { mpinCreated: true };
  }

  // ── POST /auth/validate-otp (public — check without consuming) ──
  async validateForgotMpinOtp(mobile: string, otp: string) {
    await this.otpService.validateWithoutConsuming(mobile, otp);
    return { valid: true };
  }

  // ── POST /auth/forgot-mpin (public — sends OTP) ──────
  async forgotMpin(mobile: string) {
    const [user] = await this.db.query(
      `SELECT id, mpin_hash FROM users WHERE mobile=$1 AND deleted_at IS NULL`,
      [mobile]
    );
    // Don't reveal if mobile exists — always return success
    if (!user || !user.mpin_hash) {
      // User doesn't exist or has no MPIN — send OTP anyway (security: don't leak info)
      // If no user, OTP just gets thrown away. Android handles navigation same way.
    }
    await this.otpService.send(mobile);
    return { otpSent: true };
  }

  // ── POST /auth/reset-mpin (public — OTP in body) ─────
  async resetMpin(mobile: string, otp: string, newMpin: string) {
    this.validateMpinStrength(newMpin);
    // Verify OTP — throws if invalid/expired
    await this.otpService.verify(mobile, otp);

    const [user] = await this.db.query(
      `SELECT id, status FROM users WHERE mobile=$1 AND deleted_at IS NULL`,
      [mobile]
    );
    if (!user) throw new UnauthorizedException('Mobile number not registered');
    if (user.status === 'banned') throw new UnauthorizedException('Account suspended.');

    const hash = await bcrypt.hash(newMpin, 12);
    await this.db.query(
      `UPDATE users SET mpin_hash=$1, mpin_created_at=NOW(),
       mpin_failed_attempts=0, mpin_locked_until=NULL
       WHERE id=$2`,
      [hash, user.id]
    );

    // Log user in automatically after reset
    const tokens = await this.generateTokens(user.id);
    await this.db.query(
      `UPDATE users SET refresh_token=$1, last_active_at=NOW() WHERE id=$2`,
      [tokens.refreshToken, user.id]
    );
    await this.cache.del(`user:${user.id}`);

    return { isNewUser: false, hasMpin: true, ...tokens };
  }

  // ── POST /auth/change-mpin (JWT required) ────────────
  async changeMpin(userId: string, currentMpin: string, newMpin: string) {
    this.validateMpinStrength(newMpin);

    const [user] = await this.db.query(
      `SELECT mpin_hash FROM users WHERE id=$1`,
      [userId]
    );
    if (!user?.mpin_hash) throw new BadRequestException('No MPIN set. Please create one first.');

    const isValid = await bcrypt.compare(currentMpin, user.mpin_hash);
    if (!isValid) throw new UnauthorizedException('Current MPIN is incorrect.');

    const isSame = await bcrypt.compare(newMpin, user.mpin_hash);
    if (isSame) throw new BadRequestException('New MPIN must be different from current MPIN.');

    const hash = await bcrypt.hash(newMpin, 12);
    await this.db.query(
      `UPDATE users SET mpin_hash=$1, mpin_created_at=NOW() WHERE id=$2`,
      [hash, userId]
    );
    await this.cache.del(`user:${userId}`);
    return { mpinUpdated: true };
  }

  private sanitizeUser(user: any) {
    const { password_hash, refresh_token, fcm_token, ...safe } = user;
    return safe;
  }

  private generateReferralCode(name: string): string {
    const base = name.replace(/\s+/g, '').toUpperCase().slice(0, 6);
    const num  = Math.floor(1000 + Math.random() * 9000);
    return `${base}${num}`;
  }
}

// ── JWT Strategy ──────────────────────────────────────────────
@Injectable()
export class UserJwtStrategy extends PassportStrategy(Strategy as any, 'jwt') {
  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly db: DataSource,
  ) {
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      config.get('jwt.secret'),
    });
  }

  async validate(payload: any) {
    const result = await this.db.query(
      `SELECT id, name, email, mobile, role, status, coins, primary_exam, prep_level, is_verified, notification_enabled
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [payload.userId]
    );
    if (!result.length) throw new UnauthorizedException();
    const user = result[0];
    if (user.status === 'banned') throw new UnauthorizedException('Account suspended');

    // Update last_active async (fire-and-forget)
    this.db.query(`UPDATE users SET last_active_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});

    return user;
    // return user;
  }
}

// ── Admin JWT Strategy ────────────────────────────────────────
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy as any, 'admin-jwt') {
  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly db: DataSource,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        // Cookie first (httpOnly — set by POST /admin/login)
        (req: any) => req?.cookies?.adminToken ?? null,
        // Authorization header fallback (Swagger, Postman, legacy clients)
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey:      config.get('jwt.adminSecret'),
    });
  }

  async validate(payload: any) {
    const result = await this.db.query(
      `SELECT id, name, email, permissions, status FROM admin_users WHERE id = $1`,
      [payload.adminId]
    );
    if (!result.length) throw new UnauthorizedException();
    return result[0];
  }
}

// ── Auth Controller ───────────────────────────────────────────
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 900000 } })
  async sendOtp(@Body() dto: SendOtpDto) {
    const data = await this.authService.sendOtp(dto.mobile);
    return successResponse(data, `OTP sent to ${dto.mobile}`);
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    const data = await this.authService.verifyOtp(dto.mobile, dto.otp);
    const msg  = data.isNewUser ? 'OTP verified. Please complete registration.' : 'Login successful';
    return successResponse(data, msg);
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    const data = await this.authService.register(dto);
    return successResponse(data, 'Registration successful! Welcome to BPSCNotes 🎉');
  }

  @Post('exam-selection')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async examSelection(@Req() req: any, @Body() dto: ExamSelectionDto) {
    await this.authService.examSelection(req.user.id, dto);
    return successResponse(null, "Let's start preparing! 🚀");
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    const tokens = await this.authService.refreshToken(dto.refreshToken);
    return successResponse(tokens, 'Token refreshed');
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any) {
    await this.authService.logout(req.user.id);
    return successResponse(null, 'Logged out successfully');
  }

  @Post('fcm-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateFcmToken(@Req() req: any, @Body() dto: FcmTokenDto) {
    await this.authService.updateFcmToken(req.user.id, dto.fcmToken);
    return successResponse(null, 'Device registered for notifications');
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: any) {
    const user = await this.authService.getMe(req.user.id);
    return successResponse({ user });
  }

  // ── MPIN endpoints ────────────────────────────────────────

  /** GET /auth/check-mpin?mobile=+919876543210 — public, no auth */
  @Public()
  @Get('check-mpin')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async checkMpin(@Query('mobile') mobile: string) {
    if (!mobile) throw new BadRequestException('mobile query param required');
    const data = await this.authService.checkMpin(mobile);
    return successResponse(data);
  }

  /** POST /auth/login-mpin — public, replaces OTP for returning users */
  @Public()
  @Post('login-mpin')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async loginMpin(@Body() dto: { mobile: string; mpin: string }) {
    if (!dto.mobile || !dto.mpin) throw new BadRequestException('mobile and mpin required');
    const data = await this.authService.loginMpin(dto.mobile, dto.mpin);
    return successResponse(data, 'Login successful');
  }

  /** POST /auth/create-mpin — JWT required, called once after registration */
  @Post('create-mpin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async createMpin(@Req() req: any, @Body() dto: { mpin: string }) {
    if (!dto.mpin) throw new BadRequestException('mpin required');
    const data = await this.authService.createMpin(req.user.id, dto.mpin);
    return successResponse(data, 'MPIN created successfully! Use it to login next time \u{1F512}');
  }

  /** POST /auth/validate-otp — public, checks OTP without consuming it (forgot-mpin flow) */
  @Public()
  @Post('validate-otp')
  @HttpCode(HttpStatus.OK)
  async validateOtp(@Body() dto: VerifyOtpDto) {
    const data = await this.authService.validateForgotMpinOtp(dto.mobile, dto.otp);
    return successResponse(data, 'OTP is valid');
  }

  /** POST /auth/forgot-mpin — public, sends WhatsApp OTP */
  @Public()
  @Post('forgot-mpin')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 900000 } })
  async forgotMpin(@Body() dto: { mobile: string }) {
    if (!dto.mobile) throw new BadRequestException('mobile required');
    const data = await this.authService.forgotMpin(dto.mobile);
    return successResponse(data, 'OTP sent. Enter it to reset your MPIN.');
  }

  /** POST /auth/reset-mpin — public, OTP verified inside, returns JWT */
  @Public()
  @Post('reset-mpin')
  @HttpCode(HttpStatus.OK)
  async resetMpin(@Body() dto: { mobile: string; otp: string; newMpin: string }) {
    if (!dto.mobile || !dto.otp || !dto.newMpin)
      throw new BadRequestException('mobile, otp, and newMpin required');
    const data = await this.authService.resetMpin(dto.mobile, dto.otp, dto.newMpin);
    return successResponse(data, 'MPIN reset successfully! You are now logged in.');
  }

  /** POST /auth/change-mpin — JWT required, from Settings */
  @Post('change-mpin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async changeMpin(@Req() req: any, @Body() dto: { currentMpin: string; newMpin: string }) {
    if (!dto.currentMpin || !dto.newMpin)
      throw new BadRequestException('currentMpin and newMpin required');
    const data = await this.authService.changeMpin(req.user.id, dto.currentMpin, dto.newMpin);
    return successResponse(data, 'MPIN updated successfully!');
  }

  @Get('referrals')
  @UseGuards(JwtAuthGuard)
  async getReferralStats(@Req() req: any) {
    const stats = await this.authService.getReferralStats(req.user.id);
    return successResponse(stats);
  }


 // ── GET /users/me/learning-progress ─────────────────────────
 // Returns the latest in-progress quiz session (if any) so the
 // Dashboard "Continue Learning" card can deep-link to that quiz.
 @Get('users/me/learning-progress')
 @UseGuards(JwtAuthGuard)
 async getLearningProgress(@Req() req: any) {
   const rows = await this.authService.getLearningProgress(req.user.id);
   return successResponse(rows);
 }

 // ── PATCH /users/profile ─────────────────────────────────────
 @Patch('users/profile')
 @UseGuards(JwtAuthGuard)
 @HttpCode(HttpStatus.OK)
 async updateProfile(@Req() req: any, @Body() dto: any) {
   return this.authService.updateProfile(req.user.id, dto);
 }

 // ── DELETE /users/account ────────────────────────────────────
 @Delete('users/account')
 @UseGuards(JwtAuthGuard)
 @HttpCode(HttpStatus.OK)
 async deleteAccount(@Req() req: any) {
   return this.authService.deleteAccount(req.user.id);
 }

 // ── POST /auth/logout ────────────────────────────────────────
 // Already has logout() but adding alias for /auth/logout path
}

// ── Auth Module ───────────────────────────────────────────────
@Module({
  imports: [
   // PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:     config.get('jwt.secret'),
        signOptions: { expiresIn: config.get('jwt.expiresIn') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers:   [AuthService, OtpService, UserJwtStrategy, AdminJwtStrategy, ActivityLogService],
  exports:     [AuthService, UserJwtStrategy, AdminJwtStrategy, ActivityLogService],
})
export class AuthModule {}