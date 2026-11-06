import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { CnA } from './engine.js';
import { nowIso, uuidv7, sha256Hex } from './util.js';

const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без I,O,0,1
const OPEN = 1; // WebSocket.OPEN

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

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

function makeLobbyCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += BASE32[bytes[i] % BASE32.length];
  return s;
}

/** Сериализуемый срез движка без rng/quiet. */
export function toEngineState(game) {
  const { rng, quiet, ...engine } = game;
  return engine;
}

/** Проекция для слота: полное состояние минус чужие руки и обе колоды. */
export function projectionFor(game, slot) {
  const proj = JSON.parse(JSON.stringify(toEngineState(game)));
  if (Array.isArray(proj.cars)) {
    for (let i = 0; i < proj.cars.length; i++) {
      proj.cars[i].human = (i === slot); // проекция per-viewer: только своя машина помечена human
      if (i !== slot) proj.cars[i].hand = { hidden: true, count: (game.cars[i].hand || []).length };
    }
  }
  if (proj.race) {
    proj.race.deck = { hidden: true, count: (game.race.deck || []).length };
    proj.race.eventDeck = { hidden: true, count: (game.race.eventDeck || []).length };
  }
  return proj;
}

/** RunResult для слота (для финализации). */
export function buildResultFor(game, slot) {
  const car = game.cars[slot];
  const rows = game.results ? game.results.rows : [];
  const row = rows.find((r) => r.carId === slot) || null;
  const standings = (game.results && game.results.standings)
    ? game.results.standings.map((s) => ({
        place: s.place, faction: s.factionId, name: s.name, cp: s.cp,
        damage: s.damage, kills: s.kills, scrap: s.scrap, human: s.carId === slot,
      }))
    : [];
  return {
    score: car.cp,
    detail: {
      pos: row ? row.pos : 1,
      finished: row ? !!row.finished : true,
      damage: row ? row.damage : (car.raceDamage || 0),
      kills: row ? row.kills : (car.raceKills || 0),
      scrap: car.scrap,
    },
    standings,
  };
}

function normalizeConfig(c) {
  c = c || {};
  // turnTimerSeconds: null = без таймера; число клампится в [10, 300]; отсутствие = 90
  let turnTimerSeconds = 90;
  if (c.turnTimerSeconds === null) turnTimerSeconds = null;
  else if (Number.isInteger(c.turnTimerSeconds)) turnTimerSeconds = Math.min(300, Math.max(10, c.turnTimerSeconds));
  // rejoinWindowSeconds: кламп [0, 3600]
  let rejoinWindowSeconds = 300;
  if (Number.isInteger(c.rejoinWindowSeconds)) rejoinWindowSeconds = Math.min(3600, Math.max(0, c.rejoinWindowSeconds));
  // seed: целое неотрицательное, иначе null (случайный)
  const seed = (Number.isInteger(c.seed) && c.seed >= 0) ? c.seed : null;
  return {
    turnTimerSeconds,
    trackKind: c.trackKind === 'ring' ? 'ring' : 'mosaic',
    trackSize: Number.isInteger(c.trackSize) && c.trackSize >= 24 && c.trackSize <= 36 ? c.trackSize : (c.trackKind === 'ring' ? 28 : 36),
    laps: c.laps === 2 ? 2 : 1,
    seed,
    rejoinWindowSeconds,
  };
}

export function createPvp({ db, config }) {
  const liveGames = new Map(); // gameId -> LiveGame
  let disposed = false;

  function getLive(gameId) { return liveGames.get(gameId); }

  function getOrCreateLive(gameRow) {
    let live = liveGames.get(gameRow.id);
    if (!live) {
      live = {
        game: null, seq: gameRow.seq, config: safeJson(gameRow.config_json) || {},
        timer: null, connections: new Map(), turnSlot: null, route: null, processed: new Set(),
        startedAt: gameRow.started_at, finalized: gameRow.status === 'finished',
      };
      if (gameRow.state) {
        const state = safeJson(gameRow.state);
        if (state && state.seed !== undefined) {
          state.rng = CnA.mulberry32(state.seed + (state.raceIndex || 0) * 1013 + 7);
          live.game = state;
        }
      }
      liveGames.set(gameRow.id, live);
    }
    return live;
  }

  function findAccountBySession(req) {
    const token = getCookie(req, 'cna_session');
    if (!token) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256Hex(token));
    if (!session || session.revoked_at) return null;
    if (session.expires_at < nowIso()) return null;
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(session.account_id) || null;
  }

  function requireAuthPvp(req, res, next) {
    const account = findAccountBySession(req);
    if (!account) return res.status(401).json({ error: { code: 'unauthorized', message: 'Требуется вход' } });
    req.account = account;
    next();
  }

  /* --- lobby JSON --- */
  function lobbyJsonFor(gameId) {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return null;
    const players = db.prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY slot').all(gameId);
    const live = getLive(gameId);
    const slots = [];
    for (let slot = 0; slot < 4; slot++) {
      const p = players.find((x) => x.slot === slot);
      const acct = (p && p.account_id) ? db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(p.account_id) : null;
      const ws = live && live.connections.get(slot);
      slots.push({
        slot,
        accountId: p ? p.account_id : null,
        displayName: acct ? acct.display_name : null,
        faction: p ? p.faction : null,
        controller: p ? p.controller : 'bot',
        connected: !!(ws && ws.readyState === OPEN),
      });
    }
    return {
      code: game.lobby_code,
      ownerAccountId: game.owner_account_id,
      status: game.status,
      config: safeJson(game.config_json),
      slots,
    };
  }

  /* --- state/seq/broadcast --- */
  function commit(gameId) {
    const live = getLive(gameId);
    if (!live || !live.game) return;
    live.seq += 1;
    db.prepare('UPDATE games SET state = ?, seq = ? WHERE id = ?').run(JSON.stringify(toEngineState(live.game)), live.seq, gameId);
    broadcastState(gameId);
  }

  function broadcastState(gameId) {
    const live = getLive(gameId);
    if (!live) return;
    for (const [slot, ws] of live.connections) {
      if (ws.readyState === OPEN) {
        ws.send(JSON.stringify({ type: 'state', seq: live.seq, projection: projectionFor(live.game, slot) }));
      }
    }
  }

  function broadcast(gameId, msg) {
    const live = getLive(gameId);
    if (!live) return;
    for (const ws of live.connections.values()) {
      if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
    }
  }

  function sendToSlot(gameId, slot, msg) {
    const live = getLive(gameId);
    const ws = live && live.connections.get(slot);
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws, code, message) {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', code, message }));
  }

  /* --- таймер --- */
  function clearTimer(gameId) {
    const live = getLive(gameId);
    if (live && live.timer && live.timer.handle) clearTimeout(live.timer.handle);
    if (live) live.timer = null;
  }

  function startTimer(gameId, slot) {
    clearTimer(gameId);
    const live = getLive(gameId);
    const secs = live.config.turnTimerSeconds;
    if (secs == null) return;
    const totalMs = secs * 1000;
    const handle = setTimeout(() => onTurnTimeout(gameId, slot), totalMs);
    live.timer = { slot, handle, totalMs };
    sendToSlot(gameId, slot, { type: 'turn_timeout', slot, remainingMs: totalMs });
  }

  function onTurnTimeout(gameId, slot) {
    if (disposed) return;
    const live = getLive(gameId);
    if (!live || !live.timer || live.timer.slot !== slot || live.turnSlot !== slot) return;
    live.timer = null;
    if (live.game.race.over) { finalizeGame(gameId); return; }
    forceEndHumanTurn(gameId);
  }

  /* --- игровой цикл --- */
  function isHumanSlot(gameId, slot) {
    const p = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND slot = ?').get(gameId, slot);
    return !!(p && p.controller === 'human');
  }
  function isConnected(gameId, slot) {
    const live = getLive(gameId);
    const ws = live && live.connections.get(slot);
    return !!(ws && ws.readyState === OPEN);
  }

  function endHumanTurn(gameId) {
    const live = getLive(gameId);
    live.route = null;
    clearTimer(gameId);
    live.turnSlot = null;
    CnA.endTurn(live.game);
    commit(gameId);
    pump(gameId);
  }

  function forceEndHumanTurn(gameId) {
    const live = getLive(gameId);
    const game = live.game;
    if (game.race.over) { finalizeGame(gameId); return; }
    if (live.route) {
      const car = game.cars[live.route.slot];
      let guard = 0;
      while (guard++ < 20) {
        if (game.race.over || car.destroyed || car.finished) break;
        const opts = CnA.movementOptions(game, car);
        if (!opts.length) break;
        const opt = opts[0]; // таймаут → первый вариант
        const step = CnA.stepMovement(game, car, opt.node, opt.jump);
        if (!step.ok || step.stop) break;
      }
      if (!game.race.over) CnA.finishMovement(game, car);
      live.route = null;
    }
    live.turnSlot = null;
    CnA.endTurn(game);
    commit(gameId);
    pump(gameId);
  }

  function runMovement(gameId, slot) {
    const live = getLive(gameId);
    const game = live.game;
    const car = game.cars[slot];
    let guard = 0;
    while (guard++ < 20) {
      if (game.race.over || car.destroyed || car.finished) break;
      const opts = CnA.movementOptions(game, car);
      if (!opts.length) break;
      if (opts.length > 1) {
        // развилка: пауза до choose_route (таймер хода продолжается); options = объекты {node,jump,via}
        const options = opts.map((o) => ({ node: o.node, jump: !!o.jump, via: o.via ?? null }));
        live.route = { slot, from: car.node, options };
        commit(gameId);
        sendToSlot(gameId, slot, { type: 'route_choice', from: car.node, options });
        return;
      }
      const step = CnA.stepMovement(game, car, opts[0].node, opts[0].jump);
      if (!step.ok || step.stop) break;
    }
    if (!game.race.over) CnA.finishMovement(game, car);
    commit(gameId);
    if (game.race.over) { finalizeGame(gameId); return; }
    if (car.destroyed || car.finished) endHumanTurn(gameId);
  }

  function pump(gameId) {
    const live = getLive(gameId);
    if (!live || !live.game) return;
    let guard = 0;
    while (guard++ < 2000) {
      const game = live.game;
      if (game.race.over) { finalizeGame(gameId); return; }
      const carId = game.race.currentId;
      if (carId == null) { finalizeGame(gameId); return; }
      const slot = carId;
      if (isHumanSlot(gameId, slot) && isConnected(gameId, slot)) {
        const started = CnA.beginTurn(game);
        if (started.skip) { CnA.endTurn(game); commit(gameId); continue; }
        live.turnSlot = slot;
        commit(gameId);
        const secs = live.config.turnTimerSeconds;
        const deadline = (secs == null) ? null : new Date(Date.now() + secs * 1000).toISOString();
        sendToSlot(gameId, slot, { type: 'your_turn', slot, carId, deadline });
        startTimer(gameId, slot);
        return;
      }
      CnA.aiTakeTurn(game);
      commit(gameId);
    }
  }

  /* --- действия --- */
  function handleAction(gameId, slot, msg) {
    const live = getLive(gameId);
    if (!live || !live.game) return sendToSlot(gameId, slot, { type: 'error', code: 'not_found', message: 'Игра не найдена' });
    // идемпотентность: повтор действия с тем же clientId → текущий state (не применяем повторно)
    if (msg.clientId != null) {
      const key = slot + ':' + msg.clientId;
      if (live.processed.has(key)) {
        return sendToSlot(gameId, slot, { type: 'state', seq: live.seq, projection: projectionFor(live.game, slot) });
      }
      live.processed.add(key);
      if (live.processed.size > 1000) {
        const it = live.processed.values();
        for (let i = 0; i < 500; i++) live.processed.delete(it.next().value);
      }
    }
    // ackSeq: если клиент отстал — шлём полную проекцию перед применением
    if (Number.isInteger(msg.ackSeq) && msg.ackSeq < live.seq) {
      sendToSlot(gameId, slot, { type: 'state', seq: live.seq, projection: projectionFor(live.game, slot) });
    }
    const game = live.game;
    if (game.race.over) return sendToSlot(gameId, slot, { type: 'error', code: 'game_over', message: 'Игра завершена' });
    if (game.race.currentId !== slot) return sendToSlot(gameId, slot, { type: 'error', code: 'not_your_turn', message: 'Не ваш ход' });
    if (!isHumanSlot(gameId, slot)) return sendToSlot(gameId, slot, { type: 'error', code: 'not_your_turn', message: 'Слот управляется ИИ' });
    const car = game.cars[slot];

    if (msg.type === 'roll') {
      const res = CnA.rollMove(game, car);
      if (!res.ok) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: res.reason });
      commit(gameId);
      if (game.race.over) return finalizeGame(gameId);
      if (car.destroyed || car.finished) { endHumanTurn(gameId); return; }
      runMovement(gameId, slot);
      return;
    }

    if (msg.type === 'choose_route') {
      if (game.race.phase !== 'move') return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Сейчас нет выбора маршрута' });
      if (!live.route || live.route.slot !== slot) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Нет ожидающего выбора маршрута' });
      const opt = CnA.movementOptions(game, car).find((o) => o.node === msg.nodeId);
      if (!opt) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Недоступный тайл' });
      live.route = null;
      const step = CnA.stepMovement(game, car, opt.node, opt.jump);
      if (!step.ok) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: step.reason });
      commit(gameId);
      if (step.stop || game.race.over || car.destroyed || car.finished) {
        if (!game.race.over) CnA.finishMovement(game, car);
        commit(gameId);
        if (game.race.over) return finalizeGame(gameId);
        if (car.destroyed || car.finished) return endHumanTurn(gameId);
        return;
      }
      runMovement(gameId, slot);
      return;
    }

    if (msg.type === 'pit') {
      if (game.race.phase !== 'prep') return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Пит-стоп доступен только в подготовке' });
      const res = CnA.startPit(game, car);
      if (!res.ok) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: res.reason });
      commit(gameId);
      endHumanTurn(gameId);
      return;
    }

    if (msg.type === 'ability') {
      const wildfireInFire = msg.id === 'wildfire' && game.race.phase === 'fire';
      if (game.race.phase !== 'prep' && !wildfireInFire) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Способность доступна только в подготовке' });
      let res;
      if (msg.id === 'rust') res = CnA.useRustRepair(game, car);
      else if (msg.id === 'returnMine') res = CnA.returnMine(game, car);
      else if (msg.id === 'turbo') res = CnA.armTurbo(game, car);
      else if (msg.id === 'wildfire') res = CnA.armWildfire(game, car);
      else return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Неизвестная способность: ' + msg.id });
      if (!res.ok) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: res.reason });
      commit(gameId);
      return;
    }

    if (msg.type === 'end_turn') {
      live.route = null;
      live.turnSlot = null;
      CnA.endTurn(game);
      commit(gameId);
      clearTimer(gameId);
      pump(gameId);
      return;
    }

    if (msg.type === 'play_card') {
      const h = car.hand.find((c) => c.uid === msg.uid);
      if (!h) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Карты нет в руке' });
      const card = CnA.CARDS[h.type];
      if (card.phase === 'reaction') return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Карта срабатывает автоматически' });
      if (card.phase === 'prep') {
        const res = CnA.playPrep(game, car, msg.uid);
        if (!res.ok) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: res.reason });
        commit(gameId);
        return;
      }
      if (card.phase === 'fire') {
        let res;
        if (card.kind === 'trap') {
          if (!Number.isInteger(msg.node)) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Нужен node для ловушки' });
          res = CnA.placeTrap(game, car, msg.uid, msg.node);
        } else if (card.twin) {
          if (!Array.isArray(msg.targets) || msg.targets.length !== 2) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Нужны два targets для twin' });
          res = CnA.playTwin(game, car, msg.uid, msg.targets);
        } else {
          if (!Number.isInteger(msg.target)) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Нужен target для атаки' });
          res = CnA.playAttack(game, car, msg.uid, msg.target);
        }
        if (!res || !res.ok) return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: (res && res.reason) || 'Нельзя сыграть' });
        commit(gameId);
        if (game.race.over) return finalizeGame(gameId);
        return;
      }
      return sendToSlot(gameId, slot, { type: 'error', code: 'invalid_action', message: 'Неизвестная фаза карты' });
    }

    return sendToSlot(gameId, slot, { type: 'error', code: 'bad_request', message: 'Неизвестное действие: ' + msg.type });
  }

  /* --- выбывание / возврат --- */
  function takeOverByBot(gameId, slot, reason, account) {
    if (disposed) return;
    const gameRow = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!gameRow || gameRow.status !== 'playing') return; // бот-подмена только в идущей игре
    db.prepare("UPDATE game_players SET controller = 'bot', disconnected_at = ? WHERE game_id = ? AND slot = ?").run(nowIso(), gameId, slot);
    broadcast(gameId, {
      type: 'opponent_left', slot,
      accountId: account ? account.id : null,
      displayName: account ? account.display_name : null,
      reason, controllerNow: 'bot',
    });
    const live = getLive(gameId);
    if (live && live.game && !live.game.race.over && live.turnSlot === slot) {
      clearTimer(gameId);
      live.turnSlot = null;
      live.route = null;
      CnA.endTurn(live.game);
      commit(gameId);
      pump(gameId);
    }
  }

  function withinRejoin(player, config) {
    if (!player.disconnected_at) return false;
    const windowSec = (config && Number.isInteger(config.rejoinWindowSeconds)) ? config.rejoinWindowSeconds : 300;
    return (Date.now() - Date.parse(player.disconnected_at)) <= windowSec * 1000;
  }

  /* --- старт --- */
  function startLobby(account, code) {
    const gameRow = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(code);
    if (!gameRow) return { err: [404, 'not_found', 'Лобби не найдено'] };
    if (gameRow.owner_account_id !== account.id) return { err: [403, 'forbidden', 'Только владелец может стартовать'] };
    if (gameRow.status !== 'waiting') return { err: [409, 'not_waiting', 'Лобби уже не в статусе waiting'] };

    const config = normalizeConfig(safeJson(gameRow.config_json));
    const seed = config.seed == null ? Math.floor(Math.random() * 1000000000) : config.seed;
    const game = CnA.createGame({
      mode: 'race', seed,
      trackKind: config.trackKind, trackSize: config.trackSize, laps: config.laps,
    });

    const players = db.prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY slot').all(gameRow.id);
    const occupied = new Set(players.map((p) => p.slot));
    const startedAt = nowIso();
    for (let slot = 0; slot < 4; slot++) {
      const faction = CnA.FACTIONS[slot].id;
      if (occupied.has(slot)) {
        db.prepare('UPDATE game_players SET faction = ? WHERE game_id = ? AND slot = ?').run(faction, gameRow.id, slot);
      } else {
        db.prepare("INSERT INTO game_players (game_id, account_id, slot, controller, faction, joined_at) VALUES (?, NULL, ?, 'bot', ?, ?)").run(gameRow.id, slot, faction, startedAt);
      }
    }

    db.prepare("UPDATE games SET status = 'playing', started_at = ? WHERE id = ?").run(startedAt, gameRow.id);

    const live = getOrCreateLive(gameRow);
    live.game = game;
    live.config = config;
    live.seq = 0;
    live.startedAt = startedAt;
    live.finalized = false;
    live.turnSlot = null;
    live.route = null;

    commit(gameRow.id); // seq=1 + state

    const playersAfter = db.prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY slot').all(gameRow.id);
    broadcast(gameRow.id, {
      type: 'game_start', gameId: gameRow.id, config, seq: live.seq,
      players: playersAfter.map((p) => ({
        slot: p.slot,
        accountId: p.account_id,
        displayName: p.account_id ? (db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(p.account_id) || {}).display_name : null,
        faction: p.faction, controller: p.controller,
      })),
    });

    pump(gameRow.id);
    return { ok: true };
  }

  /* --- финализация --- */
  function finalizeGame(gameId) {
    const live = getLive(gameId);
    if (!live || !live.game || live.finalized) return;
    live.finalized = true;
    clearTimer(gameId);
    const game = live.game;
    const finishedAt = nowIso();
    const runs = [];

    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT status FROM games WHERE id = ?').get(gameId);
      if (!row || row.status === 'finished') { db.exec('ROLLBACK'); return; } // уже финализировано
      db.prepare("UPDATE games SET status = 'finished', finished_at = ? WHERE id = ?").run(finishedAt, gameId);

      const players = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND account_id IS NOT NULL ORDER BY slot').all(gameId);
      for (const p of players) {
        const result = buildResultFor(game, p.slot);
        const runId = uuidv7();
        db.prepare(
          `INSERT INTO runs (id, account_id, mode, daily_date, faction, track_kind, track_size, laps, seed, status, score, damage, kills, result, started_at, finished_at)
           VALUES (?,?, 'race', NULL, ?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?)`
        ).run(runId, p.account_id, p.faction || game.cars[p.slot].factionId, live.config.trackKind, live.config.trackSize, live.config.laps, game.seed, result.score, result.detail.damage, result.detail.kills, JSON.stringify(result), live.startedAt || finishedAt, finishedAt);
        runs.push({ accountId: p.account_id, runId, score: result.score, detail: result.detail });
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('[cna] ошибка финализации', e);
      return;
    }

    broadcast(gameId, { type: 'result', gameId, standings: game.results ? game.results.standings : [], runs });
    broadcast(gameId, { type: 'lobby_update', lobby: lobbyJsonFor(gameId) });
    // игра завершена — освободить live-состояние из памяти
    liveGames.delete(gameId);
  }

  /* --- WS --- */
  function routeMessage(ws, account, msg) {
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    if (msg.type === 'join_lobby') return onJoinLobby(ws, account, msg);
    if (msg.type === 'start_game') return onStartGame(ws, account, msg);
    const binding = ws._cnaBinding;
    if (!binding) return sendError(ws, 'not_joined', 'Сначала join_lobby');
    if (msg.type === 'resign') return onResign(ws, account, binding);
    if (msg.type === 'play_card' || msg.type === 'roll' || msg.type === 'end_turn' || msg.type === 'choose_route' || msg.type === 'pit' || msg.type === 'ability') {
      return handleAction(binding.gameId, binding.slot, msg);
    }
    return sendError(ws, 'bad_request', 'Неизвестное сообщение: ' + msg.type);
  }

  function onJoinLobby(ws, account, msg) {
    const code = String(msg.lobbyCode || '').toUpperCase();
    const gameRow = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(code);
    if (!gameRow) return sendError(ws, 'not_found', 'Лобби не найдено');
    const player = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND account_id = ?').get(gameRow.id, account.id);
    if (!player) return sendError(ws, 'forbidden', 'Вы не участник лобби');

    const live = getOrCreateLive(gameRow);
    live.connections.set(player.slot, ws);
    ws._cnaBinding = { gameId: gameRow.id, slot: player.slot };

    if (gameRow.status === 'playing') {
      if (player.controller === 'bot' && withinRejoin(player, live.config)) {
        db.prepare("UPDATE game_players SET controller = 'human', disconnected_at = NULL WHERE game_id = ? AND slot = ?").run(gameRow.id, player.slot);
        sendToSlot(gameRow.id, player.slot, { type: 'reconnect_ok', slot: player.slot, seq: live.seq, projection: projectionFor(live.game, player.slot) });
        broadcast(gameRow.id, { type: 'lobby_update', lobby: lobbyJsonFor(gameRow.id) });
        sendToSlot(gameRow.id, player.slot, { type: 'state', seq: live.seq, projection: projectionFor(live.game, player.slot) });
      } else if (player.controller === 'human') {
        sendToSlot(gameRow.id, player.slot, { type: 'state', seq: live.seq, projection: projectionFor(live.game, player.slot) });
      } else {
        sendError(ws, 'rejoin_expired', 'Окно возврата истекло');
      }
      // продвинуть игру, если она остановилась (восстановление после рестарта / первый join)
      if (live.game && !live.game.race.over && live.turnSlot == null) pump(gameRow.id);
    } else if (gameRow.status === 'waiting') {
      // join в ожидании: восстановить человеческое управление слотом
      db.prepare("UPDATE game_players SET controller = 'human', disconnected_at = NULL WHERE game_id = ? AND slot = ?").run(gameRow.id, player.slot);
      broadcast(gameRow.id, { type: 'lobby_update', lobby: lobbyJsonFor(gameRow.id) });
    } else {
      broadcast(gameRow.id, { type: 'lobby_update', lobby: lobbyJsonFor(gameRow.id) });
    }
  }

  function onStartGame(ws, account, msg) {
    const code = String(msg.lobbyCode || '').toUpperCase();
    const result = startLobby(account, code);
    if (result.err) return sendError(ws, result.err[1], result.err[2]);
  }

  function onResign(ws, account, binding) {
    takeOverByBot(binding.gameId, binding.slot, 'resign', account);
  }

  function originAllowed(origin, req) {
    if (!origin) return true; // не браузерный клиент
    if (config.allowedOrigins && config.allowedOrigins.includes(origin)) return true;
    try {
      const o = new URL(origin);
      const host = req.headers.host || '';
      if (o.host === host) return true; // same-origin
      if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') return true;
    } catch { return false; }
    return false;
  }

  function attach(server) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
    wss.on('connection', (ws, req) => {
      // Origin-проверка при апгрейде (защита от cross-site WS hijacking)
      if (!originAllowed(req.headers.origin, req)) {
        ws.close(4003, 'bad_origin');
        return;
      }
      const account = findAccountBySession(req);
      if (!account) {
        ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'Требуется вход' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, accountId: account.id, now: nowIso() }));

      ws.on('error', () => {}); // иначе сетевой обрыв роняет процесс (удалённый DoS)

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return sendError(ws, 'bad_request', 'Некорректный JSON'); }
        if (!msg || typeof msg.type !== 'string') return sendError(ws, 'bad_request', 'Нет type');
        routeMessage(ws, account, msg);
      });

      ws.on('close', () => {
        if (disposed) return;
        const binding = ws._cnaBinding;
        if (!binding) return;
        const live = getLive(binding.gameId);
        if (live && live.connections.get(binding.slot) === ws) {
          live.connections.delete(binding.slot);
          takeOverByBot(binding.gameId, binding.slot, 'disconnect', account);
        }
      });
    });
    return wss;
  }

  /* --- REST router --- */
  const router = express.Router();

  router.post('/api/lobbies', requireAuthPvp, (req, res) => {
    const config = normalizeConfig(req.body && req.body.config);
    const id = uuidv7();
    const now = nowIso();
    let code;
    for (let i = 0; i < 20; i++) {
      code = makeLobbyCode();
      if (!db.prepare('SELECT id FROM games WHERE lobby_code = ?').get(code)) break;
    }
    db.prepare('INSERT INTO games (id, lobby_code, owner_account_id, status, config_json, state, seq, created_at) VALUES (?,?,?,?,?,NULL,0,?)')
      .run(id, code, req.account.id, 'waiting', JSON.stringify(config), now);
    db.prepare("INSERT INTO game_players (game_id, account_id, slot, controller, faction, joined_at) VALUES (?,?,0,'human',?,?)")
      .run(id, req.account.id, CnA.FACTIONS[0].id, now);
    res.status(201).json({ lobby: lobbyJsonFor(id) });
  });

  router.get('/api/lobbies/:code', requireAuthPvp, (req, res) => {
    const game = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(String(req.params.code).toUpperCase());
    if (!game) return res.status(404).json({ error: { code: 'not_found', message: 'Лобби не найдено' } });
    res.json({ lobby: lobbyJsonFor(game.id) });
  });

  router.post('/api/lobbies/:code/join', requireAuthPvp, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const game = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(code);
    if (!game) return res.status(404).json({ error: { code: 'not_found', message: 'Лобби не найдено' } });
    if (game.status !== 'waiting') return res.status(409).json({ error: { code: 'not_waiting', message: 'Лобби уже не в статусе waiting' } });
    if (db.prepare('SELECT slot FROM game_players WHERE game_id = ? AND account_id = ?').get(game.id, req.account.id)) {
      return res.status(409).json({ error: { code: 'already_joined', message: 'Вы уже в лобби' } });
    }
    const players = db.prepare('SELECT slot FROM game_players WHERE game_id = ?').all(game.id);
    if (players.length >= 4) return res.status(409).json({ error: { code: 'lobby_full', message: 'Лобби заполнено' } });
    const occupied = new Set(players.map((p) => p.slot));
    let slot = 0; while (occupied.has(slot)) slot++;
    db.prepare("INSERT INTO game_players (game_id, account_id, slot, controller, faction, joined_at) VALUES (?,?,?,'human',?,?)")
      .run(game.id, req.account.id, slot, CnA.FACTIONS[slot].id, nowIso());
    res.json({ lobby: lobbyJsonFor(game.id) });
  });

  router.post('/api/lobbies/:code/leave', requireAuthPvp, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const game = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(code);
    if (!game) return res.status(404).json({ error: { code: 'not_found', message: 'Лобби не найдено' } });
    const player = db.prepare('SELECT * FROM game_players WHERE game_id = ? AND account_id = ?').get(game.id, req.account.id);
    if (!player) return res.status(404).json({ error: { code: 'not_found', message: 'Вы не в лобби' } });
    if (game.status === 'playing') {
      takeOverByBot(game.id, player.slot, 'disconnect', req.account);
      return res.status(204).end();
    }
    db.prepare('DELETE FROM game_players WHERE game_id = ? AND slot = ?').run(game.id, player.slot);
    if (game.owner_account_id === req.account.id) {
      db.prepare('DELETE FROM game_players WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM games WHERE id = ?').run(game.id);
      liveGames.delete(game.id);
      return res.status(204).end();
    }
    const live = getLive(game.id);
    if (live) broadcast(game.id, { type: 'lobby_update', lobby: lobbyJsonFor(game.id) });
    res.status(204).end();
  });

  router.post('/api/lobbies/:code/start', requireAuthPvp, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const result = startLobby(req.account, code);
    if (result.err) return res.status(result.err[0]).json({ error: { code: result.err[1], message: result.err[2] } });
    const game = db.prepare('SELECT * FROM games WHERE lobby_code = ?').get(code);
    res.json({ lobby: lobbyJsonFor(game.id) });
  });

  function dispose() {
    disposed = true;
    for (const live of liveGames.values()) {
      if (live.timer && live.timer.handle) clearTimeout(live.timer.handle);
      for (const ws of live.connections.values()) {
        try { ws.terminate(); } catch {}
      }
    }
    liveGames.clear();
  }

  return { router, attach, dispose, _internals: { projectionFor, toEngineState, buildResultFor, normalizeConfig, pump, finalizeGame, forceEndHumanTurn, takeOverByBot, liveGames } };
}
