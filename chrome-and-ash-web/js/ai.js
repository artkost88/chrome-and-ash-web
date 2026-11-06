/* ХРОМ И ПЕПЕЛ — ИИ прототипа.
   Простые, но осмысленные эвристики: не читерствует, видит только состояние стола. */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});

  function dmgAvg(formula) {
    if (formula === 'd4') return 2.5;
    if (formula === '2d4') return 5;
    if (formula === '3d4') return 7.5;
    return 0;
  }

  function enemies(game, car) {
    return game.cars.filter((c) => c.id !== car.id && !c.finished && !c.destroyed && !c.pit);
  }

  function behindEnemies(game, car, maxDist) {
    const r = game.race;
    const back = CnA.trackBackwardPath(r.track, car.node, maxDist);
    return enemies(game, car).filter((e) => back[e.node] && back[e.node].dist >= 1).map((e) => ({ car: e, dist: back[e.node].dist }));
  }

  function aheadEnemies(game, car, maxDist) {
    const r = game.race;
    const fwd = CnA.trackForwardPath(r.track, car.node, maxDist);
    return enemies(game, car).filter((e) => fwd[e.node] && fwd[e.node].dist >= 1).map((e) => ({ car: e, dist: fwd[e.node].dist }));
  }

  function nodeHasTrap(game, node, type) {
    return game.race.tokens.some((t) => t.node === node && (!type || t.type === type));
  }

  function tokenAt(game, node) {
    return game.race.tokens.filter((t) => t.node === node);
  }

  function remainingDistance(game, car) {
    const t = game.race.track;
    const base = (game.laps - car.lapsDone) * t.count - (t.distFromStart[car.node] || 0);
    return base;
  }

  /* ------------------------------------------------------------------ */
  /* Подготовка                                                         */
  /* ------------------------------------------------------------------ */
  function aiChoosePrep(game, car) {
    const r = game.race;
    const hp = car.hp / car.maxHp;
    const hand = car.hand;
    const find = (type) => hand.find((c) => c.type === type);

    // Пит-стоп — только если совсем плохо и до финиша далеко.
    if (CnA.isPitNode(game, car.node) && !car.flags.pitThisRace && hp < 0.32 && remainingDistance(game, car) > 8) {
      return { type: 'pit' };
    }
    if (car.factionId === 'rust' && !car.flags.repairUsed && hp < 0.55 && !find('repair') && !r.turn.prepUsed) {
      return { type: 'rust' };
    }
    if (find('repair') && hp < 0.68) return { type: 'card', uid: find('repair').uid };
    if (find('smoke') && hp < 0.55) {
      const back = behindEnemies(game, car, 5);
      if (back.length) return { type: 'card', uid: find('smoke').uid };
    }
    if (find('canister') && hand.length <= 2) return { type: 'card', uid: find('canister').uid };
    if (find('drone') && car.hp < car.maxHp) return { type: 'card', uid: find('drone').uid };
    if (find('shield') && hp < 0.6) return { type: 'card', uid: find('shield').uid };
    if (find('boost') && hp > 0.4) return { type: 'card', uid: find('boost').uid };
    if (find('ramboost') && aheadEnemies(game, car, 2).length) return { type: 'card', uid: find('ramboost').uid };
    if (car.factionId === 'carnival' && !car.flags.mineReturned && hand.length < 4 && !r.turn.prepUsed) {
      return { type: 'returnMine' };
    }

    // Нитро — на прямом участке впереди.
    if (find('nitro') && hp > 0.45) {
      const fwd = CnA.trackForwardPath(r.track, car.node, 3);
      let mineAhead = false;
      Object.keys(fwd).forEach((n) => {
        if (fwd[n].dist > 0 && nodeHasTrap(game, Number(n), 'mine')) mineAhead = true;
      });
      if (!mineAhead) return { type: 'card', uid: find('nitro').uid };
    }

    // Экстренный тормоз — если впереди мина или опасный поворот, а корпус неполный.
    if (find('brake') && hp < 0.8) {
      const fwd = CnA.trackForwardPath(r.track, car.node, 2);
      const danger = Object.keys(fwd).some((n) => {
        const id = Number(n);
        return fwd[id].dist > 0 && (nodeHasTrap(game, id, 'mine') || game.race.track.nodes[id].type === 'debris');
      });
      if (danger) return { type: 'card', uid: find('brake').uid };
    }

    // Турбина: взводим, если впереди относительно чисто.
    if (CnA.hasUpgrade(car, 'turbo') && !car.flags.turboUsed && !car.flags.turboArmed && hp > 0.4) {
      const fwd = CnA.trackForwardPath(r.track, car.node, 2);
      const danger = Object.keys(fwd).some((n) => {
        const id = Number(n);
        return fwd[id].dist > 0 && (nodeHasTrap(game, id, 'mine') || game.race.track.nodes[id].type === 'turn');
      });
      if (!danger) return { type: 'turbo' };
    }
    return { type: 'pass' };
  }

  /* ------------------------------------------------------------------ */
  /* Шаг движения                                                       */
  /* ------------------------------------------------------------------ */
  function aiChooseStep(game, car, options) {
    const r = game.race;
    const hp = car.hp / car.maxHp;
    let best = null;
    let bestScore = -Infinity;
    options.forEach((opt) => {
      const node = r.track.nodes[opt.node];
      let score = (r.track.distFromStart[opt.node] || 0) * 0.1;
      if (opt.jump) score += 0.35;
      const toks = tokenAt(game, opt.node);
      toks.forEach((t) => {
        if (t.type === 'mine') score -= hp < 0.4 ? 12 : 8;
        else if (t.type === 'oil') score -= 2.0;
        else if (t.type === 'wreck') score -= 0.6;
        else if (t.type === 'fire') score -= 1.4;
      });
      if (node.type === 'sand') score -= 0.35;
      if (node.type === 'debris') score -= hp < 0.5 ? 6 : 2.6;
      if (node.type === 'event') score += 0.1; // любопытство
      if (node.type === 'turn' && r.turn.speed >= 5) score -= 0.7;
      if (node.pitLane) score -= 4.0;
      if (CnA.capacityAt(game, opt.node) >= 2) score -= 2.5;
      const enemyHere = game.cars.some((c) => c.id !== car.id && !c.destroyed && !c.finished && !c.pit && c.node === opt.node);
      if (enemyHere) score -= 0.2;
      // здоровье важнее скорости
      if (hp < 0.3) score *= 0.9;
      score += game.rng() * 0.25;
      if (score > bestScore) { bestScore = score; best = opt; }
    });
    return best || options[0];
  }

  /* ------------------------------------------------------------------ */
  /* Огонь                                                              */
  /* ------------------------------------------------------------------ */
  function targetValue(game, car, card, target, dist) {
    const t = target;
    let score = dmgAvg(card.dmg);
    if (t.hp <= score + 1) score += 4;
    if (CnA.isLeader(game, t)) score += 1.5;
    if (t.hp / t.maxHp < 0.35) score += 1.5;
    if (dist <= 1) score += 0.3;
    if (card.id === 'emp' && (CnA.isLeader(game, t) || t.hand.length)) score += 2.2;
    if (card.id === 'net' && dist <= 1) score += 1.8;
    if (card.id === 'sabotage' && t.hand.length) score += 1.6;
    if (card.id === 'tow' && dist <= 2) score += 1.4;
    return score;
  }

  function aiChooseFire(game, car) {
    const r = game.race;
    if (!r.turn || r.phase !== 'fire') return null;
    const canAttack = !r.turn.fireUsed;
    const freeTrap = car.factionId === 'carnival' && !r.turn.freeTrapUsed;
    const hand = car.hand;
    const attacks = hand.filter((c) => {
      const card = CnA.CARDS[c.type];
      return card.kind === 'attack';
    });
    const traps = hand.filter((c) => CnA.CARDS[c.type].kind === 'trap');

    let best = null;
    let bestScore = 0;
    if (canAttack) {
      attacks.forEach((h) => {
        const card = CnA.CARDS[h.type];
        const targets = CnA.attackTargets(game, car, h.type);
        if (card.twin) {
          if (targets.length >= 2) {
            const sorted = targets.slice().sort((a, b) => targetValue(game, car, card, CnA.carById(game, b.carId), b.dist) - targetValue(game, car, card, CnA.carById(game, a.carId), a.dist));
            const score = targetValue(game, car, card, CnA.carById(game, sorted[0].carId), sorted[0].dist) + targetValue(game, car, card, CnA.carById(game, sorted[1].carId), sorted[1].dist) - 1;
            if (score > bestScore) { bestScore = score; best = { type: 'twin', uid: h.uid, targets: [sorted[0].carId, sorted[1].carId] }; }
          }
          return;
        }
        targets.forEach((t) => {
          const target = CnA.carById(game, t.carId);
          const score = targetValue(game, car, card, target, t.dist);
          if (score > bestScore) { bestScore = score; best = { type: 'attack', uid: h.uid, targetId: t.carId }; }
        });
      });
    }

    // Ловушки: ставим позади, если там есть преследователь.
    if (traps.length && (canAttack || freeTrap)) {
      const behind = behindEnemies(game, car, 3);
      if (behind.length) {
        const opts = CnA.trapOptions(game, car, traps[0].uid);
        const rear = opts.find((o) => !o.own) || opts[0];
        if (rear) {
          const trapScore = 2.6 + (behind[0].dist <= 1 ? 1 : 0);
          if (trapScore > bestScore && (canAttack || freeTrap)) {
            bestScore = trapScore;
            best = { type: 'trap', uid: traps[0].uid, node: rear.node };
          }
        }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Полный ход ИИ (для симулятора)                                     */
  /* ------------------------------------------------------------------ */
  function aiTakeTurn(game) {
    const started = CnA.beginTurn(game);
    if (started.skip) { CnA.endTurn(game); return; }
    const car = started.car;
    const r = game.race;

    const prep = aiChoosePrep(game, car);
    if (prep.type === 'pit') {
      CnA.startPit(game, car);
      CnA.endTurn(game);
      return;
    }
    if (prep.type === 'card') CnA.playPrep(game, car, prep.uid);
    else if (prep.type === 'rust') CnA.useRustRepair(game, car);
    else if (prep.type === 'turbo') CnA.armTurbo(game, car);
    else if (prep.type === 'returnMine') CnA.returnMine(game, car);

    if (car.destroyed || car.finished) { CnA.endTurn(game); return; }

    const roll = CnA.rollMove(game, car);
    if (!roll.ok || car.destroyed) { if (!game.race.over) CnA.endTurn(game); return; }

    let guard = 0;
    while (!game.race.over && guard++ < 20) {
      const opts = CnA.movementOptions(game, car);
      if (!opts.length) break;
      const opt = aiChooseStep(game, car, opts);
      const res = CnA.stepMovement(game, car, opt.node, opt.jump);
      if (!res.ok) break;
      if (res.stop) break;
    }
    if (!game.race.over) CnA.finishMovement(game, car);
    if (game.race.over) return;
    if (car.destroyed || car.finished) { CnA.endTurn(game); return; }

    guard = 0;
    while (guard++ < 4) {
      const action = aiChooseFire(game, car);
      if (!action) break;
      let res;
      if (action.type === 'attack') res = CnA.playAttack(game, car, action.uid, action.targetId);
      else if (action.type === 'twin') res = CnA.playTwin(game, car, action.uid, action.targets);
      else if (action.type === 'trap') res = CnA.placeTrap(game, car, action.uid, action.node);
      else break;
      if (!res || !res.ok) break;
      if (r.turn && r.turn.fireUsed) break;
      if (r.turn && r.turn.freeTrapUsed && r.turn.fireUsed) break;
      if (game.race.over) break;
    }
    if (!game.race.over) CnA.endTurn(game);
  }

  CnA.aiChoosePrep = aiChoosePrep;
  CnA.aiChooseStep = aiChooseStep;
  CnA.aiChooseFire = aiChooseFire;
  CnA.aiTakeTurn = aiTakeTurn;
  CnA.aiEnemies = enemies;
  CnA.aiRemainingDistance = remainingDistance;

})(typeof globalThis !== 'undefined' ? globalThis : window);
