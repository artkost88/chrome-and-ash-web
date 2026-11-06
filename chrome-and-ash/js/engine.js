/* ХРОМ И ПЕПЕЛ — игровой движок.
   Чистая логика без DOM: используется браузерным интерфейсом и симулятором. */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});

  /* ------------------------------------------------------------------ */
  /* Мелкие помощники                                                   */
  /* ------------------------------------------------------------------ */
  function log(game, text, kind) {
    if (game.quiet) return;
    game.log.push({ n: game.log.length + 1, round: game.race ? game.race.round : 0, text, kind: kind || 'info' });
    if (game.log.length > 400) game.log.splice(0, game.log.length - 400);
  }

  function carById(game, id) {
    return game.cars.find((c) => c.id === id) || null;
  }

  function currentCar(game) {
    const r = game.race;
    if (!r || r.currentId == null) return null;
    return carById(game, r.currentId);
  }

  function hasUpgrade(car, id) {
    return car.upgrades.indexOf(id) >= 0;
  }

  function upgradeMods(car) {
    const m = { move: 0, maxHp: 0 };
    car.upgrades.forEach((uid) => {
      const u = CnA.upgrade(uid);
      if (!u) return;
      const mods = u.mods || {};
      m.move += mods.move || 0;
      m.maxHp += mods.maxHp || 0;
      Object.keys(mods).forEach((k) => { if (k !== 'move' && k !== 'maxHp') m[k] = mods[k]; });
    });
    return m;
  }

  function activeCarsAt(game, nodeId) {
    return game.cars.filter((c) => !c.finished && !c.destroyed && !c.pit && c.node === nodeId);
  }

  function capacityAt(game, nodeId) {
    return activeCarsAt(game, nodeId).length;
  }

  function isPitNode(game, nodeId) {
    const node = game.race.track.nodes[nodeId];
    return !!node && node.type === 'pit';
  }

  function progressOf(game, car) {
    const t = game.race.track;
    return car.lapsDone * t.count + (t.distFromStart[car.node] || 0);
  }

  function raceLeader(game) {
    let best = null;
    let bestP = -Infinity;
    game.cars.forEach((c) => {
      if (c.finished || c.destroyed) return;
      const p = progressOf(game, c);
      if (p > bestP) { bestP = p; best = c; }
    });
    return best;
  }

  function isLeader(game, car) {
    return raceLeader(game) === car;
  }

  function rowsToObj(rows) {
    const o = {};
    rows.forEach((r) => { o[r[0]] = r[1]; });
    return o;
  }

  /* ------------------------------------------------------------------ */
  /* Создание игры                                                      */
  /* ------------------------------------------------------------------ */
  function makeCar(faction, idx) {
    return {
      id: idx,
      factionId: faction.id,
      name: faction.name,
      carName: faction.car,
      baseHp: faction.hp,
      maxHp: faction.hp,
      hp: faction.hp,
      slots: faction.slots,
      upgrades: [],
      hand: [],
      scrap: 0,
      cp: 0,
      cpStart: 0,
      scrapStart: 0,
      damageTotal: 0,
      killsTotal: 0,
      raceDamage: 0,
      raceKills: 0,
      raceCpKills: 0,
      raceLeaderCp: 0,
      raceScrapKills: 0,
      raceDamageTaken: 0,
      leaderLaps: 0,
      node: 0,
      lapsDone: 0,
      finished: false,
      finishPos: null,
      destroyed: false,
      downTurns: 0,
      respawnNode: 0,
      pit: null,
      burn: false,
      smoke: false,
      shield: 0,
      emp: false,
      lastMove: 0,
      nextMoveBonus: 0,
      nextMovePenalty: 0,
      flags: {},
      human: false,
      racePos: null,
    };
  }

  function resetRaceFlags(car) {
    car.flags = {
      turboArmed: false,
      turboUsed: false,
      reactiveUsed: false,
      autoloaderUsed: false,
      repairUsed: false,
      mineReturned: false,
      freeTrapUsed: false,
      pitThisRace: false,
      wildfireCharges: car.factionId === 'chrome' ? 2 : 0,
      rerollUsed: false,
    };
    car.raceStats = {
      turns: 0,
      attacks: 0,
      shootTurns: 0,
      damage: 0,
      mineTriggers: 0,
      traps: 0,
    };
    car.onBridge = false;
    car.lastKiller = null;
    car.lastCause = null;
  }

  function initialOrder(game) {
    const ids = game.cars.filter((c) => !c.finished).map((c) => c.id);
    if (game.raceIndex === 0) return CnA.shuffle(game.rng, ids);
    return ids.slice().sort((a, b) => {
      const ca = carById(game, a); const cb = carById(game, b);
      if (ca.cp !== cb.cp) return ca.cp - cb.cp;
      return game.rng() - 0.5;
    });
  }

  function roundOrder(game) {
    const rs = game.race;
    return game.cars
      .filter((c) => !c.finished)
      .slice()
      .sort((a, b) => (progressOf(game, a) - progressOf(game, b)) || (a.id - b.id))
      .map((c) => c.id);
  }

  function buildDeck(game) {
    const deck = [];
    CnA.DECK_RECIPE.forEach(([id, count]) => { for (let i = 0; i < count; i++) deck.push(id); });
    return CnA.shuffle(game.rng, deck);
  }

  function buildEventDeck(game) {
    const deck = [];
    CnA.EVENT_RECIPE.forEach(([id, count]) => { for (let i = 0; i < count; i++) deck.push(id); });
    return CnA.shuffle(game.rng, deck);
  }

  function setupRace(game) {
    game.rng = CnA.mulberry32(game.seed + game.raceIndex * 1013 + 7);
    const trackSize = game.trackSize || 28;
    const track = game.trackKind === 'mosaic'
      ? CnA.buildMosaicTrack()
      : CnA.generateTrack(game.seed + game.raceIndex * 977, trackSize);
    game.stage = 'race';
    game.race = {
      track,
      deck: buildDeck(game),
      discard: [],
      eventDeck: buildEventDeck(game),
      eventDiscard: [],
      tokens: [],
      round: 1,
      turnIdx: 0,
      currentId: null,
      order: [],
      phase: 'prep',
      turn: null,
      finishOrder: [],
      firstFinishRound: null,
      over: false,
      results: null,
      roundEffect: { rangeCap: null, rangeDelta: 0 },
      stats: {
        turns: 0,
        movementSum: 0,
        shootTurns: 0,
        fireTurns: 0,
        attacks: 0,
        traps: 0,
        damage: 0,
        damageBy: {},
        destructions: 0,
        mineTriggers: 0,
        oilTriggers: 0,
        events: 0,
        cardsPlayed: 0,
        cardsDrawn: 0,
        laps: 0,
        finishes: 0,
        deathsBy: {},
      },
      shop: [],
    };

    game.cars.forEach((car) => {
      const mods = upgradeMods(car);
      car.maxHp = Math.max(1, car.baseHp + mods.maxHp);
      car.hp = car.maxHp;
      car.hand = [];
      car.node = 0;
      car.lapsDone = -1;
      car.finished = false;
      car.finishPos = null;
      car.destroyed = false;
      car.downTurns = 0;
      car.respawnNode = 0;
      car.pit = null;
      car.burn = false;
      car.smoke = false;
      car.shield = 0;
      car.emp = false;
      car.lastMove = 0;
      car.nextMoveBonus = 0;
      car.nextMovePenalty = 0;
      car.raceDamage = 0;
      car.raceKills = 0;
      car.raceCpKills = 0;
      car.raceLeaderCp = 0;
      car.raceScrapKills = 0;
      car.raceDamageTaken = 0;
      car.leaderLaps = 0;
      car.cpStart = car.cp;
      car.scrapStart = car.scrap;
      car.racePos = null;
      car.spawnProtect = false;
      resetRaceFlags(car);
    });

    const order = initialOrder(game);
    game.race.order = order;
    game.race.currentId = order.length ? order[0] : null;
    game.race.phase = 'prep';

    // Стартовая решётка 2×2: две последние линии, по две машины на тайл.
    const baseGrid = track.grid || [track.count - 1, track.count - 2, track.count - 3, track.count - 4];
    const grid = [baseGrid[0], baseGrid[0], baseGrid[1], baseGrid[1]];
    order.forEach((id, i) => {
      const c = carById(game, id);
      if (c) c.node = grid[i];
    });

    // Стартовые руки: 3 карты каждому.
    game.cars.forEach((car) => drawCard(game, car, 3));
    log(game, 'Гонка ' + (game.raceIndex + 1) + ' начинается. Трасса: ' + track.count + ' тайлов, ' + game.laps + ' круг(а).', 'round');
    log(game, 'Стартовая решётка: ' + order.map((id, i) => carById(game, id).name + ' (тайл ' + grid[i] + ')').join(' · '), 'info');
    log(game, 'Порядок хода: ' + order.map((id) => carById(game, id).name).join(' → '), 'info');
  }

  function createGame(opts) {
    opts = opts || {};
    const mode = opts.mode === 'championship' ? 'championship' : 'race';
    const seed = (opts.seed === undefined || opts.seed === null || opts.seed === '')
      ? Math.floor(Math.random() * 1000000000) : (Number(opts.seed) >>> 0);
    const game = {
      version: CnA.VERSION,
      mode,
      seed,
      laps: opts.laps === 2 ? 2 : 1,
      trackSize: opts.trackSize || 28,
      trackKind: opts.trackKind === 'mosaic' ? 'mosaic' : 'ring',
      raceIndex: 0,
      stage: 'race',
      cars: CnA.FACTIONS.map((f, i) => makeCar(f, i)),
      log: [],
      quiet: !!opts.quiet,
      rng: CnA.mulberry32(seed),
      shop: [],
      results: null,
      options: {
        draw: opts.draw === undefined ? 1 : opts.draw,
        respawnFraction: opts.respawnFraction === undefined ? 0.5 : opts.respawnFraction,
        checkpoints: opts.checkpoints !== false,
        spawnProtect: opts.spawnProtect !== false,
        extraRounds: opts.extraRounds === undefined ? 2 : opts.extraRounds,
        mineLimit: opts.mineLimit === undefined ? 3 : opts.mineLimit,
      },
    };
    game.cars.forEach((car, i) => {
      car.human = opts.humanFaction ? CnA.FACTIONS[i].id === opts.humanFaction : false;
    });
    if (opts.hpPatch) {
      const HP_PATCH = { chrome: 18, rust: 22, carnival: 22, swarm: 18 };
      game.cars.forEach((car) => {
        car.baseHp = HP_PATCH[car.factionId] || car.baseHp;
        car.maxHp = car.baseHp;
        car.hp = car.baseHp;
      });
    }
    setupRace(game);
    return game;
  }

  /* ------------------------------------------------------------------ */
  /* Карты                                                              */
  /* ------------------------------------------------------------------ */
  function drawCard(game, car, n) {
    const r = game.race;
    let drawn = 0;
    for (let i = 0; i < (n || 1); i++) {
      if (car.hand.length >= 5) break;
      if (!r.deck.length) {
        if (!r.discard.length) break;
        r.deck = CnA.shuffle(game.rng, r.discard);
        r.discard = [];
      }
      const type = r.deck.pop();
      car.hand.push({ uid: CnA.nextUid(), type });
      drawn++;
      r.stats.cardsDrawn++;
    }
    return drawn;
  }

  function discardCard(game, car, uid) {
    const i = car.hand.findIndex((c) => c.uid === uid);
    if (i < 0) return null;
    const card = car.hand.splice(i, 1)[0];
    game.race.discard.push(card.type);
    return card;
  }

  function discardRandomCard(game, car) {
    if (!car.hand.length) return null;
    const i = Math.floor(game.rng() * car.hand.length);
    const card = car.hand.splice(i, 1)[0];
    game.race.discard.push(card.type);
    return card;
  }

  function addCardToHand(game, car, type) {
    if (car.hand.length >= 5) return false;
    car.hand.push({ uid: CnA.nextUid(), type });
    return true;
  }

  function canPlayPrep(game, car, cardUid) {
    const r = game.race;
    if (!r || r.phase !== 'prep' || !r.turn || r.turn.prepUsed) return false;
    if (car.finished || car.destroyed || car.pit) return false;
    const h = car.hand.find((c) => c.uid === cardUid);
    if (!h) return false;
    return CnA.CARDS[h.type].phase === 'prep';
  }

  function playPrep(game, car, cardUid) {
    if (!canPlayPrep(game, car, cardUid)) return { ok: false, reason: 'Сейчас эту карту сыграть нельзя' };
    const r = game.race;
    const h = car.hand.find((c) => c.uid === cardUid);
    const card = CnA.CARDS[h.type];
    discardCard(game, car, cardUid);
    r.turn.prepUsed = true;
    r.stats.cardsPlayed++;
    let text = card.name;
    switch (card.prep) {
      case 'nitro':
        r.turn.nitro = true;
        text += ': +d4 к движению, перегрев на 7+.';
        break;
      case 'brake':
        r.turn.brake = true;
        text += ': движение в этот ход = 1, препятствия игнорируются.';
        break;
      case 'smoke':
        car.smoke = true;
        text += ': дымовая завеса до начала следующего хода.';
        break;
      case 'repair': {
        const heal = CnA.d4(game.rng) + 1;
        const before = car.hp;
        car.hp = Math.min(car.maxHp, car.hp + heal);
        text += ': +' + (car.hp - before) + ' корпуса.';
        break;
      }
      case 'canister': {
        const n = drawCard(game, car, 2);
        text += ': добрано ' + n + ' карт.';
        break;
      }
      case 'drone': {
        const before = car.hp;
        car.hp = Math.min(car.maxHp, car.hp + 2);
        const healed = car.hp - before;
        const drawn = drawCard(game, car, 1);
        text += ': +' + healed + ' корпуса, +' + drawn + ' карта.';
        break;
      }
      case 'boost':
        car.nextMoveBonus += 2;
        text += ': +2 к движению, без перегрева.';
        break;
      case 'ramboost':
        car.nextMoveBonus += 1;
        r.turn.ramBonus = 2;
        text += ': +1 к движению, +2 к броску тарана.';
        break;
      case 'shield':
        car.shield = (car.shield || 0) + 2;
        text += ': +2 брони (поглощает урон).';
        break;
      default:
        break;
    }
    log(game, car.name + ' → ' + text, 'card');
    return { ok: true, text };
  }

  function useRustRepair(game, car) {
    const r = game.race;
    if (car.factionId !== 'rust') return { ok: false, reason: 'Не та фракция' };
    if (!r.turn || r.phase !== 'prep' || r.turn.prepUsed) return { ok: false, reason: 'Фаза подготовки уже использована' };
    if (car.flags.repairUsed) return { ok: false, reason: 'Способность уже использована в этой гонке' };
    if (car.hp >= car.maxHp) return { ok: false, reason: 'Корпус цел' };
    const heal = CnA.d4(game.rng);
    car.hp = Math.min(car.maxHp, car.hp + heal);
    car.flags.repairUsed = true;
    r.turn.prepUsed = true;
    log(game, car.name + ' → «Латаем на ходу»: +' + heal + ' корпуса', 'ability');
    return { ok: true, heal };
  }

  function returnMine(game, car) {
    const r = game.race;
    if (car.factionId !== 'carnival') return { ok: false, reason: 'Не та фракция' };
    if (car.flags.mineReturned) return { ok: false, reason: 'Уже использовано' };
    if (car.hand.length >= 5) return { ok: false, reason: 'Рука полна' };
    car.flags.mineReturned = true;
    addCardToHand(game, car, 'mine');
    log(game, car.name + ' → «Оставь им подарок»: мина возвращена в руку', 'ability');
    return { ok: true };
  }

  function armTurbo(game, car) {
    const r = game.race;
    if (!hasUpgrade(car, 'turbo')) return { ok: false, reason: 'Нет турбины' };
    if (car.flags.turboUsed) return { ok: false, reason: 'Турбина уже использована в этой гонке' };
    if (!r.turn || r.phase !== 'prep') return { ok: false, reason: 'Только до броска движения' };
    car.flags.turboArmed = true;
    log(game, car.name + ' → турбина взведена: следующий бросок движения удвоится', 'ability');
    return { ok: true };
  }

  function armWildfire(game, car) {
    const r = game.race;
    if (car.factionId !== 'chrome') return { ok: false, reason: 'Только Хромированные' };
    if (!r.turn || r.phase !== 'fire') return { ok: false, reason: 'Только в фазе огня' };
    if (r.turn.fireUsed) return { ok: false, reason: 'Огонь уже использован' };
    if ((car.flags.wildfireCharges || 0) <= 0) return { ok: false, reason: 'Заряды Wildfire закончились' };
    r.turn.wildfire = !r.turn.wildfire;
    log(game, car.name + (r.turn.wildfire
      ? ' → «Дикий огонь»: следующий выстрел без отдачи.'
      : ' → «Дикий огонь» отменён.'), 'ability');
    return { ok: true, armed: r.turn.wildfire, charges: car.flags.wildfireCharges };
  }

  /* ------------------------------------------------------------------ */
  /* Пит-стоп                                                           */
  /* ------------------------------------------------------------------ */
  function startPit(game, car) {
    const r = game.race;
    if (!r.turn || r.phase !== 'prep') return { ok: false, reason: 'Только в фазе подготовки' };
    if (!isPitNode(game, car.node)) return { ok: false, reason: 'Нужно стоять на тайле пит-лейна' };
    if (car.flags.pitThisRace) return { ok: false, reason: 'Пит уже был в этой гонке' };
    const turns = car.factionId === 'rust' ? 1 : 2; // + текущий ход = 2 / 3
    const heal = CnA.d4(game.rng) + 2;
    car.hp = Math.min(car.maxHp, car.hp + heal);
    car.burn = false;
    car.pit = { turns };
    car.flags.pitThisRace = true;
    r.turn.prepUsed = true;
    r.turn.pitDeclared = true;
    drawCard(game, car, 5); // добираем до лимита
    log(game, car.name + ' → пит-стоп: +' + heal + ' корпуса, рука добрана. Осталось ходов: ' + (turns + 1), 'pit');
    return { ok: true, heal };
  }

  /* ------------------------------------------------------------------ */
  /* Начало и конец хода                                                */
  /* ------------------------------------------------------------------ */
  function beginTurn(game) {
    const r = game.race;
    if (!r || r.over) return { skip: true, over: true, car: null };
    const car = currentCar(game);
    if (!car) return { skip: true, car: null };
    r.phase = 'prep';
    r.turn = null;

    if (car.finished) return { car, skip: true, reason: 'finish' };

    if (car.destroyed) {
      car.downTurns--;
      let respawned = false;
      if (car.downTurns <= 0) { respawnCar(game, car); respawned = true; }
      log(game, car.name + (respawned ? ' возвращается в гонку после уничтожения.' : ' пропускает ход (ремонт после уничтожения).'), 'death');
      return { car, skip: true, reason: 'destroyed', respawned };
    }

    if (car.pit) {
      const heal = CnA.d4(game.rng) + 2;
      car.hp = Math.min(car.maxHp, car.hp + heal);
      car.pit.turns--;
      let done = false;
      if (car.pit.turns <= 0) { car.pit = null; done = true; }
      log(game, car.name + ' в боксах: +' + heal + ' корпуса' + (done ? '. Выезжает на трассу.' : '.'), 'pit');
      return { car, skip: true, reason: 'pit', healed: heal, pitDone: done };
    }

    if (car.spawnProtect) {
      car.spawnProtect = false;
      log(game, car.name + ' больше не под защитой после возврата.', 'info');
    }

    if (car.smoke) car.smoke = false;

    const empDisabled = !!car.emp;
    car.emp = false;

    let burnDamage = 0;
    if (car.burn) {
      const roll = CnA.d4(game.rng);
      if (roll === 4) {
        car.burn = false;
        log(game, car.name + ' сбивает пламя (d4=4).', 'status');
      } else {
        burnDamage = damageCar(game, car, roll, null, { cause: 'burn' });
        log(game, car.name + ' горит: ' + roll + ' урона.', 'damage');
        if (car.destroyed) return { car, skip: true, reason: 'burned', burnDamage };
      }
    }

    r.turn = {
      speed: 0,
      remaining: 0,
      rolled: false,
      prepUsed: false,
      fireUsed: false,
      freeTrapUsed: false,
      nitro: false,
      brake: false,
      ignoreHazards: false,
      eventPending: false,
      pitDeclared: false,
      extraAttack: false,
      speedBase: 0,
      empDisabled,
      wildfire: false,
      rollMult: 1,
      rollPlus: 0,
    };
    r.phase = 'prep';
    if (empDisabled) log(game, car.name + ' под действием ЭМИ: атака и ловушки в этот ход недоступны.', 'status');
    return { car, skip: false, burnDamage };
  }

  function endTurn(game) {
    const r = game.race;
    if (!r) return { raceOver: true };
    if (r.over) return { raceOver: true, results: r.results };
    const car = currentCar(game);
    if (car && !car.destroyed && !car.finished && !car.pit) {
      if (game.options.draw && car.hand.length < 5) drawCard(game, car, game.options.draw);
    }
    r.phase = 'prep';
    r.turn = null;
    r.turnIdx++;

    if (r.turnIdx >= r.order.length) {
      r.round++;
      r.roundEffect = { rangeCap: null, rangeDelta: 0 };
      if (r.firstFinishRound !== null && r.round > r.firstFinishRound + game.options.extraRounds) {
        return { raceOver: true, results: endRace(game) };
      }
      r.order = roundOrder(game);
      r.turnIdx = 0;
      if (!r.order.length) {
        return { raceOver: true, results: endRace(game) };
      }
    }
    r.currentId = r.order[r.turnIdx];
    r.phase = 'prep';
    return { raceOver: false, car: currentCar(game) };
  }

  /* ------------------------------------------------------------------ */
  /* Движение                                                           */
  /* ------------------------------------------------------------------ */
  function rollMove(game, car) {
    const r = game.race;
    if (!r.turn || r.phase !== 'prep') return { ok: false, reason: 'Сейчас нельзя бросать движение' };
    if (car.destroyed || car.finished) return { ok: false, reason: 'Машина не может двигаться' };
    r.phase = 'move';
    const mods = [];
    let roll = CnA.d4(game.rng);
    let base = roll;
    let mult = 1;
    if (car.flags.turboArmed && hasUpgrade(car, 'turbo')) {
      base = base * 2;
      mult = 2;
      car.flags.turboArmed = false;
      car.flags.turboUsed = true;
      mods.push('турбина ×2');
    }
    const um = upgradeMods(car);
    let total = base;
    if (um.move) { total += um.move; mods.push('двигатель +' + um.move); }

    // слипстрим: прямо впереди есть чужая машина
    const ahead = r.track.nodes[car.node].next;
    const slip = ahead.some((n) => activeCarsAt(game, n).length > 0);
    if (slip) { total += 1; mods.push('слипстрим +1'); }

    if (car.nextMoveBonus) { total += car.nextMoveBonus; mods.push('бонус +' + car.nextMoveBonus); }
    if (car.nextMovePenalty) { total -= car.nextMovePenalty; mods.push('штраф −' + car.nextMovePenalty); }

    const ratio = car.hp / car.maxHp;
    if (ratio <= 0.2) { total -= 2; mods.push('корпус горит −2'); }
    else if (ratio <= 0.5) { total -= 1; mods.push('корпус дымит −1'); }

    let nitroRoll = 0;
    if (r.turn.nitro) {
      nitroRoll = CnA.d4(game.rng);
      total += nitroRoll;
      mods.push('нитро +' + nitroRoll);
    }

    if (r.turn.brake) {
      total = 1;
      r.turn.ignoreHazards = true;
      mods.push('экстренный тормоз');
    }

    r.turn.rollMult = mult;
    r.turn.rollPlus = total - base;
    total = CnA.clamp(total, 1, 8);
    car.nextMoveBonus = 0;
    car.nextMovePenalty = 0;
    car.lastMove = total;

    r.turn.speed = total;
    r.turn.remaining = total;
    r.turn.rolled = true;
    r.turn.roll = roll;
    r.turn.nitroRoll = nitroRoll;
    r.turn.mods = mods;
    r.stats.turns++;
    r.stats.movementSum += total;
    car.raceStats = car.raceStats || {};
    car.raceStats.turns = (car.raceStats.turns || 0) + 1;

    log(game, car.name + ' бросает d4: ' + roll + (nitroRoll ? ' (+нитро ' + nitroRoll + ')' : '') + ' → движение ' + total + (mods.length ? ' [' + mods.join(', ') + ']' : ''), 'move');

    if (r.turn.nitro && total >= 7) {
      const dmg = damageCar(game, car, 1, null, { cause: 'overheat' });
      log(game, car.name + ' перегревается: 1 урон.', 'damage');
      if (car.destroyed) return { ok: true, roll, total, mods, destroyed: true, overheat: 1 };
      return { ok: true, roll, total, mods, overheat: dmg };
    }
    return { ok: true, roll, total, mods };
  }

  function rerollMove(game, car) {
    const r = game.race;
    if (!r.turn || r.phase !== 'move' || !r.turn.rolled) return { ok: false, reason: 'Сначала брось движение' };
    if (car.destroyed || car.finished) return { ok: false, reason: 'Машина не может двигаться' };
    if (car.flags.rerollUsed) return { ok: false, reason: 'Реролл уже использован в этой гонке' };
    if (r.turn.brake) return { ok: false, reason: 'С экстренным тормозом переброс недоступен' };
    if (r.turn.remaining !== r.turn.speed) return { ok: false, reason: 'Машина уже начала движение' };

    const old = r.turn.speed;
    const roll = CnA.d4(game.rng);
    const total = CnA.clamp(roll * (r.turn.rollMult || 1) + (r.turn.rollPlus || 0), 1, 8);
    car.flags.rerollUsed = true;
    r.stats.movementSum += total - old;
    r.turn.roll = roll;
    r.turn.speed = total;
    r.turn.remaining = total;
    car.lastMove = total;
    log(game, car.name + ' перебрасывает d4: ' + roll + ' → движение ' + total + ' (было ' + old + ').', 'move');

    if (r.turn.nitro && total >= 7) {
      const dmg = damageCar(game, car, 1, null, { cause: 'overheat' });
      log(game, car.name + ' перегревается при перебросе: 1 урон.', 'damage');
      if (car.destroyed) return { ok: true, roll, total, destroyed: true, overheat: dmg, old };
      return { ok: true, roll, total, overheat: dmg, old };
    }
    return { ok: true, roll, total, old };
  }

  function movementOptions(game, car) {
    const r = game.race;
    if (!r.turn || r.phase !== 'move' || r.turn.remaining <= 0) return [];
    const node = r.track.nodes[car.node];
    const opts = [];
    if (node.type === 'ramp') {
      node.next.forEach((mid) => {
        const midNode = r.track.nodes[mid];
        midNode.next.forEach((dest) => {
          if (!opts.some((o) => o.node === dest)) opts.push({ node: dest, jump: true, via: mid });
        });
      });
      if (!opts.length) node.next.forEach((dest) => opts.push({ node: dest, jump: false, via: null }));
      return opts;
    }
    node.next.forEach((dest) => opts.push({ node: dest, jump: false, via: null }));
    return opts;
  }

  function findTokens(game, nodeId) {
    return game.race.tokens.filter((t) => t.node === nodeId);
  }

  function stepMovement(game, car, nodeId, jump) {
    const r = game.race;
    if (!r.turn || r.phase !== 'move') return { ok: false, reason: 'Не фаза движения' };
    const opts = movementOptions(game, car);
    const opt = opts.find((o) => o.node === nodeId);
    if (!opt) return { ok: false, reason: 'Недоступный тайл' };
    r.turn.remaining--;
    const events = [];
    const dest = nodeId;
    const destNode = r.track.nodes[dest];

    if (jump) {
      log(game, car.name + ' прыгает с трамплина через тайл ' + opt.via + '.', 'move');
      if (r.turn.speed >= 6) {
        const dmgRoll = CnA.d4(game.rng);
        const dmg = damageCar(game, car, dmgRoll, null, { cause: 'ramp' });
        log(game, car.name + ' жёстко приземляется: ' + dmgRoll + ' урона.', 'damage');
        events.push({ type: 'damage', carId: car.id, amount: dmg, text: 'приземление' });
        if (car.destroyed) { r.turn.remaining = 0; return { ok: true, node: car.node, stop: true, destroyed: true, events }; }
      }
    }

    // Ёмкость тайла: третья машина не входит, происходит таран.
    if (capacityAt(game, dest) >= 2) {
      const res = resolveRam(game, car, dest);
      r.turn.remaining = 0;
      events.push({ type: 'ram', text: res.text });
      if (res.destroyed) events.push({ type: 'damage', carId: res.destroyedId, amount: 0, text: 'уничтожение' });
      return { ok: true, node: car.node, stop: true, ram: res, events };
    }

    car.node = dest;
    events.push({ type: 'move', node: dest });

    // Жетоны
    const tokens = findTokens(game, dest).slice();
    for (const tok of tokens) {
      if (car.destroyed) break;
      if (tok.type === 'mine') {
        if (hasUpgrade(car, 'magnet')) {
          r.tokens = r.tokens.filter((t) => t !== tok);
          if (addCardToHand(game, car, 'mine')) log(game, car.name + ' магнитным захватом снимает мину с тайла.', 'ability');
          else log(game, car.name + ' снимает мину, но рука полна.', 'ability');
          continue;
        }
        const dmgRoll = CnA.rollDice(game.rng, '2d4');
        const dmg = damageCar(game, car, dmgRoll, tok.owner != null ? carById(game, tok.owner) : null, { cause: 'mine', mine: true });
        r.tokens = r.tokens.filter((t) => t !== tok);
        r.stats.mineTriggers++;
        if (tok.owner != null) { const o = carById(game, tok.owner); if (o) o.raceStats.mineTriggers = (o.raceStats.mineTriggers || 0) + 1; }
        log(game, 'МИНА! ' + car.name + ' получает ' + dmg + ' урона (2d4=' + dmgRoll + ').', 'damage');
        events.push({ type: 'damage', carId: car.id, amount: dmg, text: 'мина' });
        if (car.destroyed) { r.turn.remaining = 0; return { ok: true, node: dest, stop: true, destroyed: true, events }; }
      } else if (tok.type === 'oil') {
        if (hasUpgrade(car, 'magnet')) {
          r.tokens = r.tokens.filter((t) => t !== tok);
          if (addCardToHand(game, car, 'oil')) log(game, car.name + ' собирает масло магнитным захватом.', 'ability');
          continue;
        }
        const roll = CnA.d4(game.rng);
        r.stats.oilTriggers++;
        if (roll <= 2 && !hasUpgrade(car, 'balance')) {
          car.nextMovePenalty += 1;
          r.turn.remaining = 0;
          log(game, car.name + ' попадает в масло: занос (d4=' + roll + '), ход окончен и −1 к следующему движению.', 'status');
          events.push({ type: 'skid', text: 'масло' });
          r.turn.remaining = 0;
          break;
        } else {
          log(game, car.name + ' проскакивает масло (d4=' + roll + ').', 'move');
        }
      } else if (tok.type === 'fire') {
        const dmgRoll = CnA.d4(game.rng);
        const dmg = damageCar(game, car, dmgRoll, null, { cause: 'fire' });
        r.tokens = r.tokens.filter((t) => t !== tok);
        log(game, car.name + ' проезжает огонь: ' + dmgRoll + ' урона.', 'damage');
        events.push({ type: 'damage', carId: car.id, amount: dmg, text: 'огонь' });
        if (car.destroyed) { r.turn.remaining = 0; return { ok: true, node: dest, stop: true, destroyed: true, events }; }
      } else if (tok.type === 'wreck') {
        if (!hasUpgrade(car, 'tracks') && !r.turn.ignoreHazards) {
          r.turn.remaining = Math.max(0, r.turn.remaining - 1);
          log(game, car.name + ' пробирается через обломки: −1 к движению.', 'move');
        }
      }
    }

    if (car.destroyed) { r.turn.remaining = 0; return { ok: true, node: dest, stop: true, destroyed: true, events }; }

    // Эффект тайла
    const ignore = r.turn.ignoreHazards;
    if (destNode.type === 'sand') {
      if (!ignore && !hasUpgrade(car, 'suspension')) {
        r.turn.remaining = Math.max(0, r.turn.remaining - 1);
        log(game, car.name + ' вязнет в песке: −1 к движению.', 'move');
      }
    } else if (destNode.type === 'debris') {
      if (!ignore) {
        const dmg = 1;
        damageCar(game, car, dmg, null, { cause: 'debris' });
        log(game, car.name + ' влетает в обломки: ' + dmg + ' урона.', 'damage');
        events.push({ type: 'damage', carId: car.id, amount: dmg, text: 'обломки' });
        if (car.destroyed) { r.turn.remaining = 0; return { ok: true, node: dest, stop: true, destroyed: true, events }; }
        if (!hasUpgrade(car, 'tracks')) r.turn.remaining = Math.max(0, r.turn.remaining - 1);
      }
    } else if (destNode.type === 'turn') {
      if (r.turn.speed >= 5 && !ignore && !hasUpgrade(car, 'balance')) {
        const roll = CnA.d4(game.rng);
        if (roll === 1) {
          car.nextMovePenalty += 2;
          r.turn.remaining = 0;
          log(game, car.name + ' сносит на повороте (d4=1): занос, ход окончен, −2 к следующему движению.', 'status');
          events.push({ type: 'skid', text: 'поворот' });
        } else {
          log(game, car.name + ' проходит поворот на грани (d4=' + roll + ').', 'move');
        }
      }
    } else if (destNode.type === 'ramp') {
      log(game, car.name + ' заезжает на трамплин.', 'move');
    } else if (destNode.type === 'bridge') {
      car.onBridge = true;
    } else if (destNode.type === 'event') {
      // событие разыгрывается только если здесь закончится движение
    }

    // Пересечение старт-финиша
    if (dest === r.track.startNode && !car.finished) {
      const wasStart = car.lapsDone < 0;
      car.lapsDone++;
      if (wasStart) {
        log(game, car.name + ' пересекает стартовую линию. Поехали!', 'lap');
      } else {
        r.stats.laps++;
        log(game, car.name + ' пересекает старт-финиш. Круг ' + car.lapsDone + '/' + game.laps + '.', 'lap');
        events.push({ type: 'lap' });
        if (car.lapsDone >= 1 && isLeader(game, car)) {
          car.cp += 2;
          car.raceLeaderCp += 2;
          car.leaderLaps++;
          log(game, car.name + ' лидирует: +2 очка чемпионата за круг.', 'cp');
        }
      }
      if (car.lapsDone >= game.laps) {
        finishCar(game, car);
        r.turn.remaining = 0;
        events.push({ type: 'finish' });
        return { ok: true, node: dest, stop: true, finished: true, events };
      }
    }

    if (r.turn.remaining <= 0) {
      return { ok: true, node: dest, stop: true, events };
    }
    return { ok: true, node: dest, stop: false, events };
  }

  function finishMovement(game, car) {
    const r = game.race;
    if (!r.turn) return {};

    // Событие Пустоши, если машина закончила движение на «?»
    let event = null;
    const node = r.track.nodes[car.node];
    if (!car.destroyed && !car.finished && node && node.type === 'event' && !r.turn.eventPending) {
      r.turn.eventPending = true;
      event = drawEvent(game, car);
    }
    if (car.destroyed || car.finished) {
      r.phase = 'done';
      return { event };
    }
    r.phase = 'fire';
    r.turn.fireUsed = false;
    return { event };
  }

  /* ------------------------------------------------------------------ */
  /* Таран                                                              */
  /* ------------------------------------------------------------------ */
  function resolveRam(game, attacker, targetNode) {
    const r = game.race;
    const defenders = activeCarsAt(game, targetNode).filter((c) => c.id !== attacker.id && !c.spawnProtect);
    if (!defenders.length) return { text: 'Таран не состоялся: цель ушла.', destroyedId: null };
    const defender = defenders[Math.floor(game.rng() * defenders.length)];

    let aRoll = CnA.d4(game.rng);
    if (r.turn && r.turn.ramBonus) aRoll += r.turn.ramBonus;
    const dRoll = CnA.d4(game.rng);
    const aSpeed = r.turn ? r.turn.speed : 0;
    const dSpeed = defender.lastMove || 0;
    const aTotal = aRoll + aSpeed;
    const dTotal = dRoll + dSpeed;

    function ramFormula(car) {
      if (hasUpgrade(car, 'spikes')) return '2d4';
      return 'd4';
    }

    const out = { attacker: attacker.id, defender: defender.id, aRoll, dRoll, aSpeed, dSpeed, aTotal, dTotal, damage: 0, destroyedId: null };

    if (aTotal > dTotal) {
      let formula = ramFormula(attacker);
      // Таранный отвал у атакующего — автоматически
      const plate = attacker.hand.find((c) => c.type === 'ramplate');
      if (plate) {
        discardCard(game, attacker, plate.uid);
        formula = '2d4';
        log(game, attacker.name + ' разыгрывает таранный отвал.', 'card');
      }
      const dmg = CnA.rollDice(game.rng, formula);
      out.damage = damageCar(game, defender, dmg, attacker, { cause: 'ram' });
      out.formula = formula;
      log(game, 'ТАРАН: ' + attacker.name + ' (' + aRoll + '+' + aSpeed + ') против ' + defender.name + ' (' + dRoll + '+' + dSpeed + '). ' + defender.name + ' получает ' + out.damage + ' урона.', 'ram');
      pushBack(game, defender, 1);
      out.winner = attacker.id;
      if (defender.destroyed) out.destroyedId = defender.id;
    } else if (dTotal > aTotal) {
      let formula = ramFormula(defender);
      const plate = defender.hand.find((c) => c.type === 'ramplate');
      if (plate) {
        discardCard(game, defender, plate.uid);
        formula = '2d4';
        log(game, defender.name + ' разыгрывает таранный отвал.', 'card');
      }
      const dmg = CnA.rollDice(game.rng, formula);
      out.damage = damageCar(game, attacker, dmg, defender, { cause: 'ram' });
      out.formula = formula;
      log(game, 'ТАРАН: ' + attacker.name + ' (' + aRoll + '+' + aSpeed + ') против ' + defender.name + ' (' + dRoll + '+' + dSpeed + '). ' + attacker.name + ' получает ' + out.damage + ' урона.', 'ram');
      pushBack(game, attacker, 1);
      out.winner = defender.id;
      if (attacker.destroyed) out.destroyedId = attacker.id;
    } else {
      const aDmg = CnA.rollDice(game.rng, ramFormula(attacker));
      const dDmg = CnA.rollDice(game.rng, ramFormula(defender));
      out.damage = damageCar(game, defender, aDmg, attacker, { cause: 'ram' }) + damageCar(game, attacker, dDmg, defender, { cause: 'ram' });
      out.tie = true;
      log(game, 'ТАРАН: ничья (' + aTotal + ':' + dTotal + '). Обе машины получают урон: ' + aDmg + ' и ' + dDmg + '.', 'ram');
      if (attacker.destroyed) out.destroyedId = attacker.id;
      else if (defender.destroyed) out.destroyedId = defender.id;
    }

    return out;
  }

  function pushBack(game, car, steps) {
    if (car.destroyed || car.finished) return;
    let node = car.node;
    for (let i = 0; i < steps; i++) {
      // Не даём принудительно пересекать старт-финиш назад: иначе
      // машину можно «перекинуть» через линию и сломать счётчик кругов.
      if (node === game.race.track.startNode) break;
      const prev = game.race.track.nodes[node].prev;
      if (!prev || !prev.length) break;
      node = prev[0];
    }
    if (capacityAt(game, node) < 2 && node !== car.node) {
      car.node = node;
      log(game, car.name + ' отброшен на тайл ' + node + '.', 'move');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Урон и уничтожение                                                 */
  /* ------------------------------------------------------------------ */
  function damageCar(game, car, amount, source, opts) {
    opts = opts || {};
    if (!car || car.finished || car.destroyed) return 0;
    if (car.pit && !opts.event) return 0;
    if (car.spawnProtect && !opts.event) return 0;
    if (amount <= 0) return 0;
    if (car.flags.reactive && !car.flags.reactiveUsed && !opts.pierceReactive) {
      car.flags.reactiveUsed = true;
      log(game, car.name + ': реактивные пластины гасят первое попадание.', 'ability');
      return 0;
    }
    if (opts.mine && hasUpgrade(car, 'plow')) amount = Math.ceil(amount / 2);
    amount = Math.max(0, Math.round(amount));
    if (car.shield > 0) {
      const absorbed = Math.min(car.shield, amount);
      car.shield -= absorbed;
      amount -= absorbed;
      log(game, car.name + ': броня гасит ' + absorbed + ' урона' + (car.shield ? ' (осталось ' + car.shield + ')' : '') + '.', 'ability');
      if (amount <= 0) return 0;
    }
    car.hp -= amount;
    car.raceDamageTaken += amount;
    const r = game.race;
    r.stats.damage += amount;
    const causeKey = opts.cause || 'attack';
    r.stats.damageBy[causeKey] = (r.stats.damageBy[causeKey] || 0) + amount;
    if (source && source.id !== car.id) {
      source.raceDamage += amount;
      source.damageTotal += amount;
      source.raceStats.damage = (source.raceStats.damage || 0) + amount;
    }
    if (car.hp <= 0) {
      destroyCar(game, car, source, opts.cause || 'attack');
    }
    return amount;
  }

  function checkpointFor(game, car) {
    const t = game.race.track;
    if (car.lapsDone < 0) return t.count - 1; // ещё не пересёк старт — возвращаем на решётку
    const half = t.checkpoints && t.checkpoints.length > 1 ? t.checkpoints[1] : Math.floor(t.count / 2);
    const halfDist = t.distFromStart[half] || 0;
    const dist = t.distFromStart[car.node] || 0;
    return dist >= halfDist ? half : 0;
  }

  function destroyCar(game, car, source, cause) {
    if (car.destroyed) return;
    const r = game.race;
    car.hp = 0;
    car.destroyed = true;
    car.downTurns = hasUpgrade(car, 'cage') ? 1 : 2;
    let respawn = 0;
    if (r.track.nodes[car.node].type === 'bridge') respawn = CnA.behindNode(r.track, car.node, 3);
    else if (game.options.checkpoints) respawn = checkpointFor(game, car);
    car.respawnNode = respawn;
    car.burn = false;
    car.smoke = false;
    car.shield = 0;
    car.emp = false;
    car.pit = null;

    // Жетон обломков
    r.tokens.push({ type: 'wreck', node: car.node, owner: car.id });
    // Сброс случайной карты
    if (car.hand.length) {
      const idx = Math.floor(game.rng() * car.hand.length);
      const card = car.hand.splice(idx, 1)[0];
      r.discard.push(card.type);
    }
    // Потеря лома
    const lost = Math.min(3, car.scrap);
    car.scrap -= lost;

    if (source && source.id !== car.id) {
      const killCp = (source.lapsDone || 0) < 1 ? 1 : 3;
      source.cp += killCp;
      source.raceCpKills += killCp;
      source.scrap += 5;
      source.raceScrapKills += 5;
      source.raceKills++;
      source.killsTotal++;
      log(game, source.name + ' уничтожает ' + car.name + ': +' + killCp + (killCp === 1 ? ' очко' : ' очка') + ', +5 лома.', 'kill');
    } else {
      log(game, car.name + ' уничтожена.', 'death');
    }
    r.stats.destructions++;
    r.stats.deathsBy[cause] = (r.stats.deathsBy[cause] || 0) + 1;

    // Награды за уничтожение — сразу (зеркально дизайну), позиционные — в конце гонки.
    car.lastKiller = source ? source.id : null;
    car.lastCause = cause;
  }

  function respawnCar(game, car) {
    const r = game.race;
    let node = car.respawnNode;
    let guard = 0;
    // Ищем свободное место ВПЕРЁД по трассе, а не назад: иначе машину,
    // уже пересекшую старт, можно вернуть за линию и «подарить» круг.
    while (capacityAt(game, node) >= 2 && guard < r.track.nodes.length) {
      node = CnA.aheadNode(r.track, node, 1);
      guard++;
    }
    car.node = node;
    car.lapsDone = Math.max(-1, car.lapsDone);
    car.hp = Math.max(1, Math.ceil(car.maxHp * (game.options.respawnFraction || 0.5)));
    car.destroyed = false;
    car.downTurns = 0;
    car.burn = false;
    car.smoke = false;
    car.shield = 0;
    car.emp = false;
    car.raceDamageTaken = 0;
    car.spawnProtect = !!game.options.spawnProtect;
    log(game, car.name + ' возвращается на трассу с ' + car.hp + ' корпуса.' + (car.spawnProtect ? ' До своего следующего хода защищена от огня.' : ''), 'death');
  }

  function finishCar(game, car) {
    const r = game.race;
    if (car.finished) return;
    car.finished = true;
    car.finishPos = r.finishOrder.length + 1;
    r.finishOrder.push(car.id);
    r.stats.finishes++;
    if (r.firstFinishRound === null) r.firstFinishRound = r.round;
    log(game, '🏁 ' + car.name + ' финиширует ' + car.finishPos + '-м!', 'finish');
    if (r.finishOrder.length >= game.cars.length) {
      r.over = true;
      endRace(game);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Атаки                                                              */
  /* ------------------------------------------------------------------ */
  function effectiveRange(game, car, card) {
    if (!card || !card.range) return 0;
    let range = card.range;
    if (hasUpgrade(car, 'barrel')) range++;
    if (car.factionId === 'swarm') range++;
    const re = game.race.roundEffect || {};
    if (re.rangeDelta) range += re.rangeDelta;
    if (re.rangeCap != null) range = Math.min(range, re.rangeCap);
    range = Math.max(1, range);
    if (game.race.track.nodes[car.node].type === 'tunnel') range = Math.min(range, 1);
    return range;
  }

  function losClear(track, path) {
    for (let i = 1; i < path.length - 1; i++) {
      const t = track.nodes[path[i]].type;
      if (t !== 'straight' && t !== 'start' && t !== 'pit' && t !== 'bridge') return false;
    }
    return true;
  }

  function attackTargets(game, car, cardId) {
    const r = game.race;
    const card = CnA.CARDS[cardId];
    if (!card || card.kind !== 'attack') return [];
    const range = effectiveRange(game, car, card);
    if (range <= 0) return [];
    const turret = hasUpgrade(car, 'turret');
    const dirs = turret ? ['fwd', 'back'] : (card.dir === 'both' ? ['fwd', 'back'] : [card.dir]);
    const fwd = dirs.indexOf('fwd') >= 0 ? CnA.trackForwardPath(r.track, car.node, range + 2) : null;
    const back = dirs.indexOf('back') >= 0 ? CnA.trackBackwardPath(r.track, car.node, range + 2) : null;
    const out = [];
    game.cars.forEach((t) => {
      if (t.id === car.id || t.finished || t.destroyed || t.pit || t.spawnProtect) return;
      let hit = null;
      if (fwd && fwd[t.node] && fwd[t.node].dist >= 1 && fwd[t.node].dist <= range) {
        const path = fwd[t.node].path;
        const clear = turret || !card.los || losClear(r.track, path);
        if (clear) hit = { dir: 'fwd', dist: fwd[t.node].dist, path };
      }
      if (!hit && back && back[t.node] && back[t.node].dist >= 1 && back[t.node].dist <= range) {
        hit = { dir: 'back', dist: back[t.node].dist, path: back[t.node].path };
      }
      if (!hit) return;
      if (t.smoke && hit.dist >= 2) return;
      out.push({ carId: t.id, dir: hit.dir, dist: hit.dist, path: hit.path, cardId });
    });
    return out;
  }

  function targetIsLeader(game, target) {
    return isLeader(game, target);
  }

  function swarmBonus(game, attacker, target) {
    if (attacker.factionId !== 'swarm') return 0;
    if (attacker.id === target.id) return 0;
    return targetIsLeader(game, target) ? 2 : 0;
  }

  function attackDamage(game, attacker, card) {
    const roll = CnA.rollDice(game.rng, card.dmg);
    return { roll, damage: roll };
  }

  function consumeFire(game, car) {
    const r = game.race;
    r.turn.fireUsed = true;
    if (hasUpgrade(car, 'autoloader') && !car.flags.autoloaderUsed) {
      car.flags.autoloaderUsed = true;
      r.turn.extraAttack = true;
      r.turn.fireUsed = false;
      log(game, car.name + ': автозарядка — можно провести вторую атаку.', 'ability');
    }
  }

  function tryJammer(game, target) {
    const jam = target.hand.find((c) => c.type === 'jammer');
    if (!jam) return false;
    discardCard(game, target, jam.uid);
    log(game, target.name + ': ГЛУШИЛКА — атака отменена.', 'card');
    return true;
  }

  function applyRecoil(game, car) {
    const r = game.race;
    if (r.turn && r.turn.wildfire && (car.flags.wildfireCharges || 0) > 0) {
      r.turn.wildfire = false;
      car.flags.wildfireCharges--;
      log(game, car.name + ' → «Дикий огонь»: выстрел без отдачи (осталось ' + car.flags.wildfireCharges + ').', 'ability');
      return;
    }
    if (r.turn) r.turn.wildfire = false;
    car.nextMovePenalty += 1;
    log(game, car.name + ' → отдача: −1 к следующему движению.', 'move');
  }

  function playAttack(game, car, cardUid, targetId) {
    const r = game.race;
    if (!r.turn || r.phase !== 'fire') return { ok: false, reason: 'Не фаза огня' };
    if (r.turn.fireUsed) return { ok: false, reason: 'Атака уже была' };
    if (r.turn.empDisabled) return { ok: false, reason: 'ЭМИ: атака недоступна' };
    const h = car.hand.find((c) => c.uid === cardUid);
    if (!h) return { ok: false, reason: 'Карты нет в руке' };
    const card = CnA.CARDS[h.type];
    if (card.kind !== 'attack') return { ok: false, reason: 'Это не атака' };
    const targets = attackTargets(game, car, h.type);
    const t = targets.find((x) => x.carId === targetId);
    if (!t) return { ok: false, reason: 'Цель вне дальности' };
    const target = carById(game, targetId);

    discardCard(game, car, cardUid);
    r.stats.cardsPlayed++;
    r.stats.attacks++;
    car.raceStats.attacks = (car.raceStats.attacks || 0) + 1;

    if (tryJammer(game, target)) {
      consumeFire(game, car);
      return { ok: true, jammed: true, text: 'Глушилка отменила атаку' };
    }

    const dmgInfo = attackDamage(game, car, card);
    let damage = card.noDamage ? 0 : dmgInfo.damage + swarmBonus(game, car, target);
    if (card.id === 'mine') damage = Math.ceil(damage / (hasUpgrade(target, 'plow') ? 2 : 1));
    const dealt = damageCar(game, target, damage, car, { cause: card.id === 'mine' ? 'mine' : 'attack', mine: card.id === 'mine' });
    const parts = card.noDamage
      ? [car.name + ' → ' + card.name + ' по ' + target.name]
      : [car.name + ' → ' + card.name + ' по ' + target.name + ': ' + dmgInfo.roll + ' урона' + (swarmBonus(game, car, target) ? ' +2 (лидер)' : '') + ' (факт. ' + dealt + ')'];

    if (card.id === 'mg' && dmgInfo.roll === 4) {
      target.nextMovePenalty += 1;
      parts.push('пробито колесо: −1 к следующему движению');
    }
    if (card.id === 'rocket' && !target.destroyed) {
      pushBack(game, target, 1);
      parts.push('цель отброшена на 1 тайл');
    }
    if (card.id === 'harpoon') {
      if (t.dist > 1 && t.path && t.path.length >= 2) {
        const pullTo = t.path[t.path.length - 2];
        if (target.node !== r.track.startNode && pullTo !== r.track.startNode && capacityAt(game, pullTo) < 2) {
          target.node = pullTo;
          parts.push('цель подтянута на 1 тайл');
        }
      }
      car.nextMoveBonus += 1;
      parts.push('+1 к следующему движению');
    }
    if (card.id === 'flamer' && !target.destroyed) {
      target.burn = true;
      parts.push('цель горит');
    }
    if (card.id === 'emp' && !target.destroyed) {
      target.emp = true;
      parts.push('цель заглушена на следующий ход');
    }
    if (card.id === 'net' && !target.destroyed) {
      target.nextMovePenalty += 2;
      parts.push('цель опутана сетью: −2 к движению');
    }
    if (card.id === 'sabotage' && !target.destroyed && target.hand.length) {
      discardRandomCard(game, target);
      parts.push('цель теряет случайную карту');
    }
    if (card.id === 'tow' && !target.destroyed) {
      let pulled = 0;
      for (let i = 0; i < 2; i++) {
        if (target.node === r.track.startNode) break;
        if (t.dist - pulled > 1 && t.path && t.path.length >= (pulled + 2)) {
          const pullTo = t.path[t.path.length - 2 - pulled];
          if (pullTo === r.track.startNode) break;
          if (capacityAt(game, pullTo) < 2) {
            target.node = pullTo;
            pulled++;
          } else break;
        }
      }
      if (pulled) parts.push('цель подтянута на ' + pulled + ' тайл(а)');
      if (target.scrap > 0) {
        const stolen = 1;
        target.scrap -= stolen;
        car.scrap += stolen;
        parts.push('украден 1 лом');
      }
    }

    log(game, parts.join('. ') + '.', 'attack');
    consumeFire(game, car);
    applyRecoil(game, car);
    if (car.raceStats.shootTurns !== undefined) car.raceStats.shootTurns++;
    else car.raceStats.shootTurns = 1;
    r.stats.shootTurns++;
    r.stats.fireTurns++;
    return { ok: true, damage: dealt, target: targetId, destroyed: target.destroyed, roll: dmgInfo.roll, text: parts.join('. ') };
  }

  function playTwin(game, car, cardUid, targetIds) {
    const r = game.race;
    if (!r.turn || r.phase !== 'fire' || r.turn.fireUsed) return { ok: false, reason: 'Сейчас нельзя атаковать' };
    if (r.turn.empDisabled) return { ok: false, reason: 'ЭМИ: атака недоступна' };
    const h = car.hand.find((c) => c.uid === cardUid);
    if (!h || h.type !== 'twin') return { ok: false, reason: 'Нет карты' };
    const valid = attackTargets(game, car, 'twin');
    const uniq = Array.from(new Set(targetIds));
    if (uniq.length !== 2) return { ok: false, reason: 'Нужны две разные цели' };
    for (const id of uniq) if (!valid.some((v) => v.carId === id)) return { ok: false, reason: 'Цель вне дальности' };
    discardCard(game, car, cardUid);
    r.stats.cardsPlayed++;
    r.stats.attacks++;
    const results = [];
    for (const id of uniq) {
      const target = carById(game, id);
      if (tryJammer(game, target)) { results.push({ target: id, jammed: true }); continue; }
      const roll = CnA.d4(game.rng);
      let dmg = roll + swarmBonus(game, car, target);
      const dealt = damageCar(game, target, dmg, car, { cause: 'attack' });
      if (roll === 4) target.nextMovePenalty += 1;
      results.push({ target: id, roll, damage: dealt });
      log(game, car.name + ' → спаренный пулемёт по ' + target.name + ': ' + roll + ' урона (факт. ' + dealt + ').', 'attack');
    }
    consumeFire(game, car);
    applyRecoil(game, car);
    car.raceStats.shootTurns = (car.raceStats.shootTurns || 0) + 1;
    r.stats.shootTurns++;
    r.stats.fireTurns++;
    return { ok: true, results };
  }

  function trapOptions(game, car, cardUid) {
    const r = game.race;
    const h = car.hand.find((c) => c.uid === cardUid);
    if (!h) return [];
    const card = CnA.CARDS[h.type];
    if (card.kind !== 'trap') return [];
    if (card.trap === 'mine' && game.options.mineLimit != null) {
      const activeMines = r.tokens.filter((t) => t.type === 'mine').length;
      if (activeMines >= game.options.mineLimit) return [];
    }
    const nodes = [car.node, CnA.behindNode(r.track, car.node, 1)];
    const out = [];
    nodes.forEach((n) => {
      if (n == null) return;
      const hasTrap = r.tokens.some((t) => t.node === n && (t.type === 'mine' || t.type === 'oil'));
      if (!hasTrap) out.push({ node: n, own: n === car.node });
    });
    return out;
  }

  function placeTrap(game, car, cardUid, nodeId) {
    const r = game.race;
    if (!r.turn || r.phase !== 'fire') return { ok: false, reason: 'Не фаза огня' };
    if (r.turn.empDisabled) return { ok: false, reason: 'ЭМИ: ловушки недоступны' };
    const h = car.hand.find((c) => c.uid === cardUid);
    if (!h) return { ok: false, reason: 'Карты нет в руке' };
    const card = CnA.CARDS[h.type];
    if (card.kind !== 'trap') return { ok: false, reason: 'Это не ловушка' };
    const opts = trapOptions(game, car, cardUid);
    if (!opts.some((o) => o.node === nodeId)) return { ok: false, reason: 'Сюда ставить нельзя' };
    const free = car.factionId === 'carnival' && !r.turn.freeTrapUsed;
    if (!free && r.turn.fireUsed) return { ok: false, reason: 'Действие огня уже потрачено' };

    discardCard(game, car, cardUid);
    r.stats.cardsPlayed++;
    r.stats.traps++;
    r.stats.fireTurns++;
    r.tokens.push({ type: card.trap, node: nodeId, owner: car.id });
    if (free) {
      r.turn.freeTrapUsed = true;
      log(game, car.name + ' бесплатно ставит ' + card.name + ' на тайл ' + nodeId + ' (способность фракции).', 'trap');
    } else {
      r.turn.fireUsed = true;
      log(game, car.name + ' ставит ' + card.name + ' на тайл ' + nodeId + '.', 'trap');
    }
    return { ok: true, free, node: nodeId };
  }

  function cardPlayable(game, car, cardUid) {
    const r = game.race;
    if (!r || !r.turn) return false;
    const h = car.hand.find((c) => c.uid === cardUid);
    if (!h) return false;
    const card = CnA.CARDS[h.type];
    if (car.destroyed || car.finished || car.pit) return false;
    if (card.phase === 'prep') return canPlayPrep(game, car, cardUid);
    if (card.phase === 'fire') {
      if (r.phase !== 'fire') return false;
      if (r.turn.empDisabled) return false;
      if (card.kind === 'trap') {
        if (trapOptions(game, car, cardUid).length === 0) return false;
        if (r.turn.fireUsed && !(car.factionId === 'carnival' && !r.turn.freeTrapUsed)) return false;
        return true;
      }
      if (r.turn.fireUsed) return false;
      if (card.twin) return attackTargets(game, car, h.type).length >= 2;
      return attackTargets(game, car, h.type).length >= 1;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* События Пустоши                                                    */
  /* ------------------------------------------------------------------ */
  function drawEvent(game, car) {
    const r = game.race;
    if (!r.eventDeck.length) {
      if (!r.eventDiscard.length) return null;
      r.eventDeck = CnA.shuffle(game.rng, r.eventDiscard);
      r.eventDiscard = [];
    }
    const id = r.eventDeck.pop();
    r.eventDiscard.push(id);
    const ev = CnA.EVENTS.find((e) => e.id === id);
    if (!ev) return null;
    r.stats.events++;
    log(game, 'ПУСТОШЬ: ' + ev.name + '. ' + ev.text, 'event');

    switch (id) {
      case 'sandstorm':
        r.roundEffect.rangeCap = 1;
        break;
      case 'night':
        r.roundEffect.rangeDelta -= 1;
        break;
      case 'scavengers': {
        const nodes = new Set([car.node]);
        r.track.nodes[car.node].prev.forEach((n) => nodes.add(n));
        r.track.nodes[car.node].next.forEach((n) => nodes.add(n));
        game.cars.forEach((c) => {
          if (c.finished || c.destroyed) return;
          if (!nodes.has(c.node)) return;
          const d = CnA.d4(game.rng);
          damageCar(game, c, d, null, { cause: 'event', event: true });
          log(game, c.name + ' получает ' + d + ' урона от падальщиков.', 'damage');
        });
        break;
      }
      case 'depot': {
        const n = drawCard(game, car, 2);
        log(game, car.name + ' находит склад: +' + n + ' карт.', 'event');
        break;
      }
      case 'spill': {
        let node = car.node;
        for (let i = 0; i < 3; i++) {
          const next = r.track.nodes[node].next[0];
          if (next == null) break;
          node = next;
          if (!r.tokens.some((t) => t.node === node && t.type === 'fire')) {
            r.tokens.push({ type: 'fire', node, owner: null });
          }
        }
        log(game, 'Огонь разлит на 3 тайла впереди.', 'event');
        break;
      }
      case 'asphalt':
        car.nextMoveBonus += 2;
        log(game, car.name + ': +2 к следующему движению.', 'event');
        break;
      case 'sinkhole': {
        const node = r.track.nodes[car.node];
        node.type = 'debris';
        log(game, 'Тайл ' + car.node + ' проседает и становится обломками.', 'event');
        break;
      }
      case 'witnesses': {
        const leaders = game.cars.filter((c) => !c.finished && !c.destroyed);
        const last = leaders.slice().sort((a, b) => progressOf(game, a) - progressOf(game, b))[0];
        if (last && last.id === car.id) {
          car.scrap += 3;
          log(game, car.name + ' — последний, свидетели платят: +3 лома.', 'event');
        }
        break;
      }
      case 'fuel':
        car.nextMoveBonus += 1;
        car.scrap += 1;
        log(game, car.name + ': +1 к движению и +1 лом.', 'event');
        break;
      default:
        break;
    }
    return ev;
  }

  /* ------------------------------------------------------------------ */
  /* Конец гонки и экономика                                            */
  /* ------------------------------------------------------------------ */
  function endRace(game) {
    const r = game.race;
    if (r.over && r.results) return r.results;
    r.over = true;
    r.phase = 'done';

    const finished = r.finishOrder.map((id) => carById(game, id));
    const rest = game.cars.filter((c) => !c.finished).slice()
      .sort((a, b) => progressOf(game, b) - progressOf(game, a));
    const ranked = finished.concat(rest);
    const cpTable = [10, 6, 3, 1];
    const dnfCpTable = [5, 3, 1, 0];
    const scrapTable = [4, 6, 8, 10];
    const rows = [];

    ranked.forEach((car, i) => {
      const pos = i + 1;
      car.racePos = pos;
      const cpPos = car.finished ? (cpTable[pos - 1] || 0) : (dnfCpTable[pos - 1] || 0);
      const scrapPos = car.finished ? (scrapTable[pos - 1] || 3) : 3;
      const scrapDamage = Math.floor(car.raceDamage / 5);
      car.cp += cpPos;
      car.scrap += scrapPos + scrapDamage;
      rows.push({
        carId: car.id,
        name: car.name,
        factionId: car.factionId,
        pos,
        finished: car.finished,
        cpPos,
        cpKills: car.raceCpKills,
        cpLeader: car.raceLeaderCp,
        scrapPos,
        scrapDamage,
        scrapKills: car.raceScrapKills,
        scrapDnf: car.finished ? 0 : 3,
        cpGained: car.cp - car.cpStart,
        scrapGained: car.scrap - car.scrapStart,
        damage: car.raceDamage,
        kills: car.raceKills,
        hp: car.hp,
      });
    });

    const results = {
      raceIndex: game.raceIndex,
      laps: game.laps,
      rows,
      stats: r.stats,
      trackSeed: r.track.seed,
      standings: computeStandings(game),
    };
    r.results = results;
    game.results = results;
    game.stage = 'results';
    log(game, 'Гонка завершена.', 'round');
    return results;
  }

  function computeStandings(game) {
    return game.cars.slice().sort((a, b) => {
      if (b.cp !== a.cp) return b.cp - a.cp;
      if (b.damageTotal !== a.damageTotal) return b.damageTotal - a.damageTotal;
      return b.killsTotal - a.killsTotal;
    }).map((c, i) => ({
      place: i + 1,
      carId: c.id,
      name: c.name,
      factionId: c.factionId,
      cp: c.cp,
      damage: c.damageTotal,
      kills: c.killsTotal,
      scrap: c.scrap,
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Мастерская                                                         */
  /* ------------------------------------------------------------------ */
  function countCategory(car, cat) {
    return car.upgrades.filter((id) => {
      const u = CnA.upgrade(id);
      return u && u.cat === cat;
    }).length;
  }

  function canInstall(car, upgrade) {
    if (car.upgrades.indexOf(upgrade.id) >= 0) return { ok: false, reason: 'Уже установлено' };
    if (car.upgrades.length >= car.slots) return { ok: false, reason: 'Нет свободного слота' };
    if (countCategory(car, upgrade.cat) >= 2) return { ok: false, reason: 'Максимум 2 улучшения этой категории' };
    return { ok: true };
  }

  function rollShop(game) {
    const human = game.cars.find((c) => c.human) || game.cars[0];
    const pool = CnA.UPGRADES.filter((u) => human.upgrades.indexOf(u.id) < 0);
    const shuffled = CnA.shuffle(game.rng, pool);
    game.shop = shuffled.slice(0, 5).map((u) => ({ id: u.id, sold: false }));
    return game.shop;
  }

  function buyUpgrade(game, car, upgradeId) {
    const entry = game.shop.find((s) => s.id === upgradeId && !s.sold);
    if (!entry) return { ok: false, reason: 'Этого улучшения нет в витрине' };
    const u = CnA.upgrade(upgradeId);
    if (!u) return { ok: false, reason: 'Нет такого улучшения' };
    if (car.scrap < u.price) return { ok: false, reason: 'Не хватает лома' };
    const chk = canInstall(car, u);
    if (!chk.ok) return chk;
    car.scrap -= u.price;
    car.upgrades.push(u.id);
    const mods = u.mods || {};
    if (mods.maxHp) {
      car.maxHp = Math.max(1, car.maxHp + mods.maxHp);
      car.hp = Math.max(1, Math.min(car.maxHp, car.hp + Math.max(0, mods.maxHp)));
    }
    entry.sold = true;
    log(game, car.name + ' покупает «' + u.name + '» за ' + u.price + ' лома.', 'shop');
    return { ok: true };
  }

  function aiBuyUpgrades(game) {
    const prefs = ['engine2', 'barrel', 'armor', 'spikes', 'suspension', 'turret', 'plow', 'balance', 'tracks', 'reactive', 'autoloader', 'cage', 'magnet', 'turbo', 'engine3'];
    game.cars.forEach((car) => {
      if (car.human) return;
      let bought = 0;
      let guard = 0;
      while (guard++ < 8) {
        const avail = prefs
          .map((id) => CnA.upgrade(id))
          .filter((u) => u && car.upgrades.indexOf(u.id) < 0 && car.scrap >= u.price && canInstall(car, u).ok);
        if (!avail.length) break;
        const u = avail[0];
        car.scrap -= u.price;
        car.upgrades.push(u.id);
        const mods = u.mods || {};
        if (mods.maxHp) car.maxHp = Math.max(1, car.maxHp + mods.maxHp);
        bought++;
        log(game, car.name + ' в мастерской ставит «' + u.name + '».', 'shop');
      }
      if (bought) log(game, car.name + ' докупил(а) улучшений: ' + bought + '.', 'shop');
    });
  }

  function prepareShop(game) {
    game.stage = 'shop';
    rollShop(game);
    return game.shop;
  }

  function nextRace(game) {
    const total = game.mode === 'championship' ? 3 : 1;
    if (game.raceIndex + 1 >= total) {
      game.stage = 'final';
      game.finalStandings = computeStandings(game);
      return false;
    }
    game.raceIndex++;
    setupRace(game);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Экспорт                                                            */
  /* ------------------------------------------------------------------ */
  CnA.createGame = createGame;
  CnA.setupRace = setupRace;
  CnA.beginTurn = beginTurn;
  CnA.endTurn = endTurn;
  CnA.currentCar = currentCar;
  CnA.carById = carById;
  CnA.playPrep = playPrep;
  CnA.canPlayPrep = canPlayPrep;
  CnA.useRustRepair = useRustRepair;
  CnA.returnMine = returnMine;
  CnA.armTurbo = armTurbo;
  CnA.armWildfire = armWildfire;
  CnA.startPit = startPit;
  CnA.rollMove = rollMove;
  CnA.rerollMove = rerollMove;
  CnA.movementOptions = movementOptions;
  CnA.stepMovement = stepMovement;
  CnA.finishMovement = finishMovement;
  CnA.attackTargets = attackTargets;
  CnA.playAttack = playAttack;
  CnA.playTwin = playTwin;
  CnA.trapOptions = trapOptions;
  CnA.placeTrap = placeTrap;
  CnA.cardPlayable = cardPlayable;
  CnA.drawEvent = drawEvent;
  CnA.endRace = endRace;
  CnA.computeStandings = computeStandings;
  CnA.prepareShop = prepareShop;
  CnA.buyUpgrade = buyUpgrade;
  CnA.aiBuyUpgrades = aiBuyUpgrades;
  CnA.rollShop = rollShop;
  CnA.nextRace = nextRace;
  CnA.progressOf = progressOf;
  CnA.raceLeader = raceLeader;
  CnA.isLeader = isLeader;
  CnA.hasUpgrade = hasUpgrade;
  CnA.upgradeMods = upgradeMods;
  CnA.effectiveRange = effectiveRange;
  CnA.capacityAt = capacityAt;
  CnA.isPitNode = isPitNode;
  CnA.countCategory = countCategory;
  CnA.canInstall = canInstall;
  CnA.addCardToHand = addCardToHand;
  CnA.drawCard = drawCard;
  CnA.log = log;
  CnA.attackDamage = attackDamage;

})(typeof globalThis !== 'undefined' ? globalThis : window);
