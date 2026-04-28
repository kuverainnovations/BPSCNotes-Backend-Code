import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  env:         process.env.NODE_ENV || 'development',
  port:        parseInt(process.env.PORT, 10) || 5000,
  apiPrefix:   process.env.API_PREFIX || 'api/v1',
  name:        process.env.APP_NAME || 'BPSCNotes',
  url:         process.env.APP_URL || 'http://localhost:5000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  isDev:       process.env.NODE_ENV === 'development',
  isProd:      process.env.NODE_ENV === 'production',
}));

export const dbConfig = registerAs('database', () => ({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  name:     process.env.DB_NAME || 'bpscnotes',
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true',
  poolMin:  parseInt(process.env.DB_POOL_MIN, 10) || 2,
  poolMax:  parseInt(process.env.DB_POOL_MAX, 10) || 20,
  logging:  process.env.DB_LOGGING === 'true',
}));

export const redisConfig = registerAs('redis', () => ({
  host:     process.env.REDIS_HOST || 'localhost',
  port:     parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  ttl:      parseInt(process.env.REDIS_TTL, 10) || 300,
  db:       parseInt(process.env.REDIS_DB, 10) || 0,
}));

export const jwtConfig = registerAs('jwt', () => ({
  secret:            process.env.JWT_SECRET,
  expiresIn:         process.env.JWT_EXPIRES_IN || '7d',
  refreshSecret:     process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn:  process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  adminSecret:       process.env.ADMIN_JWT_SECRET,
  adminExpiresIn:    process.env.ADMIN_JWT_EXPIRES_IN || '24h',
}));

export const otpConfig = registerAs('otp', () => ({
  msg91AuthKey:    process.env.MSG91_AUTH_KEY,
  msg91TemplateId: process.env.MSG91_TEMPLATE_ID,
  msg91SenderId:   process.env.MSG91_SENDER_ID || 'BPSCNT',
  expiryMinutes:   parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10,
  maxAttempts:     parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 3,
}));

export const cloudinaryConfig = registerAs('cloudinary', () => ({
  cloudName:  process.env.CLOUDINARY_CLOUD_NAME,
  apiKey:     process.env.CLOUDINARY_API_KEY,
  apiSecret:  process.env.CLOUDINARY_API_SECRET,
}));

export const firebaseConfig = registerAs('firebase', () => ({
  projectId:    process.env.FIREBASE_PROJECT_ID,
  privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttl:       parseInt(process.env.THROTTLE_TTL, 10) || 60,
  limit:     parseInt(process.env.THROTTLE_LIMIT, 10) || 100,
  otpTtl:    parseInt(process.env.THROTTLE_OTP_TTL, 10) || 900,
  otpLimit:  parseInt(process.env.THROTTLE_OTP_LIMIT, 10) || 5,
}));

export const businessConfig = registerAs('business', () => ({
  coinValueInr:          parseFloat(process.env.COIN_VALUE_INR) || 0.10,
  maxCoinDiscountSub:    parseInt(process.env.MAX_COIN_DISCOUNT_SUB, 10) || 30,
  maxCoinDiscountCourse: parseInt(process.env.MAX_COIN_DISCOUNT_COURSE, 10) || 50,
  referralCoinsReferrer: parseInt(process.env.REFERRAL_COINS_REFERRER, 10) || 50,
  referralCoinsReferee:  parseInt(process.env.REFERRAL_COINS_REFEREE, 10) || 30,
  dailyLoginCoins:       parseInt(process.env.DAILY_LOGIN_COINS, 10) || 2,
  maxFileSizeMb:         parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50,
}));

export const allConfigs = [
  appConfig, dbConfig, redisConfig, jwtConfig,
  otpConfig, cloudinaryConfig, firebaseConfig,
  throttleConfig, businessConfig,
];
