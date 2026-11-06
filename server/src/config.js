import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Загружаем server/.env, если он есть (встроенный загрузчик Node, без dotenv).
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const isProd = (process.env.NODE_ENV || 'development') === 'production';
const pepper = process.env.PEPPER || '';

// Не даём запуститься в проде без серверного секрета для scrypt.
if (isProd && !pepper) {
  throw new Error('[cna] NODE_ENV=production требует заданный PEPPER (см. server/.env.example).');
}

export const config = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 3000),
  dbPath: process.env.DB_PATH || path.join(root, 'cna.db'),
  // Статический веб-клиент (t7): по умолчанию соседний chrome-and-ash-web/.
  clientDir: process.env.CLIENT_DIR || path.join(root, '..', 'chrome-and-ash-web'),
  sessionTtlDays: intEnv('SESSION_TTL_DAYS', 30),
  isProd,
  pepper,
  rateLimit: {
    windowMs: intEnv('RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000),
    max: intEnv('RATE_LIMIT_MAX', 10),          // на (IP + имя аккаунта)
    maxPerIp: intEnv('RATE_LIMIT_MAX_PER_IP', 30), // на IP
  },
  // Разрешённые Origin для WebSocket-апгрейда (через запятую). Пусто = разрешены
  // same-origin и localhost/127.0.0.1 (см. server/docs/07-pvp-protocol.md §2).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
};
