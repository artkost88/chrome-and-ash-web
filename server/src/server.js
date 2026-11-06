import http from 'node:http';
import { config } from './config.js';
import { openDb, cleanupSessions } from './db.js';
import { createApp } from './app.js';
import { createPvp } from './pvp.js';

const db = openDb(config.dbPath);
const pvp = createPvp({ db, config });
const app = createApp({ db, config, pvpRouter: pvp.router });

const server = http.createServer(app);
pvp.attach(server);

server.listen(config.port, config.host, () => {
  console.log(`[cna] chrome-and-ash-server слушает http://${config.host}:${config.port}`);
  console.log(`[cna] база данных: ${config.dbPath}`);
  console.log(`[cna] NODE_ENV: ${process.env.NODE_ENV || 'development'} (secure-cookie: ${config.isProd})`);
});

// Периодическая очистка просроченных/отозванных сессий (раз в час).
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const timer = setInterval(() => {
  try { cleanupSessions(db); } catch (e) { console.error('[cna] ошибка очистки сессий', e); }
}, CLEANUP_INTERVAL_MS);
timer.unref();
