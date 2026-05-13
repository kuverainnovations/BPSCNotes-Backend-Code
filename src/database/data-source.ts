import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

const isCompiled = __dirname.includes('dist');

export const AppDataSource = new DataSource({
  type: 'postgres',

  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'bpscnotes',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',

  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : false,

  entities: isCompiled
    ? ['dist/modules/**/*.entity.js']
    : ['src/modules/**/*.entity.ts'],

  migrations: isCompiled
    ? ['dist/database/migrations/*.js']
    : ['src/database/migrations/*.ts'],

  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});