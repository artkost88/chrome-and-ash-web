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
function json(token) { return { 'content-type': 'application/json', cookie: `cna_session=${token}` }; }

async function createLobby(base, token, cfg) {
  const res = await fetch(base + '/api/lobbies', {
    method: 'POST', headers: json(token), body: JSON.stringify(cfg ? { config: cfg } : {}),
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
      drain(type) { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === type) inbox.splice(i, 1); },
      close() { ws.close(); },
    }));
    ws.on('error', reject);
  });
}

async function startSingleHuman(base, token, pvp, cfg) {
  const lobby = await createLobby(base, token, cfg);
  const client = await connectClient(base, token);
  await client.next('hello');
  client.send({ type: 'join_lobby', lobbyCode: lobby.code });
  await client.next('lobby_update');
  await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(token) });
  const gs = await client.next('game_start', 6000);
  const gameId = gs.gameId;
  await client.next('your_turn', 8000);
  client.drain('state');
  client.drain('turn_timeout');
  const live = pvp._internals.liveGames.get(gameId);
  return { lobby, client, gameId, live, game: live.game };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('origin: чужой Origin → close 4003; свой/без Origin → hello', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'origin_a');
    const port = new URL(base).port;

    // чужой Origin → close 4003
    const evil = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example', headers: { Cookie: `cna_session=${a.token}` } });
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    assert.equal(evil, 4003);

    // свой Origin (same-origin) → hello
    const own = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base, headers: { Cookie: `cna_session=${a.token}` } });
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'hello') { resolve(m); ws.close(); } });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no hello (own)')), 3000);
    });
    assert.equal(own.type, 'hello');

    // без Origin → hello
    const none = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `cna_session=${a.token}` } });
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'hello') { resolve(m); ws.close(); } });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no hello (none)')), 3000);
    });
    assert.equal(none.type, 'hello');
  } finally { pvp.dispose(); server.close(); db.close(); }
});

test('error-обработчик: destroy сокета не роняет сервер', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'err_a');
    const client = await connectClient(base, a.token);
    await client.next('hello');
    client.ws.terminate(); // принудительный разрыв (без close handshake)
    await sleep(200);
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally { pvp.dispose(); server.close(); db.close(); }
});

test('normalizeConfig: валидация/кламп turnTimerSeconds, rejoinWindowSeconds, seed', () => {
  const db = openDb(':memory:');
  const pvp = createPvp({ db, config });
  const n = pvp._internals.normalizeConfig;
  assert.equal(n({ turnTimerSeconds: 0 }).turnTimerSeconds, 10);
  assert.equal(n({ turnTimerSeconds: -1 }).turnTimerSeconds, 10);
  assert.equal(n({ turnTimerSeconds: 999 }).turnTimerSeconds, 300);
  assert.equal(n({ turnTimerSeconds: null }).turnTimerSeconds, null);
  assert.equal(n({ turnTimerSeconds: 3.5 }).turnTimerSeconds, 90);
  assert.equal(n({ rejoinWindowSeconds: -5 }).rejoinWindowSeconds, 0);
  assert.equal(n({ rejoinWindowSeconds: 9999 }).rejoinWindowSeconds, 3600);
  assert.equal(n({ seed: 1.5 }).seed, null);
  assert.equal(n({ seed: -3 }).seed, null);
  assert.equal(n({ seed: 42 }).seed, 42);
  db.close();
});

test('ackSeq/clientId: повтор с тем же clientId не применяется дважды', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'dedup_a');
    const { client, game } = await startSingleHuman(base, a.token, pvp, { turnTimerSeconds: null });

    game.cars[0].upgrades = ['turbo'];
    game.cars[0].flags.turboUsed = false;
    game.cars[0].flags.turboArmed = false;

    client.send({ type: 'ability', id: 'turbo', clientId: 'dedup-1' });
    const s1 = await client.next('state');
    const seq1 = s1.seq;
    assert.equal(game.cars[0].flags.turboArmed, true);

    // повтор с тем же clientId → дедуп: тот же seq, без повторного commit
    client.send({ type: 'ability', id: 'turbo', clientId: 'dedup-1' });
    const s2 = await client.next('state');
    assert.equal(s2.seq, seq1, 'дедуп не меняет seq');
    client.close();
  } finally { pvp.dispose(); server.close(); db.close(); }
});

test('гонка close: старый сокет не делает слот ботом, если жив новый', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'race_a');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null });

    const a1 = await connectClient(base, a.token);
    await a1.next('hello');
    a1.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await a1.next('lobby_update');

    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    const gameId = db.prepare('SELECT id FROM games WHERE lobby_code = ?').get(lobby.code).id;

    // второй сокет того же аккаунта заменяет первый
    const a2 = await connectClient(base, a.token);
    await a2.next('hello');
    a2.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await a2.next('state').catch(() => {});

    // старый сокет закрывается
    a1.close();
    await sleep(200);
    const gp = db.prepare('SELECT controller FROM game_players WHERE game_id = ? AND slot = 0').get(gameId);
    assert.equal(gp.controller, 'human', 'старый сокет не сделал слот ботом');
    a2.close();
  } finally { pvp.dispose(); server.close(); db.close(); }
});

test('refresh в waiting: join_lobby восстанавливает controller=human', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'refresh_a');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null });
    const gameId = db.prepare('SELECT id FROM games WHERE lobby_code = ?').get(lobby.code).id;
    // симулируем, что слот почему-то стал bot
    db.prepare("UPDATE game_players SET controller = 'bot' WHERE game_id = ? AND slot = 0").run(gameId);

    const client = await connectClient(base, a.token);
    await client.next('hello');
    client.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await client.next('lobby_update');

    const gp = db.prepare('SELECT controller FROM game_players WHERE game_id = ? AND slot = 0').get(gameId);
    assert.equal(gp.controller, 'human', 'join_lobby в waiting восстановил human');
    client.close();
  } finally { pvp.dispose(); server.close(); db.close(); }
});

test('resume: рестарт-имитация → pump() доигрывает и шлёт your_turn', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'resume_a');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null });
    const aC = await connectClient(base, a.token);
    await aC.next('hello');
    aC.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await aC.next('lobby_update');
    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    await aC.next('game_start', 6000);
    await aC.next('your_turn', 8000);

    // имитируем рестарт: сбрасываем in-memory liveGames
    pvp._internals.liveGames.clear();

    // A переподключается → getOrCreateLive восстановит игру, pump() доиграет и пришлёт your_turn
    const aC2 = await connectClient(base, a.token);
    await aC2.next('hello');
    aC2.send({ type: 'join_lobby', lobbyCode: lobby.code });
    const yt = await aC2.next('your_turn', 8000);
    assert.ok(yt.slot >= 0);
    aC.close(); aC2.close();
  } finally { pvp.dispose(); server.close(); db.close(); }
});

test('финализация: повторный вызов не создаёт дублей runs', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'fin2_a');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null });
    // старт без WS → все слоты играет ИИ → гонка завершается синхронно
    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    const gameId = db.prepare('SELECT id FROM games WHERE lobby_code = ?').get(lobby.code).id;
    const runsBefore = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE account_id = ? AND mode = 'race'").get(a.accountId).c;
    assert.equal(runsBefore, 1);

    // повторный вызов finalizeGame — идемпотентен
    pvp._internals.finalizeGame(gameId);
    const runsAfter = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE account_id = ? AND mode = 'race'").get(a.accountId).c;
    assert.equal(runsAfter, 1, 'нет дублей runs');
  } finally { pvp.dispose(); server.close(); db.close(); }
});
