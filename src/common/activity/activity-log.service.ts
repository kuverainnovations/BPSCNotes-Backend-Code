import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export const ACTIONS = {
  USER_REGISTERED:         'user_registered',
  USER_LOGIN_OTP:          'user_login_otp',
  USER_LOGIN_MPIN:         'user_login_mpin',
  USER_LOGOUT:             'user_logout',
  USER_MPIN_CREATED:       'user_mpin_created',
  USER_MPIN_CHANGED:       'user_mpin_changed',
  USER_MPIN_RESET:         'user_mpin_reset',
  USER_PROFILE_UPDATED:    'user_profile_updated',
  USER_AVATAR_UPLOADED:    'user_avatar_uploaded',
  USER_ACCOUNT_DELETED:    'user_account_deleted',
  COURSE_ENROLLED:         'course_enrolled',
  COURSE_REVIEW_SUBMITTED: 'course_review_submitted',
  LESSON_COMPLETED:        'lesson_completed',
  QUIZ_STARTED:            'quiz_started',
  QUIZ_SUBMITTED:          'quiz_submitted',
  MATERIAL_UPLOADED:       'material_uploaded',
  MATERIAL_DOWNLOADED:     'material_downloaded',
  MATERIAL_PURCHASED:      'material_purchased',
  MATERIAL_BOOKMARKED:     'material_bookmarked',
  STUDY_SESSION_STARTED:   'study_session_started',
  STUDY_SESSION_ENDED:     'study_session_ended',
  TIER_PROMOTED:           'tier_promoted',
  LIVE_CLASS_REGISTERED:   'live_class_registered',
  COINS_AWARDED:           'coins_awarded',
  SUBSCRIPTION_STARTED:    'subscription_started',
  JOB_SAVED:               'job_saved',
  REFERRAL_USED:           'referral_used',
} as const;

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async log(
    userId: string | null,
    action: string,
    description?: string,
    metadata?: Record<string, any>,
    ipAddress?: string,
  ): Promise<void> {
    try {
      // Ensure table exists (safe for first run before migration)
      await this.db.query(
        'INSERT INTO user_activity_log (user_id, action, description, metadata, ip_address) VALUES ($1,$2,$3,$4,$5)',
        [userId || null, action, description || null, JSON.stringify(metadata || {}), ipAddress || null]
      );
    } catch (err: any) {
      // Still non-blocking — an audit row must never fail a user's request.
      // But it is logged now: this used to swallow silently, which is how
      // course/quiz/material/session/premium logging sat broken for weeks
      // while the admin Activity page looked healthy on auth rows alone.
      this.logger.warn(`activity log failed (action=${action}): ${err?.message ?? err}`);
    }
  }
}
