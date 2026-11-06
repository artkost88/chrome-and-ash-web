import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createPvp } from '../src/pvp.js';
import { config } from '../src/config.js';

function startServer(db) {
  const pvp = createPvp({ db, config });
  const app = createApp({ db, config, pvpRouter: pvp.router });
  const server = http.createServer(app);
  pvp.attach(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, db, pvp, base: `http://127.0.0.1:${server.address().port}` })));
}

async function register(base, username) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123', displayName: username }),
  });
  assert.equal(res.status, 201, `register ${username}`);
  const m = /cna_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  const body = await res.json();
  return { token: m[1], accountId: body.account.id };
}
function auth(token) { return { cookie: `cna_session=${token}` }; }

async function createLobby(base, token, cfg) {
  const res = await fetch(base + '/api/lobbies', {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth(token) },
    body: JSON.stringify({ config: cfg }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).lobby;
}

function connectClient(base, token) {
  return new Promise((resolve, reject) => {
    const port = new URL(base).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `cna_session=${token}` } });
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
      else inbox.push(msg);
    });
    ws.on('open', () => resolve({
      ws,
      send(obj) { ws.send(JSON.stringify(obj)); },
      next(type, timeoutMs = 4000) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { const j = waiters.findIndex((w) => w.type === type); if (j >= 0) waiters.splice(j, 1); rej(new Error('timeout waiting for ' + type)); }, timeoutMs);
          waiters.push({ type, timer, resolve: (m) => res(m) });
        });
      },
      close() { ws.close(); },
    }));
    ws.on('error', reject);
  });
}

test('PvP e2e: вход → лобби → старт → скрытые руки → таймер → финализация → runs + лидерборд', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'e2e_a');
    const b = await register(base, 'e2e_b');

    // 1) A создаёт лобби (таймер 10с), 2) B входит по коду
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: 10 });
    const joinRes = await fetch(base + `/api/lobbies/${lobby.code}/join`, { method: 'POST', headers: auth(b.token) });
    assert.equal(joinRes.status, 200);
    const joined = await joinRes.json();
    assert.equal(joined.lobby.slots.length, 4);
    assert.equal(joined.lobby.slots[1].accountId, b.accountId);

    // 3) оба подключаются по WS
    const aC = await connectClient(base, a.token); await aC.next('hello'); aC.send({ type: 'join_lobby', lobbyCode: lobby.code }); await aC.next('lobby_update');
    const bC = await connectClient(base, b.token); await bC.next('hello'); bC.send({ type: 'join_lobby', lobbyCode: lobby.code }); await bC.next('lobby_update');

    // 4) владелец стартует
    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    const gsA = await aC.next('game_start', 6000);
    const gsB = await bC.next('game_start', 6000);
    assert.equal(gsA.gameId, gsB.gameId);

    // 5) проекция: скрытые руки + свой human-флаг (у каждого — только своя машина human)
    const stA = await aC.next('state', 6000);
    const stB = await bC.next('state', 6000);
    assert.equal(stA.projection.cars[0].human, true, 'A видит свою машину human=true (slot 0)');
    assert.equal(stA.projection.cars[1].human, false, 'A не видит B human=true');
    assert.ok(Array.isArray(stA.projection.cars[0].hand), 'A видит свою руку картами');
    assert.equal(stA.projection.cars[1].hand.hidden, true, 'A видит руку B только длиной');
    assert.equal(typeof stA.projection.cars[1].hand.count, 'number');

    assert.equal(stB.projection.cars[1].human, true, 'B видит свою машину human=true (slot 1)');
    assert.equal(stB.projection.cars[0].human, false, 'B не видит A human=true');
    assert.ok(Array.isArray(stB.projection.cars[1].hand), 'B видит свою руку картами');
    assert.equal(stB.projection.cars[0].hand.hidden, true, 'B видит руку A только длиной');

    // 6) таймер: кто-то из игроков получает your_turn с deadline + turn_timeout
    const yt = await Promise.race([
      aC.next('your_turn', 8000),
      bC.next('your_turn', 8000),
    ]);
    assert.ok(yt.deadline != null, 'your_turn несёт deadline при включённом таймере');
    const tt = await Promise.race([
      aC.next('turn_timeout', 3000),
      bC.next('turn_timeout', 3000),
    ]);
    assert.ok(tt.remainingMs > 0, 'turn_timeout несёт остаток таймера');

    // 7) оба сдаются → боты доигрывают → финализация
    aC.send({ type: 'resign' });
    bC.send({ type: 'resign' });
    const resA = await aC.next('result', 15000);
    assert.ok(Array.isArray(resA.runs));
    await bC.next('result', 15000);

    // 8) у обоих появились runs (mode=race, finished)
    const gameRow = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(lobby.code);
    assert.equal(gameRow.status, 'finished');
    const runsA = db.prepare("SELECT * FROM runs WHERE account_id = ? AND mode = 'race'").all(a.accountId);
    const runsB = db.prepare("SELECT * FROM runs WHERE account_id = ? AND mode = 'race'").all(b.accountId);
    assert.equal(runsA.length, 1);
    assert.equal(runsB.length, 1);
    assert.equal(runsA[0].status, 'finished');
    assert.equal(runsB[0].status, 'finished');
    assert.ok(runsA[0].score >= 0 && runsA[0].damage >= 0 && runsA[0].kills >= 0);
    assert.ok(JSON.parse(runsA[0].result).standings.length === 4);

    // 9) оба в лидерборде race
    const lb = await (await fetch(base + '/api/leaderboard?mode=race')).json();
    const ids = lb.rows.map((r) => r.accountId);
    assert.ok(ids.includes(a.accountId), 'A в лидерборде');
    assert.ok(ids.includes(b.accountId), 'B в лидерборде');

    aC.close(); bC.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});
