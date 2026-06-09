import * as admin from 'firebase-admin';

/**
 * Idempotent Firebase Admin initializer.
 * Call this wherever firebase-admin is used (auth, notifications, tier-rooms).
 * Safe to call multiple times — initializes only once.
 */
export function ensureFirebaseAdmin(): boolean {
  if (admin.apps.length) return true;

  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    '/app/firebase-service-account.json';

  try {
    admin.initializeApp({
      credential: admin.credential.cert(require(serviceAccountPath)),
    });
    console.log('✅ Firebase Admin initialized');
    return true;
  } catch (err: any) {
    console.error('❌ Firebase Admin initialization failed:', err.message);
    return false;
  }
}
