// ════════════════════════════════════════════════════════════
// AUTH MODULE — Full implementation
// ════════════════════════════════════════════════════════════
import {
  Module, Injectable, Controller, Post, Get, Body, Req,
  HttpCode, HttpStatus, UnauthorizedException, BadRequestException,
  ConflictException,
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
import * as axios from 'axios';
import {
  IsString, IsOptional, IsEmail, Length, Matches,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard, Public } from '../../common/guards';
import { UseGuards, Request } from '@nestjs/common';
import { successResponse } from '../../common/utils/response.util';

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

  async send(mobile: string): Promise<{ success: boolean; otp?: string }> {
    const otpConfig = this.config.get('otp');
    const otp       = this.generateOtp();
    const expiryMins = otpConfig.expiryMinutes;

    // Invalidate previous OTPs for this mobile
    await this.db.query(`DELETE FROM otps WHERE mobile = $1 AND is_used = FALSE`, [mobile]);

    // Store hashed OTP
    const hash = await bcrypt.hash(otp, 6);
    await this.db.query(
      `INSERT INTO otps (mobile, otp_hash, expires_at) VALUES ($1, $2, NOW() + $3::INTERVAL)`,
      [mobile, hash, `${expiryMins} minutes`]
    );

    if (this.config.get('app.env') === 'development') {
      console.log(`📱 DEV OTP for ${mobile}: ${otp}`);
      return { success: true, otp };
    }

    try {
      // await axios.default.post(
      //   'https://api.msg91.com/api/v5/otp',
      //   null,
      //   {
      //     params: {
      //       authkey: otpConfig.msg91AuthKey,
      //       mobile: `91${mobile.replace('+91', '')}`,
      //       template_id: otpConfig.msg91TemplateId,
      //       otp,
      //     },
      //   }
      // );

      console.log("OTP is __ : ", otp); 
return { success: true, otp };
    } catch (err) {
      console.error('MSG91 FULL ERROR:', err.response?.data || err.message);
      throw new BadRequestException('Failed to send OTP');
    }
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

  private generateOtp(): string {
    // return Math.floor(100000 + Math.random() * 900000).toString();
    return "123456"
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
    const resp = await this.otpService.send(mobile);
    return { isNewUser, ...(resp.otp && { otp: resp.otp }) };
  }

  async verifyOtp(mobile: string, otp: string) {
    await this.otpService.verify(mobile, otp);

    const result = await this.db.query(
      `SELECT id, name, email, mobile, role, status, coins, streak, primary_exam,
              prep_level, referral_code, is_verified
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

    return {
      isNewUser: false,
      ...tokens,
      user: this.sanitizeUser(user),
    };
  }

  async register(dto: RegisterDto) {
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
        `INSERT INTO users (name, email, mobile, mobile_verified, district, referral_code, referred_by)
         VALUES ($1,$2,$3,TRUE,$4,$5,$6) RETURNING *`,
        [dto.name, dto.email || null, mobile, dto.district || null, refCode, referrerId]
      );
      return result[0];
    });

    const tokens = await this.generateTokens(newUser.id);
    await this.db.query(`UPDATE users SET refresh_token = $1 WHERE id = $2`, [tokens.refreshToken, newUser.id]);

    await this.awardCoins(newUser.id, 'daily_login');

    if (referrerId) {
      await this.awardCoins(referrerId, 'referral', newUser.id);
      const refBonus = parseInt(this.config.get('business.referralCoinsReferee'));
      await this.db.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [refBonus, newUser.id]);
      const bal = (await this.db.query(`SELECT coins FROM users WHERE id=$1`, [newUser.id]))[0].coins;
      await this.db.query(
        `INSERT INTO coin_transactions (user_id, type, amount, description, action, balance) VALUES ($1,'earned',$2,'Referral signup bonus','referral_signup',$3)`,
        [newUser.id, refBonus, bal]
      );
    }

    return {
      ...tokens,
      user: {
        id: newUser.id, name: newUser.name, email: newUser.email,
        mobile: newUser.mobile, referralCode: newUser.referral_code,
        isNewUser: true, needsExamSelection: true,
      },
    };
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
         (SELECT plan FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' AND s.ends_at > NOW() LIMIT 1) AS current_plan
       FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId]
    );
    if (!result.length) throw new UnauthorizedException('User not found');

    const user = result[0];
    delete user.password_hash;
    delete user.refresh_token;
    delete user.fcm_token;

    await this.cache.set(cacheKey, user, 60); // 60 sec
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

  async awardCoins(userId: string, action: string, refId?: string): Promise<number> {
    try {
      const rules = await this.db.query(
        `SELECT coins_awarded, max_per_day FROM coin_rules WHERE action = $1 AND is_active = TRUE`,
        [action]
      );
      if (!rules.length) return 0;

      const rule = rules[0];
      const todayCount = await this.db.query(
        `SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1 AND action=$2 AND created_at::date = CURRENT_DATE`,
        [userId, action]
      );
      if (parseInt(todayCount[0].count) >= rule.max_per_day) return 0;

      const balResult = await this.db.query(
        `UPDATE users SET coins = coins + $1, total_coins_earned = total_coins_earned + $1 WHERE id = $2 RETURNING coins`,
        [rule.coins_awarded, userId]
      );
      const newBalance = balResult[0].coins;

      await this.db.query(
        `INSERT INTO coin_transactions (user_id, type, amount, description, action, ref_id, balance) VALUES ($1,'earned',$2,$3,$4,$5,$6)`,
        [userId, rule.coins_awarded, `${action} reward`, action, refId || null, newBalance]
      );

      await this.cache.del(`user:${userId}`);
      return rule.coins_awarded;
    } catch (err) {
      console.error('awardCoins error:', err.message);
      return 0;
    }
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

    console.log("ADMIN PAYLOAD:", payload);

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
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
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
  @Throttle({ default: { limit: 5, ttl: 900000 } })
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
  providers:   [AuthService, OtpService, UserJwtStrategy, AdminJwtStrategy],
  exports:     [AuthService, UserJwtStrategy, AdminJwtStrategy],
})
export class AuthModule {}
