import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { join } from 'path';

dotenv.config();

export const AppDataSource = new DataSource({
  type:         'postgres',
  host:         process.env.DB_HOST || 'localhost',
  port:         parseInt(process.env.DB_PORT, 10) || 5432,
  database:     process.env.DB_NAME || 'bpscnotes',
  username:     process.env.DB_USER || 'postgres',
  password:     process.env.DB_PASSWORD || '',
  ssl:          process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities:   ['src/modules/**/*.entity{.ts,.js}'],
migrations: ['src/database/migrations/*{.ts,.js}'],
  synchronize:  false,
  logging:      process.env.DB_LOGGING === 'true',
});
