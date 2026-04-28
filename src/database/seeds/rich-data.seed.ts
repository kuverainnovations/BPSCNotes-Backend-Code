import { AppDataSource } from '../data-source';
import * as bcrypt from 'bcryptjs';

async function seedRichData() {
  await AppDataSource.initialize();
  const q = AppDataSource.query.bind(AppDataSource);
  console.log('🌱 Seeding rich data...\n');

  // ── Admin User ─────────────────────────────────────────────
  const hash = await bcrypt.hash('Admin@123456', 12);
  await q(`INSERT INTO admin_users (name, email, password_hash, permissions) VALUES ($1,$2,$3,ARRAY['all']) ON CONFLICT (email) DO NOTHING`, ['Super Admin', 'admin@bpscnotes.com', hash]);
  const adminId = (await q(`SELECT id FROM admin_users WHERE email='admin@bpscnotes.com'`))[0].id;
  console.log('✅ Admin user ready');

  // ── Exams ──────────────────────────────────────────────────
  const exams = [
    ['BPSC 70th CCE',   'Bihar Public Service Commission 70th CCE', 'BPSC',        '🎯', 1],
    ['BPSC 71st CCE',   'Bihar Public Service Commission 71st CCE', 'BPSC',        '🎯', 2],
    ['BPSC APO',        'BPSC Assistant Prosecution Officer',       'BPSC',        '⚖️', 3],
    ['Bihar Police SI', 'Bihar Police Sub-Inspector',               'Bihar State', '👮', 4],
    ['Bihar Constable', 'Bihar Police Constable',                   'Bihar State', '🚔', 5],
    ['Bihar SSC',       'Bihar Staff Selection Commission',         'Bihar State', '📋', 6],
    ['BPSC Teacher',    'Bihar Teacher Eligibility (BTET/STET)',    'Teaching',    '🏫', 7],
    ['Bihar Judiciary', 'Bihar Judicial Services',                  'Bihar State', '⚖️', 8],
    ['SSC CGL',         'Staff Selection Commission CGL',           'Central Govt','🇮🇳', 9],
    ['SSC CHSL',        'Staff Selection Commission CHSL',          'Central Govt','📝', 10],
    ['Railway NTPC',    'Railway Recruitment Board NTPC',           'Central Govt','🚂', 11],
    ['Railway Group D', 'Railway Recruitment Board Group D',        'Central Govt','🛤️', 12],
    ['UPSC CSE',        'Union Public Service Commission CSE',      'Central Govt','🏆', 13],
    ['NDA',             'National Defence Academy',                 'Defence',     '🛡️', 14],
    ['CDS',             'Combined Defence Services',                'Defence',     '⚔️', 15],
  ];
  for (const [name, fullName, category, emoji, sort] of exams) {
    await q(`INSERT INTO exams (name, full_name, category, emoji, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING`, [name, fullName, category, emoji, sort]);
  }
  console.log('✅ Exams seeded (15)');

  // ── Coin Rules ─────────────────────────────────────────────
  const rules = [
    ['daily_login',      'Daily Login Bonus',           2,   1],
    ['daily_quiz',       'Complete Daily Quiz',         10,  1],
    ['streak_7',         '7-Day Study Streak Bonus',    15,  1],
    ['streak_30',        '30-Day Study Streak Bonus',   100, 1],
    ['referral',         'Referral — Friend Joined',    50,  5],
    ['active_recall',    'Complete 10 Flashcards',      5,   3],
    ['mock_top10',       'Top 10 in Mock Test',         100, 1],
    ['profile_complete', 'Complete Your Profile',       20,  1],
    ['watch_ad',         'Watch Video Ad',              5,   3],
    ['study_room',       'Join Study Room Session',     5,   2],
  ];
  for (const [action, desc, coins, max] of rules) {
    await q(`INSERT INTO coin_rules (action, description, coins_awarded, max_per_day) VALUES ($1,$2,$3,$4) ON CONFLICT (action) DO NOTHING`, [action, desc, coins, max]);
  }
  console.log('✅ Coin rules seeded (10)');

  // ── App Settings ───────────────────────────────────────────
  const settings = [
    ['maintenance_mode',        'false',  'Put app in maintenance mode'],
    ['force_update',            'false',  'Force users to update'],
    ['new_registrations',       'true',   'Allow new registrations'],
    ['coin_system_enabled',     'true',   'Enable coin system'],
    ['study_rooms_enabled',     'true',   'Enable study rooms'],
    ['app_version',             '1.0.0',  'Current app version'],
    ['min_app_version',         '1.0.0',  'Minimum required version'],
    ['coin_value_inr',          '0.10',   '1 coin value in ₹'],
    ['max_coin_discount_sub',   '30',     'Max % discount via coins (subscription)'],
    ['max_coin_discount_course','50',     'Max % discount via coins (course)'],
    ['android_store_url',       'https://play.google.com/store', 'Play Store URL'],
    ['support_email',           'support@bpscnotes.com', 'Support email'],
  ];
  for (const [key, value, desc] of settings) {
    await q(`INSERT INTO app_settings (key, value, description) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`, [key, value, desc]);
  }
  console.log('✅ App settings seeded');

  // ── Test Users ─────────────────────────────────────────────
  const users = [
    ['Rahul Kumar',   'rahul@example.com',  '+919876543210', 'BPSC 70th CCE',   'intermediate', 25, 380, 'Patna'],
    ['Priya Singh',   'priya@example.com',  '+919876543211', 'BPSC 70th CCE',   'advanced',     22, 420, 'Muzaffarpur'],
    ['Amit Verma',    'amit@example.com',   '+919876543212', 'Bihar Police SI', 'beginner',     8,  120, 'Gaya'],
    ['Sneha Pandey',  'sneha@example.com',  '+919876543213', 'BPSC 70th CCE',   'intermediate', 15, 280, 'Bhagalpur'],
    ['Vikash Yadav',  'vikash@example.com', '+919876543214', 'SSC CGL',         'advanced',     30, 510, 'Darbhanga'],
    ['Pooja Kumari',  'pooja@example.com',  '+919876543215', 'BPSC 71st CCE',   'beginner',     5,  90,  'Nalanda'],
    ['Manoj Tiwari',  'manoj@example.com',  '+919876543216', 'Railway NTPC',    'intermediate', 18, 340, 'Ara'],
    ['Anjali Singh',  'anjali@example.com', '+919876543217', 'UPSC CSE',        'advanced',     45, 780, 'Patna'],
    ['Ravi Shankar',  'ravi@example.com',   '+919876543218', 'Bihar Judiciary', 'intermediate', 12, 210, 'Chapra'],
    ['Deepa Devi',    'deepa@example.com',  '+919876543219', 'BPSC Teacher',    'beginner',     3,  60,  'Sitamarhi'],
    ['Suresh Paswan', 'suresh@example.com', '+919876543220', 'Bihar Constable', 'intermediate', 20, 390, 'Nalanda'],
    ['Kavita Rani',   'kavita@example.com', '+919876543221', 'BPSC 70th CCE',   'advanced',     35, 620, 'Patna'],
  ];
  const userIds: string[] = [];
  for (const [name, email, mobile, exam, prep, streak, coins, district] of users) {
    const ref = String(name).replace(/\s+/g,'').toUpperCase().slice(0,6) + Math.floor(1000+Math.random()*9000);
    const existing = await q(`SELECT id FROM users WHERE mobile=$1`, [mobile]);
    if (!existing.length) {
      const res = await q(
        `INSERT INTO users (name, email, mobile, mobile_verified, primary_exam, prep_level, streak, coins, total_coins_earned, district, accuracy, quizzes_attempted, total_study_minutes, is_verified, referral_code)
         VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$7,$8,$9,$10,$11,TRUE,$12) RETURNING id`,
        [name, email, mobile, exam, prep, streak, coins, district,
         Math.floor(60 + Math.random()*35), Math.floor(20 + Math.random()*80),
         Math.floor(Number(streak) * 45), ref]
      );
      userIds.push(res[0].id);
    } else {
      userIds.push(existing[0].id);
    }
  }
  // Update ranks
  await q(`UPDATE users u SET rank = r.rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY coins DESC) AS rn FROM users WHERE status='active') r WHERE u.id = r.id`);
  console.log('✅ Test users seeded (12)');

  // ── Courses ────────────────────────────────────────────────
  const courses = [
    ['BPSC 70th CCE — Complete Prelims Batch', 'Polity',         'Dr. Rajesh Kumar',   0,    0,    false, true,  120, 85, '{"BPSC 70th CCE","BPSC 71st CCE"}'],
    ['Bihar GK Master Course 2026',            'Bihar GK',       'Sanjay Mishra',       0,    0,    false, false, 80,  60, '{"BPSC 70th CCE","Bihar Police SI"}'],
    ['Economy & Budget Analysis 2026',         'Economy',        'CA Vikram Joshi',     499,  999,  true,  false, 60,  45, '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Modern History — Complete Course',       'History',        'Prof. Amit Singh',    299,  599,  true,  true,  90,  70, '{"BPSC 70th CCE","UPSC CSE","SSC CGL"}'],
    ['Polity by Laxmikanth — Full Batch',      'Polity',         'IAS Priya Sharma',    399,  799,  true,  true,  110, 80, '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Bihar Special — Polity & Governance',    'Polity',         'Dr. Suresh Pandey',   0,    0,    false, false, 45,  35, '{"BPSC 70th CCE","Bihar Police SI"}'],
    ['SSC CGL — Quantitative Aptitude',        'Maths',          'Rakesh Yadav',        349,  699,  true,  false, 75,  55, '{"SSC CGL","SSC CHSL","Railway NTPC"}'],
    ['Geography — NCERT to Advanced',          'Geography',      'Dr. Meena Gupta',     0,    0,    false, false, 55,  40, '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Science & Technology 2026 Updates',      'Science & Tech', 'Dr. Anil Verma',      199,  399,  true,  false, 40,  30, '{"BPSC 70th CCE","SSC CGL"}'],
    ['Environment & Ecology for BPSC',         'Environment',    'Prof. Ravi Tiwari',   0,    0,    false, false, 35,  25, '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Railway NTPC — Complete Batch 2026',     'General Studies','Vivek Singh',         449,  899,  true,  true,  95,  70, '{"Railway NTPC","Railway Group D"}'],
    ['Bihar Police SI — Full Prep Course',     'General Studies','SP Retired Sharma',   299,  599,  true,  false, 65,  50, '{"Bihar Police SI","Bihar Constable"}'],
  ];
  const courseIds: string[] = [];
  for (const [title, subject, instructor, price, origPrice, isPaid, isFeatured, lessons, hours, tags] of courses) {
    const slug = (title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    const rating = (3.8 + Math.random() * 1.2).toFixed(1);
    const enrollments = Math.floor(200 + Math.random() * 5000);
    const res = await q(
      `INSERT INTO courses (title, slug, subject, instructor, price, original_price, is_paid, is_featured, total_lessons, total_hours, exam_tags, status, rating, review_count, enrollment_count, bpsc_relevance, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],'published',$12,$13,$14,$15,$16) RETURNING id`,
      [title, slug, subject, instructor, price, origPrice || price, isPaid, isFeatured, lessons, hours, tags, rating, Math.floor(enrollments * 0.1), enrollments, Math.floor(70 + Math.random() * 30), adminId]
    );
    courseIds.push(res[0].id);
  }
  // Add chapters and lessons for first course
  if (courseIds[0]) {
    const chapters = ['Introduction & Exam Pattern', 'Polity — Constitution Basics', 'History — Ancient & Medieval', 'Geography — Physical & India', 'Economy — Basics & Budget', 'Science & Technology', 'Bihar Special GK', 'Current Affairs Module'];
    for (let i = 0; i < chapters.length; i++) {
      const chRes = await q(`INSERT INTO course_chapters (course_id, title, sort_order) VALUES ($1,$2,$3) RETURNING id`, [courseIds[0], chapters[i], i]);
      const chId = chRes[0].id;
      for (let j = 0; j < 5; j++) {
        await q(`INSERT INTO course_lessons (chapter_id, course_id, title, duration_mins, type, is_free_preview, is_locked, sort_order) VALUES ($1,$2,$3,$4,'video',$5,TRUE,$6)`,
          [chId, courseIds[0], `Lesson ${j+1}: ${chapters[i]} - Part ${j+1}`, 25 + j * 5, j === 0 && i === 0, j]);
      }
    }
  }
  console.log('✅ Courses seeded (12)');

  // ── Library Notes ──────────────────────────────────────────
  const notes = [
    ['BPSC 70th CCE — Complete Notes PDF',     'Polity',         'pdf',   'IAS Topper Notes', false, true,  250, 18.5, '{"polity","constitution","bpsc"}', '{"BPSC 70th CCE"}'],
    ['Bihar GK Handwritten Notes 2026',         'Bihar GK',       'pdf',   'Sanjay Sir',       false, true,  120, 8.2,  '{"bihar","gk","handwritten"}',    '{"BPSC 70th CCE","Bihar Police SI"}'],
    ['Modern History Quick Revision Notes',     'History',        'pdf',   'Amit Singh',       true,  false, 85,  5.4,  '{"history","modern","revision"}', '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Economy Budget 2026 Analysis',            'Economy',        'pdf',   'CA Vikram',        true,  false, 45,  3.1,  '{"economy","budget","2026"}',     '{"BPSC 70th CCE","SSC CGL"}'],
    ['BPSC Previous Year Questions 2000-2024',  'General Studies','pyq',   'BPSCNotes Team',   false, true,  380, 22.0, '{"pyq","previous year","bpsc"}',  '{"BPSC 70th CCE","BPSC 71st CCE"}'],
    ['Bihar Police SI PYQ 2015-2024',           'General Studies','pyq',   'BPSCNotes Team',   false, false, 180, 12.5, '{"pyq","police","bihar"}',        '{"Bihar Police SI","Bihar Constable"}'],
    ['SSC CGL PYQ — 10 Years',                  'General Studies','pyq',   'BPSCNotes Team',   true,  false, 220, 15.8, '{"pyq","ssc","cgl"}',             '{"SSC CGL","SSC CHSL"}'],
    ['NCERT Summary — Class 6 to 12',           'General Studies','book',  'BPSCNotes Team',   false, false, 450, 28.3, '{"ncert","summary","complete"}',  '{"BPSC 70th CCE","UPSC CSE","SSC CGL"}'],
    ['Laxmikanth Polity Summary Book',          'Polity',         'book',  'Summary by IAS',   true,  false, 320, 19.6, '{"polity","laxmikanth","notes"}', '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Bihar Samanya Gyan Book 2026',            'Bihar GK',       'book',  'Patna Publications',false,true,  280, 16.4, '{"bihar","samanya gyan","2026"}', '{"BPSC 70th CCE","Bihar Police SI"}'],
    ['Polity Video Lecture Notes — Complete',   'Polity',         'video', 'Dr. Rajesh Kumar', false, false, 0,   0,    '{"polity","video","lecture"}',    '{"BPSC 70th CCE"}'],
    ['Economy Complete Video Series',           'Economy',        'video', 'CA Vikram Joshi',  true,  false, 0,   0,    '{"economy","video","complete"}',  '{"BPSC 70th CCE","UPSC CSE"}'],
    ['Bihar GK Video Marathon 2026',            'Bihar GK',       'video', 'Sanjay Mishra',    false, true,  0,   0,    '{"bihar","gk","video"}',          '{"BPSC 70th CCE","Bihar Police SI"}'],
  ];
  for (const [title, subject, type, author, isPremium, isPinned, pages, sizeMb, tags, examTags] of notes) {
    const dlCount = Math.floor(500 + Math.random() * 10000);
    await q(
      `INSERT INTO library_notes (title, subject, type, author, is_premium, is_pinned, pages, file_size_mb, tags, exam_tags, status, download_count, rating, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],'published',$11,$12,$13)`,
      [title, subject, type, author, isPremium, isPinned, pages, sizeMb, tags, examTags, dlCount, (3.5 + Math.random() * 1.4).toFixed(1), adminId]
    );
  }
  console.log('✅ Library notes seeded (13)');

  // ── Quizzes ────────────────────────────────────────────────
  const quizzes = [
    ['Daily Quiz — Polity (Apr 22)',        'Polity',         'daily',  'medium', 10, 15, 60, 10, '{"BPSC 70th CCE"}',              '2026-04-22'],
    ['Daily Quiz — History (Apr 22)',       'History',        'daily',  'medium', 10, 15, 60, 10, '{"BPSC 70th CCE"}',              '2026-04-22'],
    ['Bihar GK Special Quiz',               'Bihar GK',       'topic',  'medium', 15, 20, 60, 15, '{"BPSC 70th CCE","Bihar Police SI"}', null],
    ['Polity — Fundamental Rights',         'Polity',         'topic',  'easy',   10, 12, 55, 10, '{"BPSC 70th CCE","UPSC CSE"}',   null],
    ['Modern History — Freedom Struggle',   'History',        'topic',  'hard',   20, 25, 65, 20, '{"BPSC 70th CCE","UPSC CSE"}',   null],
    ['Economy — Budget & Banking',          'Economy',        'topic',  'medium', 15, 18, 60, 15, '{"BPSC 70th CCE","SSC CGL"}',    null],
    ['Geography — Rivers & Mountains',      'Geography',      'topic',  'easy',   10, 12, 50, 10, '{"BPSC 70th CCE"}',              null],
    ['Science & Technology 2026',           'Science & Tech', 'topic',  'medium', 15, 18, 60, 15, '{"BPSC 70th CCE","SSC CGL"}',    null],
    ['BPSC 70th Full Mock Test — Paper 1',  'General Studies','mock',   'hard',   150,120, 70, 50, '{"BPSC 70th CCE"}',              null],
    ['BPSC 70th Full Mock Test — Paper 2',  'General Studies','mock',   'hard',   150,120, 70, 50, '{"BPSC 70th CCE"}',              null],
    ['Bihar Police SI Mock Test',           'General Studies','mock',   'medium', 100, 90, 65, 40, '{"Bihar Police SI"}',            null],
    ['SSC CGL Tier 1 Mock Test',            'General Studies','mock',   'hard',   100, 60, 70, 40, '{"SSC CGL"}',                    null],
    ['Railway NTPC Mock Test 2026',         'General Studies','mock',   'medium', 100, 90, 65, 40, '{"Railway NTPC"}',               null],
  ];
  const quizIds: string[] = [];
  for (const [title, subject, type, difficulty, questions, duration, passing, coins, examTags, scheduled] of quizzes) {
    const attempts = Math.floor(100 + Math.random() * 5000);
    const avgScore = Math.floor(50 + Math.random() * 35);
    const res = await q(
      `INSERT INTO quizzes (title, subject, type, difficulty, total_questions, duration_mins, passing_score, coins_reward, exam_tags, attempt_count, avg_score, status, scheduled_for, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,'published',$12,$13) RETURNING id`,
      [title, subject, type, difficulty, questions, duration, passing, coins, examTags, attempts, avgScore, scheduled, adminId]
    );
    quizIds.push(res[0].id);
  }
  // Add questions to first quiz
  if (quizIds[0]) {
    const questions = [
      ['Article 1 of the Indian Constitution deals with?', 'Citizenship', 'Name and territory of India', 'Fundamental Rights', 'Directive Principles', 'b', 'Article 1 declares India as a Union of States.'],
      ['Who is known as the Father of the Indian Constitution?', 'Mahatma Gandhi', 'Jawaharlal Nehru', 'B.R. Ambedkar', 'Sardar Patel', 'c', 'Dr. B.R. Ambedkar chaired the Drafting Committee.'],
      ['The Preamble of the Constitution was amended in which year?', '1971', '1974', '1976', '1978', 'c', 'The 42nd Amendment (1976) added Secular and Socialist.'],
      ['How many Fundamental Rights are currently in the Indian Constitution?', '5', '6', '7', '8', 'b', 'Currently 6 Fundamental Rights after the right to property was removed.'],
      ['Article 21A provides for?', 'Right to Education', 'Right to Life', 'Right to Equality', 'Right against Exploitation', 'a', 'Article 21A was added by 86th Amendment for free education.'],
      ['Which schedule of the Constitution deals with Anti-Defection Law?', '8th', '9th', '10th', '11th', 'c', '10th Schedule added by 52nd Amendment deals with disqualification.'],
      ['President of India is elected by?', 'Direct election by citizens', 'Lok Sabha members only', 'Electoral college', 'Parliament members only', 'c', 'President is elected by Electoral College comprising MPs and MLAs.'],
      ['The concept of Judicial Review is borrowed from?', 'UK', 'USA', 'Australia', 'Ireland', 'b', 'Judicial Review is taken from the American Constitution.'],
      ['Right to Constitutional Remedies is under which Article?', 'Article 30', 'Article 32', 'Article 35', 'Article 40', 'b', 'Article 32 provides right to move SC for enforcement of FRs.'],
      ['How many subjects are in the Concurrent List?', '47', '52', '61', '66', 'b', 'Concurrent List has 52 subjects where both Centre and States can legislate.'],
    ];
    for (let i = 0; i < questions.length; i++) {
      const [qText, a, b, c, d, correct, explanation] = questions[i];
      await q(`INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, subject, difficulty, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Polity','medium',$9)`,
        [quizIds[0], qText, a, b, c, d, correct, explanation, i]);
    }
  }
  console.log('✅ Quizzes seeded (13) with questions');

  // ── Current Affairs ────────────────────────────────────────
  const affairs = [
    ['Bihar Government launches BPSC Coaching Scheme for SC/ST Students', 'Bihar Cabinet approved ₹500 crore scheme for free BPSC coaching for SC/ST students in Patna.', 'Bihar Affairs',        true,  '2026-04-22', 'Bihar Government'],
    ['RBI keeps Repo Rate unchanged at 6.25%', 'Reserve Bank of India MPC meeting kept repo rate unchanged to control inflation while supporting growth.', 'Economy', true,  '2026-04-21', 'RBI'],
    ['India ranks 130th in Human Development Index 2026', 'UNDP released HDI report placing India at 130th position, improving from 132nd last year.', 'International', false, '2026-04-21', 'UNDP'],
    ['New Education Policy Implementation Update', 'Ministry of Education releases progress report on NEP 2020 implementation across states.', 'Polity & Governance', false, '2026-04-20', 'MoE'],
    ['ISRO successfully launches GSAT-25 satellite', 'Indian Space Research Organisation launches communication satellite expanding broadband connectivity.', 'Science & Tech', true,  '2026-04-20', 'ISRO'],
    ['Bihar Floods: National Disaster Response Force deployed', 'NDRF teams deployed in 12 districts of Bihar as Kosi and Gandak rivers cross danger mark.', 'Bihar Affairs', false, '2026-04-19', 'NDRF'],
    ['India GDP growth forecast revised to 7.2% for FY2026', 'IMF revised India GDP growth upward citing strong domestic consumption and government investment.', 'Economy', true,  '2026-04-19', 'IMF'],
    ['New IIT to be established in Bihar', 'Union Cabinet approved establishment of new IIT in Darbhanga, Bihar with ₹3,000 crore allocation.', 'Bihar Affairs', true,  '2026-04-18', 'Cabinet'],
    ['India wins 2026 Thomas Cup in Badminton', 'Indian men\'s badminton team defeats China 3-1 to clinch historic Thomas Cup for second consecutive time.', 'Sports',         false, '2026-04-18', 'BAI'],
    ['PM inaugurates Patna Metro Phase 1', 'Prime Minister inaugurates first phase of Patna Metro covering 17 stations from Danapur to Mithapur.', 'Bihar Affairs',  true,  '2026-04-17', 'PMO'],
    ['GST Council reduces tax on EVs to 5%', 'GST Council in its 55th meeting reduces tax on Electric Vehicles from 12% to 5% to promote adoption.', 'Economy',         false, '2026-04-17', 'GST Council'],
    ['India-Bangladesh water sharing treaty renewed', 'India and Bangladesh renew Teesta river water sharing treaty for 30 years at bilateral summit.', 'International',   true,  '2026-04-16', 'MEA'],
    ['Bihar achieves 100% household electrification', 'Bihar becomes 12th state to achieve 100% household electrification under Saubhagya scheme.', 'Bihar Affairs',   false, '2026-04-16', 'MNRE'],
    ['SC rules on NEET paper leak case', 'Supreme Court delivers landmark judgment on NEET paper leak case ordering comprehensive reforms in exam system.', 'Polity & Governance', true, '2026-04-15', 'Supreme Court'],
    ['India\'s forex reserves cross $700 billion mark', 'India\'s foreign exchange reserves hit record $700 billion, making it 4th largest globally.', 'Economy', true, '2026-04-15', 'RBI'],
  ];
  for (const [title, summary, category, isImportant, date, source] of affairs) {
    const views = Math.floor(500 + Math.random() * 15000);
    const bookmarks = Math.floor(100 + Math.random() * 3000);
    await q(
      `INSERT INTO current_affairs (title, summary, category, source, date, is_important, exam_tags, status, view_count, bookmark_count, author, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,ARRAY['BPSC 70th CCE','BPSC 71st CCE'],'published',$7,$8,$9,$10)`,
      [title, summary, category, source, date, isImportant, views, bookmarks, 'BPSCNotes Team', adminId]
    );
  }
  console.log('✅ Current affairs seeded (15)');

  // ── Job Vacancies ──────────────────────────────────────────
  const jobs = [
    ['BPSC 70th CCE', 'Bihar Public Service Commission', 'BPSC', 346, '2026-02-15', '2026-05-30', '2026-08-10', '21-37 years', 'Graduation', 'https://bpsc.bih.nic.in', 'active', '{"BPSC 70th CCE"}'],
    ['BPSC 71st CCE Notification', 'Bihar Public Service Commission', 'BPSC', 400, '2026-04-01', '2026-06-15', null, '21-37 years', 'Graduation', 'https://bpsc.bih.nic.in', 'active', '{"BPSC 71st CCE"}'],
    ['Bihar Police Sub-Inspector (SI) 2026', 'Bihar Police Headquarters', 'Bihar State', 1275, '2026-01-20', '2026-04-30', '2026-07-15', '20-37 years', 'Graduation', 'https://csbc.bih.nic.in', 'active', '{"Bihar Police SI"}'],
    ['Bihar Constable Recruitment 2026', 'Central Selection Board of Constable', 'Bihar State', 21391, '2026-03-01', '2026-05-20', '2026-09-01', '18-25 years', 'Class 10', 'https://csbc.bih.nic.in', 'active', '{"Bihar Constable"}'],
    ['Bihar SSC Graduate Level Exam 2026', 'Bihar Staff Selection Commission', 'Bihar State', 2792, '2026-02-10', '2026-05-10', '2026-08-20', '18-37 years', 'Graduation', 'https://bssc.bihar.gov.in', 'active', '{"Bihar SSC"}'],
    ['BPSC Assistant Engineer (Civil) 2026', 'Bihar Public Service Commission', 'BPSC', 283, '2026-03-15', '2026-06-01', null, '21-37 years', 'B.Tech Civil', 'https://bpsc.bih.nic.in', 'upcoming', '{"BPSC AE"}'],
    ['SSC CGL 2026 Notification', 'Staff Selection Commission', 'Central Govt', 17727, '2026-04-05', '2026-05-25', '2026-09-01', '18-32 years', 'Graduation', 'https://ssc.nic.in', 'active', '{"SSC CGL"}'],
    ['SSC CHSL 2026', 'Staff Selection Commission', 'Central Govt', 3712, '2026-03-20', '2026-05-15', '2026-08-15', '18-27 years', 'Class 12', 'https://ssc.nic.in', 'active', '{"SSC CHSL"}'],
    ['RRB NTPC 2026 — 35,000 vacancies', 'Railway Recruitment Board', 'Central Govt', 35000, '2026-04-10', '2026-06-10', '2026-10-01', '18-33 years', 'Graduation', 'https://rrbonlinereg.co.in', 'active', '{"Railway NTPC"}'],
    ['RRB Group D 2026', 'Railway Recruitment Board', 'Central Govt', 32438, '2026-04-15', '2026-06-15', '2026-11-01', '18-33 years', 'Class 10 + ITI', 'https://rrbonlinereg.co.in', 'upcoming', '{"Railway Group D"}'],
    ['BPSC Teacher TRE 4.0', 'Bihar Education Department', 'Teaching', 89000, '2026-04-01', '2026-05-31', '2026-07-15', '21-37 years', 'Graduation + B.Ed', 'https://bpsc.bih.nic.in', 'active', '{"BPSC Teacher"}'],
    ['Bihar Judicial Service (BJS) 2026', 'Patna High Court', 'Bihar State', 138, '2026-03-10', '2026-05-10', null, '22-35 years', 'LLB', 'https://patnahighcourt.gov.in', 'active', '{"Bihar Judiciary"}'],
    ['NDA & NA Exam I 2026', 'Union Public Service Commission', 'Defence', 400, '2026-01-15', '2026-03-04', '2026-09-14', '16.5-19.5 years', 'Class 12', 'https://upsc.gov.in', 'expired', '{"NDA"}'],
  ];
  for (const [title, org, category, posts, notifDate, lastDate, examDate, age, qual, link, status, tags] of jobs) {
    const views = Math.floor(1000 + Math.random() * 20000);
    const saves = Math.floor(200 + Math.random() * 5000);
    await q(
      `INSERT INTO job_vacancies (title, organization, category, total_posts, notification_date, last_date, exam_date, age_limit, qualification, application_link, status, view_count, save_count, exam_tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15)`,
      [title, org, category, posts, notifDate, lastDate, examDate, age, qual, link, status, views, saves, tags, adminId]
    );
  }
  console.log('✅ Job vacancies seeded (13)');

  // ── Subscriptions ──────────────────────────────────────────
  const plans: any[] = [
    ['monthly',   199,  1],
    ['quarterly', 499,  3],
    ['annual',    1499, 12],
    ['annual',    1499, 12],
    ['monthly',   199,  1],
    ['quarterly', 499,  3],
    ['annual',    1499, 12],
    ['monthly',   199,  1],
  ];
  for (let i = 0; i < Math.min(plans.length, userIds.length); i++) {
    const [plan, amount, months] = plans[i];
    const startsAt = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);
    const endsAt   = new Date(startsAt);
    endsAt.setMonth(endsAt.getMonth() + months);
    await q(
      `INSERT INTO subscriptions (user_id, plan, amount, original_amount, final_amount, payment_status, status, payment_method, starts_at, ends_at)
       VALUES ($1,$2,$3,$3,$3,'success','active','UPI',$4,$5) ON CONFLICT DO NOTHING`,
      [userIds[i], plan, amount, startsAt, endsAt]
    );
  }
  console.log('✅ Subscriptions seeded (8)');

  // ── Coupons ────────────────────────────────────────────────
  const coupons = [
    ['BPSC50',    'percent', 5,   'Extra 5% off for BPSC aspirants',      5000, 'subscription', '2026-12-31'],
    ['SAVE100',   'flat',    100, '₹100 flat discount on any plan',        2000, 'both',         '2026-12-31'],
    ['FIRST',     'flat',    50,  'First-time subscriber discount',        10000,'subscription', '2026-12-31'],
    ['BIHAR25',   'percent', 25,  'Bihar Students Special — 25% off',      1000, 'both',         '2026-06-30'],
    ['ANNUAL30',  'percent', 30,  '30% off on Annual Plan',                500,  'subscription', '2026-05-31'],
    ['NOTES20',   'percent', 20,  '20% off on all course purchases',       3000, 'course',       '2026-12-31'],
    ['EXAM2026',  'flat',    200, 'Exam Season Special Discount',          2500, 'both',         '2026-07-31'],
  ];
  for (const [code, type, value, desc, maxUses, appliesTo, expiresAt] of coupons) {
    await q(`INSERT INTO coupons (code, type, value, description, max_uses, applies_to, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO NOTHING`,
      [code, type, value, desc, maxUses, appliesTo, expiresAt, adminId]);
  }
  console.log('✅ Coupons seeded (7)');

  // ── Banners ────────────────────────────────────────────────
  const banners = [
    ['BPSC 70th CCE — Last Chance!',       'Get 40% off Annual Plan. Offer ends tonight!',        'promotion', 'all',             'from-blue-600 to-blue-800',   1],
    ['New Bihar GK Course Live 🎉',         'Join 12,400+ students preparing for BPSC.',           'course',    'BPSC 70th CCE',   'from-yellow-500 to-orange-500',2],
    ['Mock Test Series Available',          'Test yourself with 150 BPSC questions. Free!',        'quiz',      'BPSC 70th CCE',   'from-purple-600 to-purple-800',3],
    ['Bihar Police SI Batch Starting',      'New batch starting May 1st. Limited seats.',          'promotion', 'Bihar Police SI', 'from-green-600 to-teal-600',   4],
    ['Daily Current Affairs — Free!',       'Read today\'s current affairs. Earn 5 coins!',        'content',   'all',             'from-red-500 to-pink-600',     5],
    ['Referral Bonus — Earn ₹50 Worth Coins', 'Refer a friend and earn 50 coins = ₹5 discount!',  'promotion', 'all',             'from-indigo-500 to-blue-600',  6],
  ];
  for (const [title, subtitle, type, target, bg, sort] of banners) {
    await q(`INSERT INTO banners (title, subtitle, type, target, bg_gradient, sort_order, is_active, created_by) VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)`,
      [title, subtitle, type, target, bg, sort, adminId]);
  }
  console.log('✅ Banners seeded (6)');

  // ── Notifications ──────────────────────────────────────────
  const notifications = [
    ['Daily Quiz is Live! 🎯', 'Today\'s Polity quiz is ready. Attempt now and earn 10 coins!', 'quiz',         'all',  3200, 1840],
    ['New Current Affairs Posted 📰', '15 important current affairs for April 22 are now live.', 'announcement', 'all',  18543, 9200],
    ['BPSC 70th CCE Exam Date Announced!', 'Preliminary exam scheduled for August 10, 2026. Start your preparation now!', 'job', 'exam', 8200, 5100],
    ['Your 7-Day Streak! 🔥', 'Congratulations! You\'ve maintained a 7-day study streak. Keep going!', 'streak', 'all', 4500, 3200],
    ['Bihar GK Course Launched 🎉', 'Our most popular Bihar GK course is now live. Free enrollment!', 'course', 'all', 18543, 7800],
    ['Pro Plan at ₹199/month', 'Unlock unlimited notes, all courses and quizzes. Limited time offer!', 'promotion', 'free', 11000, 4200],
    ['Mock Test Series 5 Available', 'BPSC 70th CCE Mock Test 5 with 150 questions is now live.', 'quiz', 'exam', 8200, 3900],
    ['New Job Alert: Bihar Constable', '21,391 vacancies in Bihar Police Constable. Last date: May 20!', 'job', 'all', 18543, 8900],
  ];
  for (const [title, body, type, target, totalSent, opened] of notifications) {
    const clicked = Math.floor((opened as number) * 0.3);
    await q(
      `INSERT INTO notifications (title, body, type, target, status, sent_at, total_sent, total_opened, total_clicked, created_by)
       VALUES ($1,$2,$3,$4,'sent',NOW()-($5 || ' minutes')::interval,$5,$6,$7,$8)`,
      [title, body, type, target, Math.floor(Math.random() * 10000), totalSent, opened, clicked, adminId]
    );
  }
  console.log('✅ Notifications seeded (8)');

  // ── Study Rooms ────────────────────────────────────────────
  if (userIds.length >= 4) {
    const rooms = [
      ['BPSC 70th — Polity Marathon', 'Polity', 20, false, '{"BPSC 70th CCE"}'],
      ['Bihar GK Daily Discussion',    'Bihar GK', 15, false, '{"BPSC 70th CCE","Bihar Police SI"}'],
      ['Economy Study Circle',         'Economy',  10, true,  '{"BPSC 70th CCE","UPSC CSE"}'],
      ['Current Affairs Group',        'Current Affairs', 25, false, '{"BPSC 70th CCE"}'],
      ['Mock Test Discussion Room',    'General Studies', 30, false, '{"BPSC 70th CCE","BPSC 71st CCE"}'],
    ];
    for (let i = 0; i < rooms.length; i++) {
      const [name, subject, maxMembers, isPrivate, tags] = rooms[i];
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const hostId = userIds[i % userIds.length];
      const res = await q(
        `INSERT INTO study_rooms (name, subject, host_id, max_members, is_private, join_code, exam_tags, status, total_sessions)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],'active',$8) RETURNING id`,
        [name, subject, hostId, maxMembers, isPrivate, code, tags, Math.floor(5 + Math.random() * 50)]
      );
      // Add a few members
      const numMembers = Math.floor(3 + Math.random() * (maxMembers as number * 0.7));
      for (let j = 0; j < Math.min(numMembers, userIds.length); j++) {
        await q(`INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [res[0].id, userIds[j]]);
      }
    }
    console.log('✅ Study rooms seeded (5)');
  }

  // ── Live Classes ───────────────────────────────────────────
  const liveClasses = [
    ['Bihar GK — Live Session', 'Sanjay Mishra', 'Bihar GK', 'Today 6:00 PM', 90, '{"BPSC 70th CCE"}', 342],
    ['Polity Master — Constitution Deep Dive', 'Dr. Rajesh Kumar', 'Polity', 'Tomorrow 7:00 PM', 90, '{"BPSC 70th CCE","UPSC CSE"}', 289],
    ['Economy Special — Budget 2026 Analysis', 'CA Vikram Joshi', 'Economy', '3 days from now', 120, '{"BPSC 70th CCE","SSC CGL"}', 198],
    ['Modern History — Freedom Struggle', 'Prof. Amit Singh', 'History', '5 days from now', 90, '{"BPSC 70th CCE"}', 156],
    ['Daily Current Affairs Recap', 'BPSCNotes Team', 'Current Affairs', 'Yesterday 8:00 PM', 45, '{"BPSC 70th CCE","BPSC 71st CCE"}', 512],
    ['Bihar Special GK Marathon', 'Sanjay Mishra', 'Bihar GK', '1 week from now', 180, '{"BPSC 70th CCE","Bihar Police SI"}', 421],
    ['Mock Test Discussion — Test 5', 'IAS Priya Sharma', 'General Studies', '2 weeks from now', 60, '{"BPSC 70th CCE"}', 234],
  ];
  const now = new Date();
  for (let i = 0; i < liveClasses.length; i++) {
    const [title, instructor, subject, , duration, tags, registered] = liveClasses[i];
    const scheduledAt = new Date(now);
    scheduledAt.setDate(scheduledAt.getDate() + (i - 1));
    scheduledAt.setHours(18 + (i % 3), 0, 0, 0);
    const status = i === 4 ? 'completed' : 'scheduled';
    await q(
      `INSERT INTO live_classes (title, instructor, subject, scheduled_at, duration_mins, exam_tags, registered_count, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9)`,
      [title, instructor, subject, scheduledAt, duration, tags, registered, status, adminId]
    );
  }
  console.log('✅ Live classes seeded (7)');

  // ── Enroll users in courses ────────────────────────────────
  if (courseIds.length && userIds.length) {
    for (let i = 0; i < Math.min(userIds.length, 8); i++) {
      for (let j = 0; j < Math.min(3, courseIds.length); j++) {
        const progress = Math.floor(Math.random() * 100);
        await q(
          `INSERT INTO user_enrollments (user_id, course_id, completed_lessons, status)
           VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, course_id) DO NOTHING`,
          [userIds[i], courseIds[(i + j) % courseIds.length], progress, progress >= 90 ? 'completed' : 'active']
        );
      }
    }
    console.log('✅ Course enrollments created');
  }

  // ── Quiz attempts ──────────────────────────────────────────
  if (quizIds.length && userIds.length) {
    for (let i = 0; i < Math.min(userIds.length, 10); i++) {
      for (let j = 0; j < Math.min(3, quizIds.length); j++) {
        const correct = Math.floor(4 + Math.random() * 6);
        const total   = 10;
        const score   = Math.round((correct / total) * 100);
        await q(
          `INSERT INTO quiz_attempts (user_id, quiz_id, score, total_questions, correct_answers, time_taken_secs, coins_earned, is_passed, answers)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb)`,
          [userIds[i], quizIds[(i + j) % quizIds.length], score, total, correct, Math.floor(300 + Math.random() * 600), score >= 60 ? 10 : 0, score >= 60]
        );
      }
    }
    console.log('✅ Quiz attempts created');
  }

  // ── Coin transactions for users ────────────────────────────
  for (const userId of userIds.slice(0, 8)) {
    const userCoins = (await q(`SELECT coins FROM users WHERE id=$1`, [userId]))[0]?.coins || 0;
    await q(`INSERT INTO coin_transactions (user_id, type, amount, description, action, balance) VALUES ($1,'earned',2,'Daily Login Bonus','daily_login',$2)`, [userId, userCoins]);
  }
  console.log('✅ Coin transactions created');

  await AppDataSource.destroy();
  console.log('\n🎉 Rich data seeding completed!');
  console.log('📊 Summary:');
  console.log('   Users: 12 | Courses: 12 | Library: 13 | Quizzes: 13');
  console.log('   Current Affairs: 15 | Jobs: 13 | Subscriptions: 8');
  console.log('   Coupons: 7 | Banners: 6 | Notifications: 8');
  console.log('   Study Rooms: 5 | Live Classes: 7');
}

seedRichData().catch(err => {
  console.error('❌ Seeding failed:', err.message);
  process.exit(1);
});
