import {
  Module, Injectable, Controller,
  Get, Post, Body, Param, Query, Req,
  UseGuards, HttpCode, HttpStatus,
  NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { InjectDataSource }       from '@nestjs/typeorm';
import { DataSource }             from 'typeorm';
import { CACHE_MANAGER }          from '@nestjs/cache-manager';
import { Cache }                  from 'cache-manager';
import { Inject }                 from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard }           from '../../common/guards';
import { AuthModule }             from '../auth/auth.module';
import { successResponse }        from '../../common/utils/response.util';

// ════════════════════════════════════════════════════════════
// FILE: backend/src/modules/coins/coins.module.ts
//
// Powers: CoinWalletScreen
// Endpoints:
//   GET  /coins/balance       — balance + streak + 7-day check-in grid
//   GET  /coins/tasks         — earn tasks with completion status
//   GET  /coins/transactions  — paginated history
//   POST /coins/check-in      — daily check-in (idempotent)
//   POST /coins/tasks/:id/claim — claim a task reward
// ════════════════════════════════════════════════════════════

// ── Task definitions (static catalogue, no separate table needed) ─
// These are the earn tasks shown in CoinWalletScreen.
// Completion is checked dynamically against user activity.
const EARN_TASKS = [
  {
    id:           'daily_quiz',
    title:        'Complete Daily Quiz',
    subtitle:     'Answer today\'s quiz correctly',
    icon:         'quiz',
    action:       'quiz_attempt',
    coinsReward:  10,
    actionLabel:  'Take Quiz',
    actionBgHex:  '#1565C0',
    iconBgHex:    '#E3F2FD',
    iconTintHex:  '#1565C0',
    actionTextColorHex: '#FFFFFF',
    isAd:         false,
  },
  {
    id:           'study_session',
    title:        'Complete Study Session',
    subtitle:     'Study for at least 30 minutes',
    icon:         'study',
    action:       'study_session',
    coinsReward:  15,
    actionLabel:  'Study Now',
    actionBgHex:  '#2E7D32',
    iconBgHex:    '#E8F5E9',
    iconTintHex:  '#2E7D32',
    actionTextColorHex: '#FFFFFF',
    isAd:         false,
  },
  {
    id:           'upload_note',
    title:        'Upload Study Notes',
    subtitle:     'Share notes with the community',
    icon:         'study',
    action:       'material_upload',
    coinsReward:  25,
    actionLabel:  'Upload',
    actionBgHex:  '#FF8F00',
    iconBgHex:    '#FFF3E0',
    iconTintHex:  '#FF8F00',
    actionTextColorHex: '#FFFFFF',
    isAd:         false,
  },
  {
    id:           'referral',
    title:        'Refer a Friend',
    subtitle:     'Invite friends and earn coins',
    icon:         'referral',
    action:       'referral',
    coinsReward:  75,
    actionLabel:  'Invite',
    actionBgHex:  '#7B1FA2',
    iconBgHex:    '#F3E5F5',
    iconTintHex:  '#7B1FA2',
    actionTextColorHex: '#FFFFFF',
    isAd:         false,
  },
  {
    id:           'watch_ad',
    title:        'Watch a Short Ad',
    subtitle:     'Watch a 30-second ad to earn',
    icon:         'ad',
    action:       'ad_watch',
    coinsReward:  5,
    actionLabel:  'Watch',
    actionBgHex:  '#E74C3C',
    iconBgHex:    '#FEE8E8',
    iconTintHex:  '#E74C3C',
    actionTextColorHex: '#FFFFFF',
    isAd:         true,
  },
];

// ── Daily check-in rewards per day (day 1–7) ──────────────────
const CHECKIN_REWARDS = [5, 5, 10, 10, 15, 15, 25]; // day 1→5, 2→5, ... 7→25

@Injectable()
export class CoinsService {
  private readonly logger = new Logger(CoinsService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ── GET /coins/balance ────────────────────────────────────────
  // Returns: balance, totalEarned, totalSpent, checkInStreak,
  //          checkedInToday, checkInDays (7-day array)
  async getBalance(userId: string) {
    const [user] = await this.db.query(`
      SELECT coins, total_coins_earned, last_active_at,
             streak, COALESCE(last_check_in_date, NULL) AS last_check_in
      FROM users WHERE id = $1
    `, [userId]);

    if (!user) throw new NotFoundException('User not found');

    // FIX: If user has coins but NO transaction records, create a bootstrap
    // transaction so history shows the starting balance correctly.
    const txnCount = await this.db.query(
      `SELECT COUNT(*) AS cnt FROM coin_transactions WHERE user_id = $1`, [userId]
    );
    const userCoins = user.coins ?? 0;
    const userEarned = user.total_coins_earned ?? 0;
    if (parseInt(txnCount[0].cnt) === 0 && userCoins > 0) {
      // Record the existing coins as an initial grant
      await this.db.query(`
        INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
        VALUES ($1, 'earned', $2, 'Initial coins balance', 'initial_grant', $2)
        ON CONFLICT DO NOTHING
      `, [userId, userCoins]).catch(() => {
        // Best-effort — ignore if it fails (e.g. no ON CONFLICT support)
      });
    }

    const totalSpent = await this.db.query(`
      SELECT COALESCE(SUM(amount), 0)::int AS spent
      FROM coin_transactions WHERE user_id = $1 AND type = 'spent'
    `, [userId]);

    const todayUTC  = new Date().toISOString().slice(0, 10);
    const lastCheckin = user.last_check_in ? new Date(user.last_check_in).toISOString().slice(0, 10) : null;
    const checkedInToday = lastCheckin === todayUTC;

    // Build 7-day check-in grid: look at coin_transactions for 'daily_checkin' last 7 days
    const txns = await this.db.query(`
      SELECT DATE(created_at AT TIME ZONE 'UTC') AS day
      FROM coin_transactions
      WHERE user_id = $1 AND action = 'daily_checkin'
        AND created_at >= NOW() - INTERVAL '7 days'
    `, [userId]);
    const checkedDays = new Set(txns.map((t: any) => t.day?.toISOString?.()?.slice(0, 10) ?? t.day));

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const now       = new Date();
    const todayIdx  = (now.getDay() + 6) % 7; // 0=Mon … 6=Sun

    const checkInDays = dayLabels.map((label, i) => {
      const d       = new Date(now);
      const diff    = i - todayIdx;
      d.setDate(d.getDate() + diff);
      const dateStr = d.toISOString().slice(0, 10);
      return {
        day:        i + 1,
        label,
        isDone:     checkedDays.has(dateStr),
        isToday:    i === todayIdx,
        bonusLabel: i === 6 ? '+25 Bonus!' : '',
        isBonus:    i === 6,
      };
    });

    const streak = checkedInToday ? user.streak : Math.max(0, user.streak - 1);

    return successResponse({
      balance:           user.coins ?? 0,
      totalEarned:       user.total_coins_earned ?? 0,
      totalSpent:        totalSpent[0]?.spent ?? 0,
      check_in_streak:   streak,        // snake_case → matches Android @SerializedName("check_in_streak")
      checked_in_today:  checkedInToday,// snake_case → matches Android @SerializedName("checked_in_today")
      checkInDays,
    });
  }

  // ── GET /coins/tasks ─────────────────────────────────────────
  // Returns tasks with dynamic isCompleted based on today's activity
  async getEarnTasks(userId: string) {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Check which actions were completed today
    const todayTxns = await this.db.query(`
      SELECT action FROM coin_transactions
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, todayStart.toISOString()]);

    // Check if user uploaded material today
    const uploaded = await this.db.query(`
      SELECT 1 FROM study_materials
      WHERE uploader_id = $1 AND created_at >= $2 LIMIT 1
    `, [userId, todayStart.toISOString()]).catch(() => []);

    // Check if quiz was completed today
    const quizDone = await this.db.query(`
      SELECT 1 FROM quiz_attempts
      WHERE user_id = $1 AND attempted_at >= $2 LIMIT 1
    `, [userId, todayStart.toISOString()]).catch(() => []);

    // Check study session today
    const studiedToday = await this.db.query(`
      SELECT 1 FROM study_sessions
      WHERE user_id = $1 AND started_at >= $2
        AND active_minutes >= 30 LIMIT 1
    `, [userId, todayStart.toISOString()]).catch(() => []);

    const completedActions = new Set(todayTxns.map((t: any) => t.action));

    const tasks = EARN_TASKS.map(task => {
      let isCompleted = completedActions.has(task.action);
      // Override with direct activity checks
      if (task.id === 'daily_quiz')   isCompleted = isCompleted || quizDone.length > 0;
      if (task.id === 'study_session') isCompleted = isCompleted || studiedToday.length > 0;
      if (task.id === 'upload_note')  isCompleted = isCompleted || uploaded.length > 0;
      return { ...task, isCompleted };
    });

    return successResponse({ tasks });
  }

  // ── GET /coins/transactions ──────────────────────────────────
  async getTransactions(userId: string, limit = 20, page = 1) {
    const offset = (page - 1) * limit;
    const txns = await this.db.query(`
      SELECT
        id,
        description          AS title,
        CASE action
          WHEN 'daily_checkin'   THEN 'Daily streak bonus'
          WHEN 'quiz_attempt'    THEN 'Quiz completed'
          WHEN 'study_session'   THEN 'Study session reward'
          WHEN 'material_upload' THEN 'Material upload reward'
          WHEN 'referral'        THEN 'Referral bonus'
          WHEN 'ad_watch'        THEN 'Ad watched'
          ELSE description
        END                  AS subtitle,
        amount               AS coins,
        type,
        action               AS icon,
        created_at           AS date
      FROM coin_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    return successResponse({ transactions: txns });
  }

  // ── POST /coins/check-in ─────────────────────────────────────
  // Idempotent — safe to call multiple times per day
  async checkIn(userId: string) {
    const todayUTC = new Date().toISOString().slice(0, 10);

    // Check if already checked in today
    const existing = await this.db.query(`
      SELECT 1 FROM coin_transactions
      WHERE user_id = $1 AND action = 'daily_checkin'
        AND DATE(created_at AT TIME ZONE 'UTC') = $2
    `, [userId, todayUTC]);

    if (existing.length > 0) {
      const [user] = await this.db.query(`
        SELECT coins, total_coins_earned, streak FROM users WHERE id=$1
      `, [userId]);
      return successResponse({
        balance:           user.coins,
        totalEarned:       user.total_coins_earned,
        check_in_streak:   user.streak,
        checked_in_today:  true,
        alreadyCheckedIn:  true,
      }, 'Already checked in today! Come back tomorrow.');
    }

    // Determine streak
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const [user] = await this.db.query(
      `SELECT coins, total_coins_earned, streak, COALESCE(last_check_in_date, NULL) AS lci FROM users WHERE id=$1`,
      [userId]
    );
    const lastDate = user.lci ? new Date(user.lci).toISOString().slice(0, 10) : null;
    const newStreak = lastDate === yesterdayStr ? (user.streak ?? 0) + 1 : 1;

    // Day 7 bonus or normal reward
    const dayIndex  = Math.min(newStreak - 1, 6);
    const coinsEarned = CHECKIN_REWARDS[dayIndex];

    // Award coins + update streak atomically
    // FIX: Use explicit update then SELECT — RETURNING with COALESCE can return NULL
    // when the column was previously NULL (Postgres returns pre-update NULL not the expression)
    await this.db.query(`
      UPDATE users
      SET coins              = COALESCE(coins, 0) + $1,
          total_coins_earned = COALESCE(total_coins_earned, 0) + $1,
          streak             = $2,
          last_check_in_date = NOW()
      WHERE id = $3
    `, [coinsEarned, newStreak, userId]);

    // Re-fetch actual values after update
    const [updated] = await this.db.query(
      `SELECT coins, total_coins_earned, streak FROM users WHERE id = $1`,
      [userId]
    );

    const balance = updated.coins ?? 0;

    // Record transaction (balance is now guaranteed non-null)
    await this.db.query(`
      INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
      VALUES ($1, 'earned', $2, $3, 'daily_checkin', $4)
    `, [userId, coinsEarned, `Daily Check-in — Day ${newStreak}`, balance]);

    const message = newStreak === 7
      ? `🎉 7-day streak! Bonus +${coinsEarned} coins!`
      : `✅ Day ${newStreak} check-in! +${coinsEarned} coins`;

    return successResponse({
      balance,
      totalEarned:       updated.total_coins_earned,
      check_in_streak:   newStreak,   // snake_case → Android @SerializedName("check_in_streak")
      checked_in_today:  true,        // snake_case → Android @SerializedName("checked_in_today")
      coinsEarned,
    }, message);
  }

  // ── POST /coins/tasks/:id/claim ───────────────────────────────
  async claimTask(taskId: string, userId: string) {
    const task = EARN_TASKS.find(t => t.id === taskId);
    if (!task) throw new NotFoundException(`Task '${taskId}' not found`);

    // Idempotency — only once per day per task
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const existing = await this.db.query(`
      SELECT 1 FROM coin_transactions
      WHERE user_id=$1 AND action=$2 AND created_at >= $3
    `, [userId, task.action, todayStart.toISOString()]);

    if (existing.length > 0) {
      const [u] = await this.db.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
      return successResponse({ balance: u.coins, alreadyClaimed: true }, 'Already claimed today!');
    }

    // FIX: explicit update then SELECT — RETURNING with COALESCE can return NULL
    await this.db.query(`
      UPDATE users
      SET coins              = COALESCE(coins, 0) + $1,
          total_coins_earned = COALESCE(total_coins_earned, 0) + $1
      WHERE id = $2
    `, [task.coinsReward, userId]);

    const [updated] = await this.db.query(
      `SELECT coins FROM users WHERE id = $1`, [userId]
    );
    const balance = updated.coins ?? 0;

    await this.db.query(`
      INSERT INTO coin_transactions (user_id, type, amount, description, action, balance)
      VALUES ($1, 'earned', $2, $3, $4, $5)
    `, [userId, task.coinsReward, task.title, task.action, balance]);

    return successResponse({
      balance:     balance,
      coinsEarned: task.coinsReward,
    }, `+${task.coinsReward} coins earned!`);
  }
}

// ════════════════════════════════════════════════════════════
// CONTROLLER
// ════════════════════════════════════════════════════════════
@ApiTags('Coins Wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('coins')
export class CoinsController {
  constructor(private readonly svc: CoinsService) {}

  /** GET /coins/balance */
  @Get('balance')
  getBalance(@Req() r: any) { return this.svc.getBalance(r.user.id); }

  /** GET /coins/tasks */
  @Get('tasks')
  getTasks(@Req() r: any) { return this.svc.getEarnTasks(r.user.id); }

  /** GET /coins/transactions?page=1&limit=20 */
  @Get('transactions')
  getTransactions(
    @Req() r: any,
    @Query('limit') limit = 20,
    @Query('page')  page  = 1
  ) { return this.svc.getTransactions(r.user.id, +limit, +page); }

  /** POST /coins/check-in */
  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  checkIn(@Req() r: any) { return this.svc.checkIn(r.user.id); }

  /** POST /coins/tasks/:id/claim */
  @Post('tasks/:id/claim')
  @HttpCode(HttpStatus.OK)
  claimTask(@Param('id') id: string, @Req() r: any) {
    return this.svc.claimTask(id, r.user.id);
  }
}

// ════════════════════════════════════════════════════════════
// MODULE
// ════════════════════════════════════════════════════════════
@Module({
  imports:     [AuthModule],
  controllers: [CoinsController],
  providers:   [CoinsService],
  exports:     [CoinsService],
})
export class CoinsModule {}
