import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

/* --- Загружаем логический слой веб-клиента (chrome-and-ash-web/js) --- */
const clientJs = new URL('../../chrome-and-ash-web/js/', import.meta.url);
function loadClient(name) {
  const code = readFileSync(new URL(name, clientJs), 'utf8');
  (0, eval)(code);
}
loadClient('data.js');
loadClient('track.js');
loadClient('engine.js');
loadClient('ai.js');
const CnA = globalThis.CnA;

/* --- Зеркало сериализации клиента (chrome-and-ash-web/js/ui.js) --- */
function toSaveState(game) {
  const { rng, quiet, ...engine } = game;
  return {
    schemaVersion: 1,
    engineVersion: CnA.VERSION,
    seed: game.seed,
    mode: game.mode,
    raceIndex: game.raceIndex,
    stage: game.stage,
    nextUid: CnA.getUidCounter(),
    savedAt: new Date().toISOString(),
    engine,
  };
}
function fromSaveState(s) {
  const game = s.engine;
  game.rng = CnA.mulberry32(s.seed + s.raceIndex * 1013 + 7);
  CnA.setUidCounter(s.nextUid);
  return game;
}
function buildResult(game) {
  const human = game.cars.find((c) => c.human) || game.cars[0];
  const rows = game.results ? game.results.rows : [];
  const row = rows.find((r) => r.carId === human.id) || null;
  const standings = (game.results && game.results.standings)
    ? game.results.standings.map((s) => ({
        place: s.place, faction: s.factionId, name: s.name, cp: s.cp,
        damage: s.damage, kills: s.kills, scrap: s.scrap,
        human: !!(game.cars.find((c) => c.id === s.carId) || {}).human,
      }))
    : [];
  return {
    score: human.cp,
    detail: {
      pos: row ? row.pos : 1,
      finished: row ? !!row.finished : true,
      damage: row ? row.damage : (human.raceDamage || 0),
      kills: row ? row.kills : (human.raceKills || 0),
      scrap: human.scrap,
    },
    standings,
  };
}
function simulate(game) {
  let guard = 0;
  while (!game.race.over && guard++ < 5000) CnA.aiTakeTurn(game);
  return game;
}

/* --- HTTP-помощники --- */
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
function jsonHeaders(token, extra) {
  return Object.assign({ 'content-type': 'application/json' }, token ? cookieHeader(token) : {}, extra || {});
}

test('сквозной сценарий: регистрация → вход → daily → игра → save/load → результат → лидерборд (+ статика)', async () => {
  const db = openDb(':memory:');
  const server = await startServer(db);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1) статический веб-клиент раздаётся на том же origin
    const rootRes = await fetch(base + '/');
    assert.equal(rootRes.status, 200);
    assert.match(await rootRes.text(), /ХРОМ/);
    const cssRes = await fetch(base + '/style.css');
    assert.equal(cssRes.status, 200);
    const jsRes = await fetch(base + '/js/api.js');
    assert.equal(jsRes.status, 200);

    // 2) регистрация (открывает сессию)
    const reg = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: jsonHeaders(null),
      body: JSON.stringify({ username: 'driver1', password: 'password123', displayName: 'Водила' }),
    });
    assert.equal(reg.status, 201);
    const regToken = tokenFrom(reg);
    assert.ok(regToken, 'cookie сессии выдана при регистрации');

    // 3) выход
    const out = await fetch(base + '/api/auth/logout', { method: 'POST', headers: cookieHeader(regToken) });
    assert.equal(out.status, 204);

    // 4) вход
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: jsonHeaders(null),
      body: JSON.stringify({ username: 'driver1', password: 'password123' }),
    });
    assert.equal(login.status, 200);
    const token = tokenFrom(login);
    assert.ok(token, 'cookie сессии выдана при входе');

    // 5) профиль
    const me = await (await fetch(base + '/api/me', { headers: cookieHeader(token) })).json();
    assert.equal(me.account.username, 'driver1');
    assert.equal(me.stats.runsTotal, 0);

    // 6) ежедневный сид
    const daily = await (await fetch(base + '/api/daily', { headers: cookieHeader(token) })).json();
    const ch = daily.challenge;
    assert.equal(ch.mode, 'daily');
    assert.ok(Number.isInteger(ch.seed) && ch.seed >= 0);

    // 7) создать ежедневный заезд
    const create = await fetch(base + '/api/runs', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ mode: 'daily', faction: ch.faction, dailyDate: daily.date }),
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    const saveId = created.save.id;
    assert.equal(created.run.seed, ch.seed, 'сид заезда = сид дня');

    // 8) сыграть несколько ходов против ИИ и сохранить снимок
    CnA.setUidCounter(1);
    const game = CnA.createGame({
      mode: 'race', humanFaction: ch.faction, seed: ch.seed,
      trackKind: ch.trackKind, trackSize: ch.trackSize, laps: ch.laps,
    });
    game.mode = 'daily'; // как в ui.js startNewRun
    let guard = 0;
    while (!game.race.over && guard++ < 6) CnA.aiTakeTurn(game);
    const partial = toSaveState(game);

    const put1 = await fetch(base + '/api/save/' + saveId, {
      method: 'PUT',
      headers: jsonHeaders(token),
      body: JSON.stringify({ revision: 0, state: partial }),
    });
    assert.equal(put1.status, 200);
    assert.equal((await put1.json()).revision, 1);

    // 9) загрузить снимок и восстановить партию
    const got = await (await fetch(base + '/api/save/' + saveId, { headers: cookieHeader(token) })).json();
    assert.equal(got.save.revision, 1);
    assert.ok(got.save.state && got.save.state.engine);
    const restored = fromSaveState(got.save.state);
    assert.equal(restored.seed, ch.seed);
    assert.equal(restored.mode, 'daily');

    // 10) доиграть восстановленную партию до результатов
    simulate(restored);
    assert.ok(restored.results, 'восстановленная партия доигрывается');

    // 11) отправить результат (финализация)
    const result = buildResult(restored);
    assert.ok(Number.isInteger(result.score) && result.score >= 0);
    assert.ok(result.detail.pos >= 1 && result.detail.pos <= 4);

    const fin = await fetch(base + '/api/save/' + saveId, {
      method: 'PUT',
      headers: jsonHeaders(token),
      body: JSON.stringify({ revision: 1, status: 'finished', state: toSaveState(restored), result }),
    });
    assert.equal(fin.status, 200);
    const finJson = await fin.json();
    assert.equal(finJson.finalized, true);
    assert.equal(finJson.score, result.score);

    // 12) лидерборд по сиду
    const lb = await (await fetch(base + '/api/leaderboard?mode=daily')).json();
    assert.equal(lb.mode, 'daily');
    assert.ok(lb.date);
    const row = lb.rows.find((r) => r.accountId === me.account.id);
    assert.ok(row, 'игрок появился в лидерборде');
    assert.equal(row.detail.pos, result.detail.pos);
    assert.equal(row.score, result.score);
    assert.equal(row.displayName, 'Водила');

    // 13) профиль после финализации: статистика обновилась
    const me2 = await (await fetch(base + '/api/me', { headers: cookieHeader(token) })).json();
    assert.equal(me2.stats.runsTotal, 1);
    assert.equal(me2.stats.runsFinished, 1);
    assert.equal(me2.activeRun, null);
  } finally {
    server.close();
    db.close();
  }
});
