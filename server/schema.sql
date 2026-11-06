-- ХРОМ И ПЕПЕЛ — схема SQLite, фазы 1+2 web (реализация server/).
-- Источник контракта: chrome-and-ash-web/docs/06-web-api.md (раздел 7) и
-- server/docs/07-pvp-protocol.md (раздел 6).
-- Уточнения реализации t6:
--   * saves.state допускает NULL — пустой слот, создаваемый при POST /api/runs,
--     заполняется только первым PUT /api/save/:id;
--   * daily_results дополнен pos и finished_at — лидерборд по сиду сортируется
--     как «позиция → урон → время».
-- Идемпотентность (t10): все CREATE TABLE / CREATE INDEX используют IF NOT EXISTS,
-- поэтому схему безопасно применять к уже существующему файлу БД при каждом запуске.
-- Миграция v1→v2 (t17): добавлены games и game_players (IF NOT EXISTS), user_version=2.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 2;

-- ---------------------------------------------------------------------------
-- Аккаунты
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,            -- UUIDv7
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash
  display_name  TEXT NOT NULL,
  faction_pref  TEXT,                        -- chrome|rust|carnival|swarm; NULL = не выбран
  created_at    TEXT NOT NULL,               -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- ---------------------------------------------------------------------------
-- Сессии (токен передаётся только в HttpOnly-cookie)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,               -- UUIDv7 (не сам токен)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,           -- sha256(token); сырой токен не хранится
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Заезды (race | championship | daily)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,              -- UUIDv7
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('race','championship','daily')),
  daily_date  TEXT,                          -- YYYY-MM-DD; только для mode='daily'
  faction     TEXT NOT NULL CHECK (faction IN ('chrome','rust','carnival','swarm')),
  track_kind  TEXT NOT NULL DEFAULT 'mosaic' CHECK (track_kind IN ('ring','mosaic')),
  track_size  INTEGER NOT NULL DEFAULT 28,
  laps        INTEGER NOT NULL DEFAULT 1 CHECK (laps IN (1,2)),
  seed        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','abandoned')),
  score       INTEGER,                       -- ОЧ игрока; NULL, пока активен
  damage      INTEGER,                       -- нанесённый урон (тай-брейк)
  kills       INTEGER,                       -- уничтожения (справочно)
  result      TEXT,                          -- JSON RunResult (score + detail + standings)
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((mode = 'daily') = (daily_date IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_runs_account ON runs(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_board ON runs(mode, status, score DESC, damage DESC, finished_at ASC);

-- ---------------------------------------------------------------------------
-- Сохранения (снимки состояния партии)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saves (
  id         TEXT PRIMARY KEY,               -- UUIDv7
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot       INTEGER NOT NULL DEFAULT 0,     -- фаза 1: один слот; фаза 2: несколько
  revision   INTEGER NOT NULL DEFAULT 0,     -- монотонная версия (оптимистичная блокировка)
  state      TEXT,                           -- JSON SaveState; NULL до первого сохранения
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_saves_account ON saves(account_id);

-- ---------------------------------------------------------------------------
-- Ежедневные результаты (лучший результат игрока за календарный день)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_results (
  id          TEXT PRIMARY KEY,              -- UUIDv7
  daily_date  TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  faction     TEXT NOT NULL,
  pos         INTEGER NOT NULL,              -- место в гонке (1..4); ниже = лучше
  score       INTEGER NOT NULL,              -- ОЧ (справочно/для runs-совместимости)
  damage      INTEGER NOT NULL DEFAULT 0,    -- нанесённый урон (тай-брейк)
  kills       INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT NOT NULL,                 -- время принятия результата (тай-брейк по времени)
  detail      TEXT,                          -- JSON ResultDetail
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (account_id, daily_date)            -- один (лучший) результат на игрока в день
);

CREATE INDEX IF NOT EXISTS idx_daily_board ON daily_results(daily_date, pos ASC, damage DESC, finished_at ASC);
CREATE INDEX IF NOT EXISTS idx_daily_account ON daily_results(account_id, daily_date);

-- ---------------------------------------------------------------------------
-- PvP: лобби/игры (фаза 2) — контракт server/docs/07-pvp-protocol.md (раздел 6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  id               TEXT PRIMARY KEY,              -- UUIDv7
  lobby_code       TEXT NOT NULL UNIQUE,          -- короткий код лобби (6 символов base32)
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, -- владелец (slot 0)
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')),
  config_json      TEXT NOT NULL,                 -- JSON: turnTimerSeconds, trackKind, trackSize, laps, seed, rejoinWindowSeconds
  state            TEXT,                          -- JSON: каноническое полное состояние движка (все руки/колоды); NULL до старта
  seq              INTEGER NOT NULL DEFAULT 0,    -- монотонный номер состояния на игру
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

CREATE TABLE IF NOT EXISTS game_players (
  game_id         TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  account_id      TEXT REFERENCES accounts(id) ON DELETE CASCADE, -- NULL для bot-слота
  slot            INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 3),
  controller      TEXT NOT NULL DEFAULT 'bot' CHECK (controller IN ('human','bot')),
  faction         TEXT CHECK (faction IN ('chrome','rust','carnival','swarm')),
  joined_at       TEXT NOT NULL,
  disconnected_at TEXT,                          -- когда человек отвалился; NULL = на связи / бот
  PRIMARY KEY (game_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_game_players_account ON game_players(account_id);
