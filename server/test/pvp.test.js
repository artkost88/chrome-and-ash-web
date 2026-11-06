import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createPvp, projectionFor, toEngineState } from '../src/pvp.js';
import { CnA } from '../src/engine.js';
import { config } from '../src/config.js';

function startServer(db) {
  const pvp = createPvp({ db, config });
  const app = createApp({ db, config, pvpRouter: pvp.router });
  const server = http.createServer(app);
  pvp.attach(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, db, pvp, base: `http://127.0.0.1:${server.address().port}` }));
  });
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
function json(token) { return { 'content-type': 'application/json', cookie: `cna_session=${token}` }; }
function auth(token) { return { cookie: `cna_session=${token}` }; }

async function createLobby(base, token, config) {
  const res = await fetch(base + '/api/lobbies', {
    method: 'POST', headers: json(token), body: JSON.stringify(config ? { config } : {}),
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
      drain(type) {
        for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === type) inbox.splice(i, 1);
      },
      close() { ws.close(); },
    }));
    ws.on('error', reject);
  });
}

test('лобби-жизненный цикл: create → get → join → start → статусы', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'pvp_a');
    const b = await register(base, 'pvp_b');

    const lobby = await createLobby(base, a.token, { turnTimerSeconds: 90, rejoinWindowSeconds: 300 });
    assert.match(lobby.code, /^[A-Z2-9]{6}$/);
    assert.equal(lobby.status, 'waiting');
    assert.equal(lobby.slots.length, 4);
    assert.equal(lobby.slots[0].controller, 'human');
    assert.equal(lobby.slots[0].accountId, a.accountId);

    const got = await (await fetch(base + `/api/lobbies/${lobby.code}`, { headers: auth(a.token) })).json();
    assert.equal(got.lobby.code, lobby.code);

    const joined = await (await fetch(base + `/api/lobbies/${lobby.code}/join`, { method: 'POST', headers: auth(b.token) })).json();
    assert.equal(joined.lobby.slots[1].accountId, b.accountId);
    assert.equal(joined.lobby.slots[1].controller, 'human');

    // A подключается по WS, чтобы игра после старта ждала его хода (статус playing)
    const aClient = await connectClient(base, a.token);
    await aClient.next('hello');
    aClient.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await aClient.next('lobby_update');

    const started = await (await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) })).json();
    assert.equal(started.lobby.status, 'playing');

    const after = await (await fetch(base + `/api/lobbies/${lobby.code}`, { headers: auth(a.token) })).json();
    assert.equal(after.lobby.status, 'playing');
    aClient.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('проекция: чужие руки и колоды скрыты, публичное осталось', () => {
  const game = CnA.createGame({ mode: 'race', seed: 42, trackKind: 'mosaic', trackSize: 36, laps: 1 });
  const proj = projectionFor(game, 0);
  assert.ok(Array.isArray(proj.cars[0].hand), 'своя рука — полный массив');
  for (let i = 1; i < 4; i++) {
    assert.deepEqual(Object.keys(proj.cars[i].hand).sort(), ['count', 'hidden'], `slot ${i} рука скрыта`);
    assert.equal(proj.cars[i].hand.hidden, true);
    assert.equal(proj.cars[i].hand.count, game.cars[i].hand.length);
  }
  assert.equal(proj.race.deck.hidden, true);
  assert.equal(proj.race.deck.count, game.race.deck.length);
  assert.equal(proj.race.eventDeck.hidden, true);
  // публичное не скрыто
  assert.equal(proj.cars[1].hp, game.cars[1].hp);
  assert.ok(Array.isArray(proj.race.track.nodes));
  assert.ok(Array.isArray(proj.race.tokens));
  assert.ok(Array.isArray(proj.race.discard));
  // toEngineState не содержит rng
  const e = toEngineState(game);
  assert.ok(!('rng' in e));
  assert.ok(!('quiet' in e));
});

test('таймер: turn_timeout с остатком + авто-endTurn', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'timer_a');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: 10 });
    const client = await connectClient(base, a.token);
    await client.next('hello');
    client.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await client.next('lobby_update');
    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    const gs = await client.next('game_start', 6000);
    const gameId = gs.gameId;

    const first = await client.next('your_turn', 8000);
    const tt = await client.next('turn_timeout', 3000);
    assert.equal(tt.slot, first.slot);
    assert.ok(tt.remainingMs > 0 && tt.remainingMs <= 10000);

    // симулируем истечение таймера (без ожидания 10 с) → ход переходит дальше
    pvp._internals.forceEndHumanTurn(gameId);
    const second = await client.next('your_turn', 8000);
    assert.ok(second.slot >= 0);
    client.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('выбывание: разрыв WS → bot, возврат по cookie → human', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'sub_a');
    const b = await register(base, 'sub_b');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null });
    await fetch(base + `/api/lobbies/${lobby.code}/join`, { method: 'POST', headers: auth(b.token) });

    const aClient = await connectClient(base, a.token);
    await aClient.next('hello');
    aClient.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await aClient.next('lobby_update');

    const bClient = await connectClient(base, b.token);
    await bClient.next('hello');
    bClient.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await bClient.next('lobby_update');

    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    await aClient.next('game_start', 6000);

    const gameRow = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(lobby.code);
    const bSlot = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND account_id = ?').get(gameRow.id, b.accountId).slot;

    // B разрывает соединение
    bClient.close();
    const left = await aClient.next('opponent_left', 6000);
    assert.equal(left.slot, bSlot);
    assert.equal(left.reason, 'disconnect');
    assert.equal(left.controllerNow, 'bot');
    let gp = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND slot = ?').get(gameRow.id, bSlot);
    assert.equal(gp.controller, 'bot');
    assert.ok(gp.disconnected_at);

    // B возвращается по cookie в течение окна
    const bClient2 = await connectClient(base, b.token);
    await bClient2.next('hello');
    bClient2.send({ type: 'join_lobby', lobbyCode: lobby.code });
    const rejoin = await bClient2.next('reconnect_ok', 6000);
    assert.equal(rejoin.slot, bSlot);
    gp = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND slot = ?').get(gameRow.id, bSlot);
    assert.equal(gp.controller, 'human');
    assert.equal(gp.disconnected_at, null);

    aClient.close(); bClient2.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('финализация: конец игры создаёт run для каждого человека', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'fin_a');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null });
    // стартуем без WS-подключения: слот A не на связи → движок доигрывает его ИИ, гонка завершается
    const started = await (await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) })).json();
    assert.equal(started.lobby.status, 'finished');

    const gameRow = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(lobby.code);
    assert.equal(gameRow.status, 'finished');
    const runs = db.prepare("SELECT * FROM runs WHERE account_id = ? AND mode = 'race'").all(a.accountId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'finished');
    assert.ok(runs[0].score >= 0);
    assert.ok(runs[0].damage >= 0);
    assert.ok(runs[0].kills >= 0);
    const result = JSON.parse(runs[0].result);
    assert.ok(result.detail && Array.isArray(result.standings) && result.standings.length === 4);
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

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
  // сбросить накопленные state/turn_timeout, чтобы next('state') ждал свежий кадр после действия
  client.drain('state');
  client.drain('turn_timeout');
  const live = pvp._internals.liveGames.get(gameId);
  return { lobby, client, gameId, live, game: live.game };
}

test('route_choice: развилка паузит движение, choose_route применяет выбор', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'route_a');
    const { client, game } = await startSingleHuman(base, a.token, pvp, { turnTimerSeconds: null });

    const fork = game.race.track.nodes.find((n) => n.next.length > 1);
    assert.ok(fork, 'на трассе есть развилка');
    game.cars[0].node = fork.id; // ставим машину на развилку

    client.send({ type: 'roll' });
    const rc = await client.next('route_choice', 6000);
    assert.ok(Array.isArray(rc.options) && rc.options.length > 1, 'route_choice с вариантами');
    assert.equal(rc.from, fork.id);

    client.drain('state'); // убрать state от roll, ждать свежий кадр после choose_route
    client.send({ type: 'choose_route', nodeId: rc.options[0].node });
    await client.next('state', 6000);
    assert.notEqual(game.cars[0].node, fork.id, 'машина ушла с развилки');
    client.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('route_choice таймаут → первый вариант + авто-endTurn', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'rto_a');
    const { client, game, gameId } = await startSingleHuman(base, a.token, pvp, { turnTimerSeconds: 10 });

    const fork = game.race.track.nodes.find((n) => n.next.length > 1);
    game.cars[0].node = fork.id;
    client.send({ type: 'roll' });
    const rc = await client.next('route_choice', 6000);
    assert.ok(rc.options.length > 1);

    // не отвечаем choose_route; симулируем таймаут → сервер берёт первый вариант и завершает ход
    pvp._internals.forceEndHumanTurn(gameId);
    const next = await client.next('your_turn', 8000);
    assert.ok(next.slot >= 0);
    client.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('pit: пит-стоп в подготовке на пит-лейне', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'pit_a');
    const { client, game } = await startSingleHuman(base, a.token, pvp, { turnTimerSeconds: null });

    const pitNode = game.race.track.pitNodes[0];
    game.cars[0].node = pitNode;
    client.send({ type: 'pit' });
    await client.next('state', 6000);
    assert.equal(game.cars[0].flags.pitThisRace, true, 'пит-стоп был объявлен');
    client.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('ability: rust (Латаем на ходу) и returnMine (Карнавал)', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    // rust
    const r = await register(base, 'rust_a');
    const rGame = await startSingleHuman(base, r.token, pvp, { turnTimerSeconds: null });
    rGame.game.cars[0].factionId = 'rust';
    rGame.game.cars[0].hp = Math.max(1, rGame.game.cars[0].maxHp - 4);
    rGame.game.cars[0].flags.repairUsed = false;
    const hpBefore = rGame.game.cars[0].hp;
    rGame.client.send({ type: 'ability', id: 'rust' });
    await rGame.client.next('state', 6000);
    assert.ok(rGame.game.cars[0].hp > hpBefore, 'rust-ремонт восстановил корпус');
    rGame.client.close();

    // returnMine (carnival)
    const c = await register(base, 'carn_a');
    const cGame = await startSingleHuman(base, c.token, pvp, { turnTimerSeconds: null });
    cGame.game.cars[0].factionId = 'carnival';
    cGame.game.cars[0].flags.mineReturned = false;
    cGame.game.cars[0].hand = cGame.game.cars[0].hand.slice(0, 3); // < 5 карт
    const handBefore = cGame.game.cars[0].hand.length;
    cGame.client.send({ type: 'ability', id: 'returnMine' });
    await cGame.client.next('state', 6000);
    assert.equal(cGame.game.cars[0].hand.length, handBefore + 1, 'мина возвращена в руку');
    cGame.client.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('turbo: ability{turbo} в подготовке взводит турбину', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'turbo_a');
    const { client, game } = await startSingleHuman(base, a.token, pvp, { turnTimerSeconds: null });

    game.cars[0].upgrades = ['turbo'];
    game.cars[0].flags.turboUsed = false;
    game.cars[0].flags.turboArmed = false;
    client.send({ type: 'ability', id: 'turbo' });
    await client.next('state', 6000);
    assert.equal(game.cars[0].flags.turboArmed, true, 'турбина взведена');
    client.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});

test('rejoin_expired: возврат после окна → слот остаётся ботом', async () => {
  const { server, db, pvp, base } = await startServer(openDb(':memory:'));
  try {
    const a = await register(base, 'rejoin_a');
    const b = await register(base, 'rejoin_b');
    const lobby = await createLobby(base, a.token, { turnTimerSeconds: null, rejoinWindowSeconds: 0 });
    await fetch(base + `/api/lobbies/${lobby.code}/join`, { method: 'POST', headers: auth(b.token) });

    const aClient = await connectClient(base, a.token);
    await aClient.next('hello');
    aClient.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await aClient.next('lobby_update');

    const bClient = await connectClient(base, b.token);
    await bClient.next('hello');
    bClient.send({ type: 'join_lobby', lobbyCode: lobby.code });
    await bClient.next('lobby_update');

    await fetch(base + `/api/lobbies/${lobby.code}/start`, { method: 'POST', headers: auth(a.token) });
    await aClient.next('game_start', 6000);

    const gameRow = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(lobby.code);
    const bSlot = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND account_id = ?').get(gameRow.id, b.accountId).slot;

    // B разрывает соединение → bot
    bClient.close();
    await aClient.next('opponent_left', 6000);
    let gp = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND slot = ?').get(gameRow.id, bSlot);
    assert.equal(gp.controller, 'bot');

    // B возвращается: окно = 0 → rejoin_expired, слот остаётся ботом
    const bClient2 = await connectClient(base, b.token);
    await bClient2.next('hello');
    bClient2.send({ type: 'join_lobby', lobbyCode: lobby.code });
    const err = await bClient2.next('error', 6000);
    assert.equal(err.code, 'rejoin_expired');
    gp = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND slot = ?').get(gameRow.id, bSlot);
    assert.equal(gp.controller, 'bot');

    aClient.close(); bClient2.close();
  } finally {
    pvp.dispose(); server.close(); db.close();
  }
});
