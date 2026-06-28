import { MigrationInterface, QueryRunner } from 'typeorm';

export class NotificationDefaults1783000000008 implements MigrationInterface {
  name = 'NotificationDefaults1783000000008';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      INSERT INTO app_settings (key, value) VALUES
        ('notif_daily_quiz_enabled',      'true'),
        ('notif_daily_quiz_hour_ist',     '7'),
        ('notif_streak_risk_enabled',     'true'),
        ('notif_streak_risk_hour_ist',    '20'),
        ('notif_target_reminder_enabled', 'true'),
        ('notif_target_reminder_hour_ist','9'),
        ('streak_warning_hour',           '20')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DELETE FROM app_settings WHERE key IN (
        'notif_daily_quiz_enabled','notif_daily_quiz_hour_ist',
        'notif_streak_risk_enabled','notif_streak_risk_hour_ist',
        'notif_target_reminder_enabled','notif_target_reminder_hour_ist',
        'streak_warning_hour'
      )
    `);
  }
}
