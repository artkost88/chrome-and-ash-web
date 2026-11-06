import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

/** Удаляет просроченные и отозванные сессии (вызывается при старте и периодически). */
export function cleanupSessions(db, now = new Date().toISOString()) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now);
}

/**
 * Открывает БД, применяет schema.sql и чистит просроченные сессии.
 * @param {string} dbPath путь к файлу или ":memory:"
 */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  cleanupSessions(db);
  return db;
}
