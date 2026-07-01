import { seedFlashcards } from './rich-data.seed';
import { AppDataSource } from '../data-source';
import * as bcrypt from 'bcryptjs';

async function runSeeds() {
  await AppDataSource.initialize();
  const q = AppDataSource.query.bind(AppDataSource);

  console.log('🌱 Seeding database...');

  // ── Admin User ─────────────────────────────────────────────
  const hash = await bcrypt.hash('Admin@123456', 12);
  await q(`
    INSERT INTO admin_users (name, email, password_hash, permissions)
    VALUES ('Super Admin', 'admin@bpscnotes.com', $1, ARRAY['all'])
    ON CONFLICT (email) DO NOTHING
  `, [hash]);
  console.log('✅ Admin user created: admin@bpscnotes.com / Admin@123456');

  // ── Exams ──────────────────────────────────────────────────
  const exams = [
    ['BPSC 70th CCE',   'Bihar Public Service Commission 70th CCE',  'BPSC',       '🎯', 1],
    ['BPSC 71st CCE',   'Bihar Public Service Commission 71st CCE',  'BPSC',       '🎯', 2],
    ['BPSC APO',        'BPSC Assistant Prosecution Officer',        'BPSC',       '⚖️', 3],
    ['BPSC AE',         'BPSC Assistant Engineer',                   'BPSC',       '📐', 4],
    ['Bihar Police SI', 'Bihar Police Sub-Inspector',                'Bihar State','👮', 5],
    ['Bihar Constable', 'Bihar Police Constable',                    'Bihar State','🚔', 6],
    ['Bihar SSC',       'Bihar Staff Selection Commission',          'Bihar State','📋', 7],
    ['BPSC Teacher',    'Bihar Teacher Eligibility (BTET/STET)',     'Teaching',   '🏫', 8],
    ['Bihar Judiciary', 'Bihar Judicial Services',                   'Bihar State','⚖️', 9],
    ['SSC CGL',         'Staff Selection Commission CGL',            'Central Govt','🇮🇳',10],
    ['SSC CHSL',        'Staff Selection Commission CHSL',           'Central Govt','📝',11],
    ['Railway NTPC',    'Railway Recruitment Board NTPC',            'Central Govt','🚂',12],
    ['Railway Group D', 'Railway Recruitment Board Group D',         'Central Govt','🛤️',13],
    ['UPSC CSE',        'Union Public Service Commission CSE',       'Central Govt','🏆',14],
    ['NDA',             'National Defence Academy',                  'Defence',    '🛡️',15],
    ['CDS',             'Combined Defence Services',                 'Defence',    '⚔️',16],
    ['Bihar Engineering','Bihar Engineering Services',               'Bihar State','⚙️',17],
    ['Bihar Health Dept','Bihar Health Services Exam',               'Bihar State','🏥',18],
  ];
  for (const [name, fullName, category, emoji, sort] of exams) {
    await q(`INSERT INTO exams (name, full_name, category, emoji, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING`, [name, fullName, category, emoji, sort]);
  }
  console.log('✅ Exams seeded');

  // ── Coin Rules ─────────────────────────────────────────────
  const rules = [
    ['daily_login',      'Daily Login Bonus',            2,   1],
    ['daily_quiz',       'Complete Daily Quiz',          10,  1],
    ['streak_7',         '7-Day Study Streak Bonus',     15,  1],
    ['streak_30',        '30-Day Study Streak Bonus',    100, 1],
    ['referral',         'Referral — Friend Joined',     50,  5],
    ['active_recall',    'Complete 10 Flashcards',       5,   3],
    ['mock_top10',       'Top 10 in Mock Test',          100, 1],
    ['profile_complete', 'Complete Your Profile',        20,  1],
    ['watch_ad',         'Watch Video Ad',               5,   3],
    ['study_room',       'Join Study Room Session',      5,   2],
  ];
  for (const [action, desc, coins, max] of rules) {
    await q(`INSERT INTO coin_rules (action, description, coins_awarded, max_per_day) VALUES ($1,$2,$3,$4) ON CONFLICT (action) DO NOTHING`, [action, desc, coins, max]);
  }
  console.log('✅ Coin rules seeded');

  // ── App Settings ───────────────────────────────────────────
  const settings = [
    ['maintenance_mode',          'false',   'Put app in maintenance mode'],
    ['force_update',              'false',   'Force users to update'],
    ['new_registrations',         'true',    'Allow new registrations'],
    ['coin_system_enabled',       'true',    'Master switch — when false, no coins are earned or spent anywhere in the app'],
    ['coin_to_inr_rate',          '1',       'Rupee value of 1 coin when applied as a discount on a purchase'],
    ['max_coin_discount_pct_course',   '10', 'Max % of a course price that can be discounted with coins (e.g. 10 = up to 10% off)'],
    ['max_coin_discount_pct_material', '10', 'Max % of a study material price that can be discounted with coins'],
    ['max_coin_discount_pct_subscription', '30', 'Max % of a subscription price that can be paid with coins'],
    ['checkin_streak_rewards',    '5,5,10,10,15,15,25', 'Comma-separated coin rewards for daily check-in streak days 1-7'],
    ['ad_min_per_session',        '2',       'Minimum rewarded ads a student should watch per study session'],
    ['app_version',               '1.0.0',   'Current app version'],
    ['min_app_version',           '1.0.0',   'Minimum required version'],
    ['otp_expiry_minutes',        '10',      'OTP validity in minutes'],
    ['android_store_url',         'https://play.google.com/store/apps/details?id=com.bpscnotes', 'Play Store URL'],
    ['support_email',             'support@bpscnotes.com', 'Support email'],
    ['support_phone',             '+91 9876543210', 'Support phone'],
  ];
  for (const [key, value, desc] of settings) {
    await q(`INSERT INTO app_settings (key, value, description) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`, [key, value, desc]);
  }
  console.log('✅ App settings seeded');

  // ── Default Coupons ────────────────────────────────────────
  const adminResult = await q(`SELECT id FROM admin_users WHERE email='admin@bpscnotes.com' LIMIT 1`);
  const adminId = adminResult[0]?.id;
  if (adminId) {
    const coupons = [
      ['BPSC50',  'percent', 5,  'BPSC aspirants discount',  5000, 'subscription'],
      ['SAVE100', 'flat',    100, '₹100 flat discount',      2000, 'both'],
      ['FIRST',   'flat',    50,  'First-time subscriber',   10000, 'subscription'],
    ];
    for (const [code, type, value, desc, maxUses, appliesTo] of coupons) {
      await q(
        `INSERT INTO coupons (code, type, value, description, max_uses, applies_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
        [code, type, value, desc, maxUses, appliesTo, adminId]
      );
    }
    console.log('✅ Default coupons seeded');
  }

  // ── Flashcards ─────────────────────────────────────────────
  if (adminId) {
    await seedFlashcards(AppDataSource.query.bind(AppDataSource), adminId);
  }

  await AppDataSource.destroy();
  console.log('\n🎉 All seeds completed successfully!');
}

runSeeds().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
