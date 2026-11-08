import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { dailyChallenge, today } from './daily.js';
import { prepareLibrarySpec, cleanName } from './track-spec.js';
import { nowIso, utcDateString, uuidv7, sha256Hex, hashPassword, verifyPassword, newSessionToken, dummyVerifyPassword, createRateLimiter } from './util.js';

const USERNAME_RE = /^[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENGINE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_STATE_BYTES = 256 * 1024; // контракт §4.6
const FACTIONS = new Set(['chrome', 'rust', 'carnival', 'swarm']);
const MODES = new Set(['race', 'championship', 'daily']);
const TRACK_KINDS = new Set(['ring', 'mosaic']);
const SAVE_STATUSES = new Set(['active', 'finished']);
const RUN_STATUSES = new Set(['active', 'finished', 'abandoned']);
const STAGES = new Set(['race', 'results', 'shop', 'final']);
const SAVE_STATE_KEYS = ['schemaVersion', 'engineVersion', 'seed', 'mode', 'raceIndex', 'stage', 'nextUid', 'savedAt', 'engine'];
const MAX_TRACKS = 40;
const MAX_TRACK_BYTES = 100 * 1024;
const TRACK_LIST_LIMIT = 100;
const TRACK_NAME_MAX = 40;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

/* ------------------------------------------------------------------ */
/* Чистые помощники                                                    */
/* ------------------------------------------------------------------ */
function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validDateQuery(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function err(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}

function accountJson(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    factionPref: row.faction_pref ?? null,
    createdAt: row.created_at,
  };
}

function runJson(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    mode: row.mode,
    dailyDate: row.daily_date ?? null,
    faction: row.faction,
    trackKind: row.track_kind,
    trackSize: row.track_size,
    laps: row.laps,
    seed: row.seed,
    status: row.status,
    score: row.score ?? null,
    damage: row.damage ?? null,
    kills: row.kills ?? null,
    result: row.result ? safeJson(row.result) : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}

function runSummaryJson(row) {
  const r = runJson(row);
  delete r.result;
  return r;
}

function saveRefJson(row) {
  return { id: row.id, runId: row.run_id, revision: row.revision, status: row.status, updatedAt: row.updated_at };
}

function saveJson(row) {
  return { ...saveRefJson(row), state: row.state ? safeJson(row.state) : null };
}

/* --- Stage C: track library helpers --- */
function cleanTrackName(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/<[^>]*>/g, '').trim();
  if (!stripped || stripped.length > TRACK_NAME_MAX) return null;
  const cleaned = cleanName(stripped);
  if (!cleaned || cleaned.length > TRACK_NAME_MAX) return null;
  return cleaned;
}

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Infinity; }
}

function validateTrackBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, code: 'invalid_request', message: 'Требуется объект {name,spec}' };
  }
  const name = cleanTrackName(body.name);
  if (!name) return { status: 422, code: 'invalid_name', message: 'Имя трассы: 1–40 символов после очистки' };
  const rawBytes = jsonBytes(body.spec);
  if (rawBytes > MAX_TRACK_BYTES) {
    return { status: 413, code: 'payload_too_large', message: 'spec больше 100 КБ' };
  }
  const prepared = prepareLibrarySpec(body.spec);
  if (!prepared.ok) {
    return {
      status: 422,
      code: 'invalid_track',
      message: 'TrackSpec не прошёл серверную валидацию',
      details: { issues: (prepared.issues || []).slice(0, 6).map((i) => ({ code: i.code, nodeId: i.nodeId })) },
    };
  }
  const canonical = prepared.spec;
  if (jsonBytes(canonical) > MAX_TRACK_BYTES) {
    return { status: 413, code: 'payload_too_large', message: 'spec больше 100 КБ после нормализации' };
  }
  return { ok: true, name, spec: canonical };
}

function trackJson(row) {
  const spec = safeJson(row.spec_json);
  return {
    id: row.id,
    name: row.name,
    spec,
    specSchema: row.spec_schema,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function trackSummaryJson(row) {
  const spec = safeJson(row.spec_json) || {};
  return {
    id: row.id,
    name: row.name,
    size: spec.size ?? null,
    archetype: spec.archetype ?? null,
    revision: row.revision,
    updatedAt: row.updated_at,
    share: {
      active: !!row.share_created_at,
      updatedAt: row.share_updated_at ?? null,
    },
  };
}

function encodeTrackCursor(row) {
  return Buffer.from(JSON.stringify([row.updated_at, row.id]), 'utf8').toString('base64url');
}

function decodeTrackCursor(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    if (typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch { return null; }
}

function trackShareJson(share) {
  return share
    ? { active: true, createdAt: share.created_at, updatedAt: share.updated_at }
    : { active: false, createdAt: null, updatedAt: null };
}

function detailFromResult(resultJson, row) {
  const obj = resultJson ? safeJson(resultJson) : null;
  if (obj && obj.detail) return obj.detail;
  return { pos: 0, finished: true, damage: row.damage ?? 0, kills: row.kills ?? 0, scrap: 0 };
}

function isValidIsoTimestamp(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function validateSaveState(state, run) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'state должен быть объектом';
  for (const k of Object.keys(state)) {
    if (!SAVE_STATE_KEYS.includes(k)) return 'state содержит неизвестное поле: ' + k;
  }
  if (state.schemaVersion !== 1) return 'state.schemaVersion должен быть 1';
  if (typeof state.engineVersion !== 'string' || !ENGINE_VERSION_RE.test(state.engineVersion)) return 'state.engineVersion должен быть формата x.y.z';
  if (!Number.isInteger(state.seed) || state.seed < 0) return 'state.seed обязателен (неотрицательное целое)';
  if (!MODES.has(state.mode)) return 'state.mode некорректен';
  if (!Number.isInteger(state.raceIndex) || state.raceIndex < 0) return 'state.raceIndex обязателен';
  if (!STAGES.has(state.stage)) return 'state.stage некорректен';
  if (!Number.isInteger(state.nextUid) || state.nextUid < 1) return 'state.nextUid обязателен (>= 1)';
  if (!isValidIsoTimestamp(state.savedAt)) return 'state.savedAt обязателен (ISO-8601)';
  if (!state.engine || typeof state.engine !== 'object' || Array.isArray(state.engine)) return 'state.engine обязателен';
  if (run) {
    if (state.mode !== run.mode) return 'state.mode не совпадает с заездом';
    if (state.seed !== run.seed) return 'state.seed не совпадает с заездом';
  }
  return null;
}

function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'result обязателен при status=finished';
  if (!Number.isInteger(result.score) || result.score < 0) return 'result.score обязателен (неотрицательное целое)';
  const d = result.detail;
  if (!d || typeof d !== 'object') return 'result.detail обязателен';
  if (!Number.isInteger(d.pos) || d.pos < 1 || d.pos > 4) return 'result.detail.pos обязателен (1..4)';
  if (typeof d.finished !== 'boolean') return 'result.detail.finished обязателен';
  if (!Number.isInteger(d.damage) || d.damage < 0) return 'result.detail.damage обязателен';
  if (!Number.isInteger(d.kills) || d.kills < 0) return 'result.detail.kills обязателен';
  if (!Number.isInteger(d.scrap) || d.scrap < 0) return 'result.detail.scrap обязателен';
  return null;
}

/* ------------------------------------------------------------------ */
/* Фабрика приложения                                                  */
/* ------------------------------------------------------------------ */
export function createApp({ db, config, pvpRouter }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  /* --- rate limiting (in-memory, без зависимостей) --- */
  const rl = config.rateLimit || { windowMs: 10 * 60 * 1000, max: 10, maxPerIp: 30 };
  const byIpLimiter = createRateLimiter({ windowMs: rl.windowMs, max: rl.maxPerIp });
  const byAccountLimiter = createRateLimiter({ windowMs: rl.windowMs, max: rl.max });

  function authRateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    if (!byIpLimiter.allow(ip)) {
      return err(res, 429, 'rate_limited', 'Слишком много запросов. Попробуйте позже.');
    }
    const username = (req.body && typeof req.body.username === 'string') ? req.body.username.toLowerCase() : '';
    if (username && !byAccountLimiter.allow(ip + '|' + username)) {
      return err(res, 429, 'rate_limited', 'Слишком много попыток для этого имени.');
    }
    next();
  }

  /* Stage C: separate buckets for the authenticated library and public shares. */
  const libraryLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });
  const shareIpLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
  const shareFailLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

  function trackLibraryRateLimit(req, res, next) {
    if (!libraryLimiter.allow(req.account.id)) {
      return err(res, 429, 'rate_limited', 'Слишком много запросов к библиотеке.');
    }
    next();
  }

  /* --- cookie/session helpers --- */
  function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === name) {
        const raw = part.slice(eq + 1).trim();
        try { return decodeURIComponent(raw); } catch { return raw; }
      }
    }
    return undefined;
  }

  function cookieFlags(maxAgeSeconds) {
    const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`];
    if (config.isProd) flags.push('Secure');
    return flags.join('; ');
  }

  function setSessionCookie(res, token) {
    res.setHeader('Set-Cookie', `cna_session=${token}; ${cookieFlags(config.sessionTtlDays * 86400)}`);
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `cna_session=; ${cookieFlags(0)}`);
  }

  function createSession(req, accountId) {
    const { token, tokenHash } = newSessionToken();
    const created = nowIso();
    const expires = new Date(Date.now() + config.sessionTtlDays * 86400000).toISOString();
    db.prepare(
      'INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at, revoked_at, user_agent, ip) VALUES (?,?,?,?,?,NULL,?,?)'
    ).run(uuidv7(), accountId, tokenHash, created, expires, req.headers['user-agent'] || null, req.ip || null);
    return { token, expires };
  }

  function requireAuth(req, res, next) {
    const token = getCookie(req, 'cna_session');
    if (!token) return err(res, 401, 'unauthorized', 'Требуется вход');
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256Hex(token));
    if (!session || session.revoked_at) return err(res, 401, 'unauthorized', 'Сессия недействительна');
    if (session.expires_at < nowIso()) return err(res, 401, 'unauthorized', 'Сессия истекла');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(session.account_id);
    if (!account) return err(res, 401, 'unauthorized', 'Аккаунт не найден');
    req.account = account;
    req.session = session;
    next();
  }

  /* --- leaderboard helpers --- */
  function leaderboardRow(r, rank) {
    return {
      rank,
      accountId: r.account_id,
      displayName: r.display_name,
      faction: r.faction,
      score: r.score,
      detail: r.detail ? safeJson(r.detail) : { pos: r.pos, finished: true, damage: r.damage, kills: r.kills, scrap: 0 },
      runId: r.run_id,
      at: r.finished_at,
    };
  }

  function dailyBoard(date, limit, offset) {
    const rows = db.prepare(`
      SELECT d.*, a.display_name
      FROM daily_results d
      JOIN accounts a ON a.id = d.account_id
      WHERE d.daily_date = ?
      ORDER BY d.pos ASC, d.damage DESC, d.finished_at ASC
      LIMIT ? OFFSET ?`).all(date, limit, offset);
    return rows.map((r, i) => leaderboardRow(r, offset + i + 1));
  }

  /* --- health --- */
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'chrome-and-ash-server', time: nowIso() });
  });

  /* --- auth --- */
  app.post('/api/auth/register', authRateLimit, (req, res) => {
    const b = req.body || {};
    const username = b.username;
    const password = b.password;
    if (typeof username !== 'string' || !USERNAME_RE.test(username) || username.length < 3 || username.length > 32) {
      return err(res, 400, 'invalid_request', 'Недопустимое имя пользователя (3–32 символа, A-Za-z0-9_.-)');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return err(res, 422, 'weak_password', 'Пароль должен быть от 8 до 128 символов');
    }
    const displayName = (typeof b.displayName === 'string' && b.displayName.trim()) ? b.displayName.trim() : username;
    if (displayName.length > 32) return err(res, 400, 'invalid_request', 'displayName не длиннее 32 символов');

    if (db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(username)) {
      return err(res, 409, 'username_taken', 'Имя пользователя занято');
    }

    const id = uuidv7();
    const now = nowIso();
    db.prepare(
      'INSERT INTO accounts (id, username, password_hash, display_name, faction_pref, created_at, updated_at, last_login_at) VALUES (?,?,?,?,NULL,?,?,?)'
    ).run(id, username, hashPassword(password, config.pepper), displayName, now, now, now);

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    const session = createSession(req, id);
    setSessionCookie(res, session.token);
    res.status(201).json({ account: accountJson(account), sessionExpiresAt: session.expires });
  });

  app.post('/api/auth/login', authRateLimit, (req, res) => {
    const b = req.body || {};
    if (typeof b.username !== 'string' || typeof b.password !== 'string') {
      return err(res, 400, 'invalid_request', 'Требуются username и password');
    }
    const account = db.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE').get(b.username);
    // Одинаковый ответ и одинаковая стоимость на «нет аккаунта» и «неверный пароль» —
    // против перечисления имён: для несуществующего аккаунта прогоняем dummy-scrypt той же цены.
    if (!account) {
      dummyVerifyPassword(b.password, config.pepper);
      return err(res, 401, 'invalid_credentials', 'Неверное имя или пароль');
    }
    if (!verifyPassword(b.password, account.password_hash, config.pepper)) {
      return err(res, 401, 'invalid_credentials', 'Неверное имя или пароль');
    }
    const now = nowIso();
    db.prepare('UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, account.id);
    const session = createSession(req, account.id);
    setSessionCookie(res, session.token);
    res.json({ account: accountJson(account), sessionExpiresAt: session.expires });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), req.session.id);
    clearSessionCookie(res);
    res.status(204).end();
  });

  /* --- профиль --- */
  app.get('/api/me', requireAuth, (req, res) => {
    const acc = req.account;
    const stats = {
      runsTotal: db.prepare('SELECT COUNT(*) AS c FROM runs WHERE account_id = ?').get(acc.id).c,
      runsFinished: db.prepare("SELECT COUNT(*) AS c FROM runs WHERE account_id = ? AND status = 'finished'").get(acc.id).c,
      raceBest: db.prepare("SELECT MAX(score) AS s FROM runs WHERE account_id = ? AND mode = 'race' AND status = 'finished'").get(acc.id).s ?? null,
      championshipBest: db.prepare("SELECT MAX(score) AS s FROM runs WHERE account_id = ? AND mode = 'championship' AND status = 'finished'").get(acc.id).s ?? null,
      dailyBest: db.prepare('SELECT MAX(score) AS s FROM daily_results WHERE account_id = ?').get(acc.id).s ?? null,
    };
    const activeRun = db.prepare("SELECT * FROM runs WHERE account_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(acc.id) || null;
    let activeSave = null;
    if (activeRun) {
      const s = db.prepare('SELECT * FROM saves WHERE run_id = ? ORDER BY slot ASC LIMIT 1').get(activeRun.id) || null;
      if (s) activeSave = saveRefJson(s);
    }
    res.json({ account: accountJson(acc), stats, activeRun: activeRun ? runJson(activeRun) : null, activeSave });
  });

  /* --- ежедневный заезд --- */
  app.get('/api/daily', requireAuth, (req, res) => {
    if (req.query.date !== undefined && !validDateQuery(req.query.date)) {
      return err(res, 422, 'invalid_enum', 'date должен быть YYYY-MM-DD');
    }
    const date = validDateQuery(req.query.date) || today();
    const challenge = dailyChallenge(date);
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const my = db.prepare('SELECT * FROM daily_results WHERE account_id = ? AND daily_date = ?').get(req.account.id, date);
    res.json({
      date,
      challenge,
      myBest: my
        ? { score: my.score, runId: my.run_id, detail: my.detail ? safeJson(my.detail) : null, updatedAt: my.updated_at }
        : null,
      board: dailyBoard(date, limit, 0),
    });
  });

  /* --- заезды --- */
  app.post('/api/runs', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!MODES.has(b.mode)) return err(res, 422, 'invalid_enum', 'mode должен быть race|championship|daily');

    let faction, trackKind, trackSize, laps, seed, dailyDate = null;

    if (b.mode === 'daily') {
      const date = validDateQuery(b.dailyDate) || today();
      const ch = dailyChallenge(date);
      faction = ch.faction; trackKind = ch.trackKind; trackSize = ch.trackSize; laps = ch.laps; seed = ch.seed; dailyDate = date;
    } else {
      if (b.dailyDate != null) return err(res, 422, 'invalid_enum', 'dailyDate допустим только для mode=daily');
      if (!FACTIONS.has(b.faction)) return err(res, 422, 'invalid_enum', 'Недопустимая фракция');
      faction = b.faction;
      trackKind = TRACK_KINDS.has(b.trackKind) ? b.trackKind : 'mosaic';
      trackSize = Number.isInteger(b.trackSize) && b.trackSize >= 24 && b.trackSize <= 36 ? b.trackSize : (trackKind === 'ring' ? 28 : 36);
      laps = b.laps === 2 ? 2 : 1;
      if (b.seed !== undefined && b.seed !== null) {
        if (!Number.isInteger(b.seed) || b.seed < 0) return err(res, 422, 'invalid_enum', 'seed должен быть неотрицательным целым');
        seed = b.seed;
      } else {
        seed = Math.floor(Math.random() * 1000000000);
      }
    }

    const accountId = req.account.id;
    // Один активный заезд: предыдущий помечаем abandoned.
    db.prepare("UPDATE runs SET status = 'abandoned' WHERE account_id = ? AND status = 'active'").run(accountId);

    const runId = uuidv7();
    const now = nowIso();
    db.prepare(
      `INSERT INTO runs (id, account_id, mode, daily_date, faction, track_kind, track_size, laps, seed, status, score, damage, kills, result, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,'active',NULL,NULL,NULL,NULL,?,NULL)`
    ).run(runId, accountId, b.mode, dailyDate, faction, trackKind, trackSize, laps, seed, now);

    const saveId = uuidv7();
    db.prepare(
      "INSERT INTO saves (id, run_id, account_id, slot, revision, state, status, created_at, updated_at) VALUES (?,?,?,0,0,NULL,'active',?,?)"
    ).run(saveId, runId, accountId, now, now);

    res.status(201).json({
      run: runJson(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)),
      save: saveRefJson(db.prepare('SELECT * FROM saves WHERE id = ?').get(saveId)),
    });
  });

  app.get('/api/runs', requireAuth, (req, res) => {
    const limit = clampInt(req.query.limit, 1, 100, 20);
    if (req.query.mode !== undefined && !MODES.has(req.query.mode)) {
      return err(res, 422, 'invalid_enum', 'mode должен быть race|championship|daily');
    }
    if (req.query.status !== undefined && !RUN_STATUSES.has(req.query.status)) {
      return err(res, 422, 'invalid_enum', 'status должен быть active|finished|abandoned');
    }
    if (req.query.before !== undefined && !UUID_RE.test(req.query.before)) {
      return err(res, 422, 'invalid_enum', 'before должен быть корректным id');
    }
    const conds = ['account_id = ?'];
    const params = [req.account.id];
    if (req.query.mode) { conds.push('mode = ?'); params.push(req.query.mode); }
    if (req.query.status) { conds.push('status = ?'); params.push(req.query.status); }
    if (req.query.before) { conds.push('id < ?'); params.push(req.query.before); }
    const rows = db.prepare(`SELECT * FROM runs WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({ runs: page.map(runSummaryJson), nextCursor: hasMore ? page[page.length - 1].id : null });
  });

  /* --- сохранения --- */
  function loadOwnedSave(req, res) {
    const save = db.prepare('SELECT * FROM saves WHERE id = ?').get(req.params.id);
    if (!save) { err(res, 404, 'not_found', 'Сохранение не найдено'); return null; }
    if (save.account_id !== req.account.id) { err(res, 403, 'forbidden', 'Чужое сохранение'); return null; }
    return save;
  }

  app.get('/api/save/:id', requireAuth, (req, res) => {
    const save = loadOwnedSave(req, res);
    if (!save) return;
    res.json({ save: saveJson(save) });
  });

  app.put('/api/save/:id', requireAuth, (req, res) => {
    const save = loadOwnedSave(req, res);
    if (!save) return;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(save.run_id);
    if (!run) return err(res, 404, 'not_found', 'Заезд не найден');
    if (run.status !== 'active') return err(res, 409, 'run_finalized', 'Заезд уже завершён или отменён');

    const b = req.body || {};
    if (!Number.isInteger(b.revision) || b.revision < 0) return err(res, 400, 'invalid_request', 'revision обязателен');
    if (b.revision !== save.revision) return err(res, 409, 'stale_revision', 'Устаревшая версия сохранения');

    let stateSize = 0;
    if (b.state != null) {
      try { stateSize = Buffer.byteLength(JSON.stringify(b.state), 'utf8'); } catch { stateSize = 0; }
    }
    if (stateSize > MAX_STATE_BYTES) return err(res, 400, 'invalid_request', 'state больше 256 КБ');

    const stateErr = validateSaveState(b.state, run);
    if (stateErr) return err(res, 422, 'invalid_request', stateErr);

    const status = b.status || 'active';
    if (!SAVE_STATUSES.has(status)) return err(res, 422, 'invalid_enum', 'status должен быть active|finished');

    let finalized = false;
    let score = null;
    let dailyNotImproved = false;

    if (status === 'finished') {
      const resultErr = validateResult(b.result);
      if (resultErr) return err(res, 422, 'invalid_request', resultErr);
      if (b.state.stage !== 'results' && b.state.stage !== 'final') {
        return err(res, 422, 'invalid_request', 'status=finished требует state.stage = results|final');
      }
      score = b.result.score;
      db.prepare(
        "UPDATE runs SET status = 'finished', score = ?, damage = ?, kills = ?, result = ?, finished_at = ? WHERE id = ?"
      ).run(score, b.result.detail.damage, b.result.detail.kills, JSON.stringify(b.result), nowIso(), run.id);

      if (run.mode === 'daily') {
        const date = run.daily_date;
        const current = db.prepare('SELECT * FROM daily_results WHERE account_id = ? AND daily_date = ?').get(run.account_id, date);
        const cand = { pos: b.result.detail.pos, damage: b.result.detail.damage };
        const improved = !current || cand.pos < current.pos || (cand.pos === current.pos && cand.damage > current.damage);
        if (improved) {
          const now = nowIso();
          if (current) {
            db.prepare(
              `UPDATE daily_results SET run_id = ?, faction = ?, pos = ?, score = ?, damage = ?, kills = ?, finished_at = ?, detail = ?, updated_at = ? WHERE id = ?`
            ).run(run.id, run.faction, cand.pos, score, cand.damage, b.result.detail.kills, now, JSON.stringify(b.result.detail), now, current.id);
          } else {
            db.prepare(
              `INSERT INTO daily_results (id, daily_date, account_id, run_id, faction, pos, score, damage, kills, finished_at, detail, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(uuidv7(), date, run.account_id, run.id, run.faction, cand.pos, score, cand.damage, b.result.detail.kills, now, JSON.stringify(b.result.detail), now, now);
          }
        } else {
          dailyNotImproved = true;
        }
      }
      finalized = true;
    }

    const newRevision = save.revision + 1;
    db.prepare('UPDATE saves SET revision = ?, state = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(newRevision, JSON.stringify(b.state), status, nowIso(), save.id);

    const updatedRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
    res.json({
      saved: true,
      revision: newRevision,
      finalized,
      score,
      notImproved: dailyNotImproved,
      run: { id: updatedRun.id, status: updatedRun.status, score: updatedRun.score ?? null, finishedAt: updatedRun.finished_at ?? null },
    });
  });

  app.delete('/api/save/:id', requireAuth, (req, res) => {
    const save = loadOwnedSave(req, res);
    if (!save) return;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(save.run_id);
    if (run && run.status === 'finished') return err(res, 409, 'run_finalized', 'Заезд уже завершён');
    if (run && run.status === 'active') db.prepare("UPDATE runs SET status = 'abandoned' WHERE id = ?").run(run.id);
    res.status(204).end();
  });

  /* --- лидерборд --- */
  app.get('/api/leaderboard', (req, res) => {
    if (req.query.mode !== undefined && !MODES.has(req.query.mode)) {
      return err(res, 422, 'invalid_enum', 'mode должен быть daily|race|championship');
    }
    const mode = req.query.mode || 'daily';
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query.offset, 0, 1000000, 0);

    if (mode === 'daily') {
      if (req.query.date !== undefined && !validDateQuery(req.query.date)) {
        return err(res, 422, 'invalid_enum', 'date должен быть YYYY-MM-DD');
      }
      const date = validDateQuery(req.query.date) || today();
      return res.json({ mode, date, rows: dailyBoard(date, limit, offset) });
    }

    const rows = db.prepare(`
      SELECT r.id AS run_id, r.account_id, a.display_name, r.faction, r.score, r.damage, r.kills, r.finished_at, r.result
      FROM runs r
      JOIN accounts a ON a.id = r.account_id
      WHERE r.mode = ? AND r.status = 'finished'
        AND r.id = (
          SELECT r2.id FROM runs r2
          WHERE r2.account_id = r.account_id AND r2.mode = r.mode AND r2.status = 'finished'
          ORDER BY r2.score DESC, r2.damage DESC, r2.finished_at ASC, r2.id ASC
          LIMIT 1
        )
      ORDER BY r.score DESC, r.damage DESC, r.finished_at ASC, r.id ASC
      LIMIT ? OFFSET ?`).all(mode, limit, offset);

    const out = rows.map((r, i) => ({
      rank: offset + i + 1,
      accountId: r.account_id,
      displayName: r.display_name,
      faction: r.faction,
      score: r.score ?? 0,
      detail: detailFromResult(r.result, r),
      runId: r.run_id,
      at: r.finished_at,
    }));
    res.json({ mode, date: null, rows: out });
  });

  /* --- Stage C: библиотека трасс и unlisted share-ссылки --- */
  function loadOwnedTrack(req, res) {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) { err(res, 404, 'not_found', 'Трасса не найдена'); return null; }
    const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    if (!row || row.account_id !== req.account.id) {
      err(res, 404, 'not_found', 'Трасса не найдена');
      return null;
    }
    return row;
  }

  app.get('/api/tracks', requireAuth, trackLibraryRateLimit, (req, res) => {
    const limit = clampInt(req.query.limit, 1, TRACK_LIST_LIMIT, 50);
    let cursor = null;
    if (req.query.cursor !== undefined) {
      cursor = decodeTrackCursor(req.query.cursor);
      if (!cursor) return err(res, 422, 'invalid_cursor', 'Некорректный cursor');
    }
    const conds = ['t.account_id = ?'];
    const params = [req.account.id];
    if (cursor) {
      conds.push('(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))');
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = db.prepare(`
      SELECT t.*, s.created_at AS share_created_at, s.updated_at AS share_updated_at
      FROM tracks t
      LEFT JOIN track_shares s ON s.track_id = t.id
      WHERE ${conds.join(' AND ')}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      tracks: page.map(trackSummaryJson),
      nextCursor: hasMore && page.length ? encodeTrackCursor(page[page.length - 1]) : null,
    });
  });

  app.post('/api/tracks', requireAuth, trackLibraryRateLimit, (req, res) => {
    const v = validateTrackBody(req.body);
    if (!v.ok) return err(res, v.status, v.code, v.message, v.details);
    const now = nowIso();
    const id = uuidv7();
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = db.prepare('SELECT COUNT(*) AS c FROM tracks WHERE account_id = ?').get(req.account.id).c;
      if (count >= MAX_TRACKS) {
        db.exec('ROLLBACK');
        return err(res, 422, 'quota_exceeded', 'Лимит библиотеки: ' + MAX_TRACKS + ' трасс');
      }
      db.prepare('INSERT INTO tracks (id, account_id, name, spec_json, spec_schema, revision, created_at, updated_at) VALUES (?,?,?,?,1,0,?,?)')
        .run(id, req.account.id, v.name, JSON.stringify(v.spec), now, now);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    res.status(201).json({ track: trackJson(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)) });
  });

  app.get('/api/tracks/:id', requireAuth, trackLibraryRateLimit, (req, res) => {
    const row = loadOwnedTrack(req, res);
    if (!row) return;
    res.json({ track: trackJson(row) });
  });

  app.put('/api/tracks/:id', requireAuth, trackLibraryRateLimit, (req, res) => {
    const row = loadOwnedTrack(req, res);
    if (!row) return;
    const b = req.body || {};
    if (!Number.isInteger(b.revision) || b.revision < 0) {
      return err(res, 400, 'invalid_request', 'revision обязателен (неотрицательное целое)');
    }
    if (b.revision !== row.revision) return err(res, 409, 'stale_revision', 'Устаревшая версия трассы');
    const v = validateTrackBody(b);
    if (!v.ok) return err(res, v.status, v.code, v.message, v.details);
    const updatedAt = nowIso();
    const result = db.prepare(
      'UPDATE tracks SET name = ?, spec_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND account_id = ? AND revision = ?'
    ).run(v.name, JSON.stringify(v.spec), updatedAt, row.id, req.account.id, row.revision);
    if (result.changes !== 1) return err(res, 409, 'stale_revision', 'Устаревшая версия трассы');
    res.json({ track: trackJson(db.prepare('SELECT * FROM tracks WHERE id = ?').get(row.id)) });
  });

  app.delete('/api/tracks/:id', requireAuth, trackLibraryRateLimit, (req, res) => {
    const row = loadOwnedTrack(req, res);
    if (!row) return;
    db.prepare('DELETE FROM tracks WHERE id = ? AND account_id = ?').run(row.id, req.account.id);
    res.status(204).end();
  });

  app.get('/api/tracks/:id/share', requireAuth, trackLibraryRateLimit, (req, res) => {
    const row = loadOwnedTrack(req, res);
    if (!row) return;
    const share = db.prepare('SELECT * FROM track_shares WHERE track_id = ?').get(row.id) || null;
    res.json({ share: trackShareJson(share) });
  });

  app.post('/api/tracks/:id/share', requireAuth, trackLibraryRateLimit, (req, res) => {
    const row = loadOwnedTrack(req, res);
    if (!row) return;
    const existing = db.prepare('SELECT id FROM track_shares WHERE track_id = ?').get(row.id) || null;
    const token = crypto.randomBytes(32).toString('base64url');
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM track_shares WHERE track_id = ?').run(row.id);
      db.prepare('INSERT INTO track_shares (id, track_id, token_hash, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(uuidv7(), row.id, sha256Hex(token), now, now);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    res.status(existing ? 200 : 201).json({ share: { token, url: '/?track=' + token } });
  });

  app.delete('/api/tracks/:id/share', requireAuth, trackLibraryRateLimit, (req, res) => {
    const row = loadOwnedTrack(req, res);
    if (!row) return;
    db.prepare('DELETE FROM track_shares WHERE track_id = ?').run(row.id);
    res.status(204).end();
  });

  app.get('/api/share/:token', (req, res) => {
    const ip = req.ip || 'unknown';
    if (!shareIpLimiter.allow(ip)) return err(res, 429, 'rate_limited', 'Слишком много запросов к ссылкам.');
    const token = String(req.params.token || '');
    if (!SHARE_TOKEN_RE.test(token)) {
      if (!shareFailLimiter.allow(ip + '|' + sha256Hex(token))) {
        return err(res, 429, 'rate_limited', 'Слишком много неверных ссылок.');
      }
      return err(res, 404, 'not_found', 'Ссылка не найдена');
    }
    const row = db.prepare(`
      SELECT t.name, t.spec_json, t.updated_at, a.display_name
      FROM track_shares s
      JOIN tracks t ON t.id = s.track_id
      JOIN accounts a ON a.id = t.account_id
      WHERE s.token_hash = ?`).get(sha256Hex(token));
    if (!row) {
      if (!shareFailLimiter.allow(ip + '|' + sha256Hex(token))) {
        return err(res, 429, 'rate_limited', 'Слишком много неверных ссылок.');
      }
      return err(res, 404, 'not_found', 'Ссылка не найдена');
    }
    const stored = safeJson(row.spec_json);
    const prepared = prepareLibrarySpec(stored);
    if (!prepared.ok) {
      console.warn('[cna] share: сохранённый TrackSpec не прошёл валидацию', row.name);
      return err(res, 404, 'not_found', 'Ссылка не найдена');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.json({
      track: {
        name: row.name,
        spec: prepared.spec,
        author: { displayName: row.display_name },
        updatedAt: row.updated_at,
      },
    });
  });

  /* --- PvP (фаза 2): лобби REST, монтируется до статики и 404 --- */
  if (pvpRouter) app.use(pvpRouter);

  /* --- share shell (`/?track=<token>`) не кэшируется и не индексируется --- */
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.path === '/' && typeof req.query.track === 'string') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    next();
  });

  /* --- статический веб-клиент (t7) --- */
  if (config.clientDir && fs.existsSync(config.clientDir)) {
    app.use(express.static(config.clientDir));
  }

  /* --- 404 и ошибки --- */
  app.use((req, res) => err(res, 404, 'not_found', 'Не найдено'));
  app.use((error, req, res, next) => {
    if (error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError)) {
      return err(res, 400, 'invalid_request', 'Некорректный JSON');
    }
    if (error && error.type === 'entity.too.large') {
      return err(res, 400, 'invalid_request', 'Тело запроса слишком большое');
    }
    console.error(error);
    return err(res, 500, 'internal', 'Внутренняя ошибка сервера');
  });

  return app;
}

export { utcDateString };
