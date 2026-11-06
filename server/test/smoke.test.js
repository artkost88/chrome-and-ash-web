import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { dailyChallenge, dailySeed, dailyFaction, FACTIONS } from '../src/daily.js';

function startServer(db) {
  const app = createApp({ db, config });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function tokenFrom(res) {
  const m = /cna_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  return m ? m[1] : null;
}

function cookieHeader(token) {
  return { cookie: `cna_session=${token}` };
}

async function register(base, username, displayName) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123', displayName }),
  });
  assert.equal(res.status, 201, `register ${username}`);
  const token = tokenFrom(res);
  assert.ok(token, 'session cookie issued');
  return { token, account: (await res.json()).account };
}

test('ежедневный сид детерминирован и валиден', () => {
  const date = '2026-10-24';
  assert.equal(dailySeed(date), dailySeed(date));
  assert.ok(Number.isInteger(dailySeed(date)) && dailySeed(date) >= 0);
  assert.ok(FACTIONS.includes(dailyFaction(date)));
  const a = dailyChallenge(date);
  const b = dailyChallenge(date);
  assert.deepEqual(a, b);
  assert.equal(a.mode, 'daily');
  assert.equal(a.trackKind, 'mosaic');
  assert.equal(a.laps, 1);
});

test('полный поток фазы 1: auth → daily → run → save → result → лидерборд', async (t) => {
  const db = openDb(':memory:');
  const server = await startServer(db);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // --- регистрация и профиль ---
    const a = await register(base, 'driver_a', 'Водила А');
    const meRes = await fetch(`${base}/api/me`, { headers: cookieHeader(a.token) });
    assert.equal(meRes.status, 200);
    const me = await meRes.json();
    assert.equal(me.account.username, 'driver_a');
    assert.equal(me.stats.runsTotal, 0);

    // дубликат имени → 409
    const dup = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'DRIVER_A', password: 'password123' }),
    });
    assert.equal(dup.status, 409);

    // --- ежедневный заезд ---
    const dailyRes = await fetch(`${base}/api/daily`, { headers: cookieHeader(a.token) });
    assert.equal(dailyRes.status, 200);
    const daily = await dailyRes.json();
    assert.equal(daily.challenge.mode, 'daily');
    assert.ok(daily.challenge.seed >= 0);
    assert.equal(daily.myBest, null);

    // --- создание и сохранение заезда ---
    const createRes = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...cookieHeader(a.token) },
      body: JSON.stringify({ mode: 'daily', faction: 'chrome' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.run.mode, 'daily');
    assert.equal(created.run.seed, daily.challenge.seed); // сервер подставил сид дня
    const saveId = created.save.id;
    assert.equal(created.save.revision, 0);

    const state = {
      schemaVersion: 1, engineVersion: '0.1.0', seed: created.run.seed, mode: 'daily',
      raceIndex: 0, stage: 'race', nextUid: 10, savedAt: new Date().toISOString(), engine: {},
    };
    const put1 = await fetch(`${base}/api/save/${saveId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...cookieHeader(a.token) },
      body: JSON.stringify({ revision: 0, state }),
    });
    assert.equal(put1.status, 200);
    assert.equal((await put1.json()).revision, 1);

    // устаревшая версия → 409
    const stale = await fetch(`${base}/api/save/${saveId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...cookieHeader(a.token) },
      body: JSON.stringify({ revision: 0, state }),
    });
    assert.equal(stale.status, 409);

    // --- завершение ---
    const finish = await fetch(`${base}/api/save/${saveId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...cookieHeader(a.token) },
      body: JSON.stringify({
        revision: 1, status: 'finished',
        state: { ...state, stage: 'results', savedAt: new Date().toISOString() },
        result: { score: 15, detail: { pos: 1, finished: true, damage: 5, kills: 1, scrap: 8 } },
      }),
    });
    assert.equal(finish.status, 200);
    const fin = await finish.json();
    assert.equal(fin.finalized, true);
    assert.equal(fin.score, 15);

    // повторный PUT по завершённому заезду → 409 run_finalized
    const redo = await fetch(`${base}/api/save/${saveId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...cookieHeader(a.token) },
      body: JSON.stringify({ revision: 2, state }),
    });
    assert.equal(redo.status, 409);

    // --- ещё игроки для проверки порядка «позиция → урон → время» ---
    const b = await register(base, 'driver_b', 'Водила Б');
    const c = await register(base, 'driver_c', 'Водила В');

    const finishDaily = async (token, detail) => {
      const cr = await fetch(`${base}/api/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...cookieHeader(token) },
        body: JSON.stringify({ mode: 'daily' }),
      });
      assert.equal(cr.status, 201);
      const cj = await cr.json();
      const run = cj.run;
      const saveId2 = cj.save.id;
      const st = {
        schemaVersion: 1, engineVersion: '0.1.0', seed: run.seed, mode: 'daily',
        raceIndex: 0, stage: 'results', nextUid: 10, savedAt: new Date().toISOString(), engine: {},
      };
      const res = await fetch(`${base}/api/save/${saveId2}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...cookieHeader(token) },
        body: JSON.stringify({
          revision: 0, status: 'finished', state: st,
          result: { score: 20, detail },
        }),
      });
      assert.equal(res.status, 200);
    };

    await finishDaily(b.token, { pos: 1, finished: true, damage: 9, kills: 2, scrap: 10 }); // лучше A: тот же pos, больше урона
    await finishDaily(c.token, { pos: 2, finished: true, damage: 20, kills: 5, scrap: 12 }); // pos 2 — ниже всех pos 1

    // --- публичный лидерборд ---
    const lbRes = await fetch(`${base}/api/leaderboard?mode=daily`);
    assert.equal(lbRes.status, 200);
    const lb = await lbRes.json();
    assert.equal(lb.mode, 'daily');
    assert.ok(lb.date);
    const names = lb.rows.map((r) => r.displayName);
    assert.deepEqual(names, ['Водила Б', 'Водила А', 'Водила В'], 'порядок: позиция → урон');
    assert.equal(lb.rows[0].detail.pos, 1);
    assert.equal(lb.rows[0].detail.damage, 9);

    // --- выход из системы ---
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: cookieHeader(a.token) });
    assert.equal(out.status, 204);
    const meAfter = await fetch(`${base}/api/me`, { headers: cookieHeader(a.token) });
    assert.equal(meAfter.status, 401);
  } finally {
    server.close();
    db.close();
  }
});
