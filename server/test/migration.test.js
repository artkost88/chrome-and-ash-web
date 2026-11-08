import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrateToV3 } from '../src/db.js';

const V1_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, display_name TEXT NOT NULL, faction_pref TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, user_agent TEXT, ip TEXT
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, daily_date TEXT, faction TEXT NOT NULL,
  track_kind TEXT NOT NULL DEFAULT 'mosaic', track_size INTEGER NOT NULL DEFAULT 28,
  laps INTEGER NOT NULL DEFAULT 1, seed INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', score INTEGER, damage INTEGER, kills INTEGER,
  result TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE saves (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, state TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (run_id, slot)
);
CREATE TABLE daily_results (
  id TEXT PRIMARY KEY, daily_date TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  faction TEXT NOT NULL, pos INTEGER NOT NULL, score INTEGER NOT NULL,
  damage INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, daily_date)
);
`;

const NOW = '2026-01-02T03:04:05.000Z';

function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cna-migration-'));
  return path.join(dir, name);
}

function insertLegacy(db, version) {
  db.prepare('INSERT INTO accounts (id, username, password_hash, display_name, faction_pref, created_at, updated_at, last_login_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('acc-legacy', 'legacy', 'scrypt$x', 'Legacy', 'rust', NOW, NOW, NOW);
  db.prepare("INSERT INTO runs (id, account_id, mode, daily_date, faction, track_kind, track_size, laps, seed, status, score, damage, kills, result, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('run-legacy', 'acc-legacy', 'daily', '2026-01-02', 'rust', 'mosaic', 36, 1, 7, 'finished', 11, 2, 1, '{"score":11}', NOW, NOW);
  db.prepare("INSERT INTO saves (id, run_id, account_id, slot, revision, state, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('save-legacy', 'run-legacy', 'acc-legacy', 0, 3, '{"schemaVersion":1}', 'finished', NOW, NOW);
  db.prepare("INSERT INTO daily_results (id, daily_date, account_id, run_id, faction, pos, score, damage, kills, finished_at, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('daily-legacy', '2026-01-02', 'acc-legacy', 'run-legacy', 'rust', 1, 11, 2, 1, NOW, '{}', NOW, NOW);
  if (version >= 2) {
    db.prepare("INSERT INTO games (id, lobby_code, owner_account_id, status, config_json, state, seq, created_at, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run('game-legacy', 'ABC123', 'acc-legacy', 'waiting', '{}', null, 0, NOW, null, null);
    db.prepare("INSERT INTO game_players (game_id, account_id, slot, controller, faction, joined_at, disconnected_at) VALUES (?,?,?,?,?,?,?)")
      .run('game-legacy', 'acc-legacy', 0, 'human', 'rust', NOW, null);
  }
}

function makeLegacyFile(version) {
  const file = tempPath('legacy-v' + version + '.db');
  const db = new DatabaseSync(file);
  db.exec(V1_SCHEMA);
  db.exec('PRAGMA user_version = ' + version + ';');
  if (version >= 2) {
    db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, lobby_code TEXT NOT NULL UNIQUE, owner_account_id TEXT, status TEXT NOT NULL DEFAULT 'waiting', config_json TEXT NOT NULL, state TEXT, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);`);
    db.exec(`CREATE TABLE game_players (game_id TEXT NOT NULL, account_id TEXT, slot INTEGER NOT NULL, controller TEXT NOT NULL DEFAULT 'bot', faction TEXT, joined_at TEXT NOT NULL, disconnected_at TEXT, PRIMARY KEY (game_id, slot));`);
  }
  insertLegacy(db, version);
  db.close();
  return file;
}

function count(db, table) {
  return db.prepare('SELECT COUNT(*) AS c FROM ' + table).get().c;
}

test('C1: fresh database bootstraps to v3 and is idempotent', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracks'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='track_shares'").get());
  assert.equal(count(db, 'accounts'), 0);
  db.close();
});

test('C1: v1 file migrates to v3, keeps rows, writes a v2 backup', () => {
  const file = makeLegacyFile(1);
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(count(db, 'accounts'), 1);
  assert.equal(count(db, 'runs'), 1);
  assert.equal(count(db, 'saves'), 1);
  assert.equal(count(db, 'daily_results'), 1);
  assert.equal(count(db, 'tracks'), 0);
  db.close();

  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(path.basename(file) + '.pre-v3-'));
  assert.equal(backups.length, 1, 'expected one WAL-aware pre-v3 backup');
  const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]));
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(count(backup, 'accounts'), 1);
  assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracks'").get(), undefined);
  backup.close();

  const again = openDb(file);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(count(again, 'accounts'), 1);
  again.close();
});

test('C1: v2 file preserves runs/saves/daily/PvP rows after migration', () => {
  const file = makeLegacyFile(2);
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT lobby_code FROM games WHERE id = ?').get('game-legacy').lobby_code, 'ABC123');
  assert.equal(db.prepare('SELECT account_id FROM game_players WHERE game_id = ?').get('game-legacy').account_id, 'acc-legacy');
  assert.equal(db.prepare('SELECT revision FROM saves WHERE id = ?').get('save-legacy').revision, 3);
  db.close();
});

test('C1: pre-v3 backup retention keeps the newest five copies', () => {
  const file = makeLegacyFile(2);
  const dir = path.dirname(file);
  const base = path.basename(file);
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(dir, base + '.pre-v3-2020-01-0' + (i + 1) + 'T00-00-00-000Z.db'), 'old');
  }
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.close();
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.pre-v3-') && f.endsWith('.db'));
  assert.equal(backups.length, 5, backups.join(','));
  assert.equal(backups.includes(base + '.pre-v3-2020-01-01T00-00-00-000Z.db'), false);
  assert.equal(backups.includes(base + '.pre-v3-2020-01-07T00-00-00-000Z.db'), true);
});

test('C1: failed v3 migration keeps user_version=2 and can be retried', () => {
  const file = makeLegacyFile(2);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.throws(() => migrateToV3(db, 'CREATE TABLE broken ( '), /./);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracks'").get(), undefined);
  migrateToV3(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracks'").get());
  db.close();
});
