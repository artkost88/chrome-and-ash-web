import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
export const SCHEMA_VERSION = 3;

// v3: server track library + unlisted share links (Stage C, docs/08).
export const TRACKS_V3_SQL = `
CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  spec_json   TEXT NOT NULL,
  spec_schema INTEGER NOT NULL DEFAULT 1,
  revision    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_owner_updated ON tracks(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS track_shares (
  id         TEXT PRIMARY KEY,
  track_id   TEXT NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_shares_track ON track_shares(track_id);
`;

/** Удаляет просроченные и отозванные сессии (вызывается при старте и периодически). */
export function cleanupSessions(db, now = new Date().toISOString()) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now);
}

function userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function setUserVersion(db, version) {
  // PRAGMA не принимает bind-параметр; version — только внутренняя константа.
  db.exec('PRAGMA user_version = ' + Number(version));
}

function backupBeforeMigration(db, dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = dbPath + '.pre-v3-' + stamp + '.db';
  const escaped = target.replace(/'/g, "''");
  db.exec("VACUUM INTO '" + escaped + "'");
  return target;
}

/** Оставляет только newest `keep` копий `<db>.pre-v3-*.db` после успешной миграции. */
function pruneBackups(dbPath, keep = 5) {
  if (!dbPath || dbPath === ':memory:') return [];
  const dir = path.dirname(dbPath);
  const prefix = path.basename(dbPath) + '.pre-v3-';
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const backups = files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort((a, b) => b.localeCompare(a)); // timestamp в имени, новые первыми
  const removed = [];
  for (const f of backups.slice(keep)) {
    try { unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* ignore */ }
  }
  return removed;
}

/**
 * Выполняет ordered v3 DDL в транзакции и выставляет user_version только после
 * успешного применения. Ошибка откатывает DDL, оставляя БД на v2.
 * Экспортируется для теста failed migration (можно передать заведомо битый SQL).
 */
export function migrateToV3(db, sql = TRACKS_V3_SQL) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    setUserVersion(db, 3);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* rollback best effort */ }
    throw error;
  }
}

/**
 * Открывает БД, применяет миграции v1/v2 -> v3 и чистит сессии.
 * schema.sql содержит только базовые v2-таблицы; user_version здесь.
 * @param {string} dbPath путь к файлу или ":memory:"
 */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    // WAL и foreign_keys — вне транзакции миграции.
    db.exec('PRAGMA foreign_keys = ON;');
    if (dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
    }

    const version = userVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new Error('[cna] БД новее поддерживаемой схемы: user_version=' + version);
    }

    if (version < 2) {
      const base = readFileSync(BASE_SCHEMA_PATH, 'utf8');
      db.exec(base);
      setUserVersion(db, 2);
    }

    if (version < 3) {
      // WAL-aware backup only for an existing v1/v2 database.
      if (version >= 1) backupBeforeMigration(db, dbPath);
      migrateToV3(db);
      // Retention применяется только после успешного COMMIT.
      pruneBackups(dbPath, 5);
    }

    cleanupSessions(db);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    throw error;
  }
}
