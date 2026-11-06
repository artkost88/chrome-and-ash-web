import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, cleanupSessions } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

function startServer(db, cfg) {
  const app = createApp({ db, config: cfg || config });
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function tokenFrom(res) {
  const m = /cna_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  return m ? m[1] : null;
}
function jsonHeaders(token) {
  return Object.assign({ 'content-type': 'application/json' }, token ? { cookie: `cna_session=${token}` } : {});
}
async function register(base, username) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: jsonHeaders(null),
    body: JSON.stringify({ username, password: 'password123', displayName: username }),
  });
  return { status: res.status, token: tokenFrom(res) };
}

test('rate limiting: /api/auth/register по аккаунту → 429', async () => {
  const db = openDb(':memory:');
  const cfg = { ...config, rateLimit: { windowMs: 60000, max: 3, maxPerIp: 100 } };
  const server = await startServer(db, cfg);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await register(base, 'same_user')).status);
    }
    // 1-й 201, 2-й и 3-й 409 (username_taken), 4-й превышает лимит → 429.
    assert.deepEqual(statuses, [201, 409, 409, 429]);
  } finally {
    server.close(); db.close();
  }
});

test('валидация enum: leaderboard и runs отдают 422 на невалидные query', async () => {
  const db = openDb(':memory:');
  const server = await startServer(db);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // публичный leaderboard
    assert.equal((await fetch(base + '/api/leaderboard?mode=bogus')).status, 422);
    assert.equal((await fetch(base + '/api/leaderboard?mode=daily&date=not-a-date')).status, 422);

    const token = (await register(base, 'enum_user')).token;
    const H = jsonHeaders(token);
    assert.equal((await fetch(base + '/api/runs?mode=bogus', { headers: H })).status, 422);
    assert.equal((await fetch(base + '/api/runs?status=bogus', { headers: H })).status, 422);
    assert.equal((await fetch(base + '/api/runs?before=not-a-uuid', { headers: H })).status, 422);
    // валидные значения не ломаются
    assert.equal((await fetch(base + '/api/runs?mode=daily', { headers: H })).status, 200);
  } finally {
    server.close(); db.close();
  }
});

test('строгая валидация SaveState: неизвестные поля/seed/mode/engineVersion/savedAt → 422; большой state → 400', async () => {
  const db = openDb(':memory:');
  const server = await startServer(db);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await register(base, 'strict_user')).token;
    const H = jsonHeaders(token);
    const cr = await fetch(base + '/api/runs', {
      method: 'POST', headers: H, body: JSON.stringify({ mode: 'race', faction: 'rust', seed: 12345 }),
    });
    assert.equal(cr.status, 201);
    const { run, save } = await cr.json();
    const saveId = save.id;

    const goodState = {
      schemaVersion: 1, engineVersion: '0.1.0', seed: run.seed, mode: run.mode,
      raceIndex: 0, stage: 'race', nextUid: 10, savedAt: new Date().toISOString(), engine: {},
    };
    const put = (state, extra = {}) => fetch(base + '/api/save/' + saveId, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ revision: 0, state, ...extra }),
    });

    // Невалидные состояния возвращают 422/400 до коммита (revision не меняется).
    assert.equal((await put({ ...goodState, extra: 1 })).status, 422);       // неизвестное поле
    assert.equal((await put({ ...goodState, seed: 999 })).status, 422);      // seed не совпадает
    assert.equal((await put({ ...goodState, mode: 'daily' })).status, 422);  // mode не совпадает
    assert.equal((await put({ ...goodState, engineVersion: 'v1' })).status, 422); // формат engineVersion
    const noSavedAt = { ...goodState }; delete noSavedAt.savedAt;
    assert.equal((await put(noSavedAt)).status, 422); // отсутствует savedAt

    // большой state (> 256 КБ)
    const big = { ...goodState, engine: { blob: 'x'.repeat(300 * 1024) } };
    assert.equal((await put(big)).status, 400);

    assert.equal((await put(goodState)).status, 200); // базовая строка валидна (revision 0→1)
  } finally {
    server.close(); db.close();
  }
});

test('daily_not_improved: финализация возвращает 200 c notImproved:true, daily_results держит лучший', async () => {
  const db = openDb(':memory:');
  const server = await startServer(db);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await register(base, 'daily_best')).token;
    const H = jsonHeaders(token);

    const createDaily = async () => {
      const res = await fetch(base + '/api/runs', {
        method: 'POST', headers: H, body: JSON.stringify({ mode: 'daily' }),
      });
      assert.equal(res.status, 201);
      return res.json();
    };
    const finish = (run, save, detail) => {
      const state = {
        schemaVersion: 1, engineVersion: '0.1.0', seed: run.seed, mode: run.mode,
        raceIndex: 0, stage: 'results', nextUid: 10, savedAt: new Date().toISOString(), engine: {},
      };
      return fetch(base + '/api/save/' + save.id, {
        method: 'PUT', headers: H,
        body: JSON.stringify({ revision: 0, status: 'finished', state, result: { score: detail.pos === 1 ? 16 : 6, detail } }),
      });
    };

    // первая попытка — лучшая (pos 1)
    const first = await createDaily();
    const f1 = await finish(first.run, first.save, { pos: 1, finished: true, damage: 8, kills: 2, scrap: 10 });
    assert.equal(f1.status, 200);
    assert.equal((await f1.json()).notImproved, false);

    // вторая попытка — хуже (pos 2) → 200 с notImproved:true
    const second = await createDaily();
    const f2 = await finish(second.run, second.save, { pos: 2, finished: true, damage: 20, kills: 5, scrap: 12 });
    assert.equal(f2.status, 200);
    const f2j = await f2.json();
    assert.equal(f2j.finalized, true);
    assert.equal(f2j.notImproved, true);

    // daily_results хранит лучший (pos 1)
    const row = db.prepare('SELECT * FROM daily_results WHERE account_id = ?').get(first.run.accountId);
    assert.equal(row.pos, 1);
    assert.equal(row.run_id, first.run.id);
  } finally {
    server.close(); db.close();
  }
});

test('cleanupSessions: удаляет просроченные и отозванные сессии, оставляет активные', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  // аккаунт для FK
  db.prepare("INSERT INTO accounts (id, username, password_hash, display_name, faction_pref, created_at, updated_at) VALUES ('acc1','a','h','A',NULL,?,?)").run(now, now);
  const ins = db.prepare('INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?)');
  ins.run('s-expired', 'acc1', 'h1', now, past, null);
  ins.run('s-revoked', 'acc1', 'h2', now, future, now);
  ins.run('s-ok', 'acc1', 'h3', now, future, null);

  cleanupSessions(db, now);
  const ids = db.prepare('SELECT id FROM sessions ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, ['s-ok']);
  db.close();
});
