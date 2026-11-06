/* ХРОМ И ПЕПЕЛ — генератор трассы.
   Кольцо из 26–30 шестиугольников + внутренний «срез» на развилке.
   Граф направленный: у обычного тайла один выход, у развилки — два. */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});

  const BOARD = { cx: 500, cy: 392, rx: 408, ry: 300, size: 34 };

  function angleOf(i, n) {
    return -Math.PI / 2 + (2 * Math.PI * i) / n;
  }

  function ringPos(i, n) {
    const a = angleOf(i, n);
    return {
      x: Math.round((BOARD.cx + BOARD.rx * Math.cos(a)) * 10) / 10,
      y: Math.round((BOARD.cy + BOARD.ry * Math.sin(a)) * 10) / 10,
    };
  }

  function innerPos(i, n) {
    const a = angleOf(i, n);
    const k = 0.63;
    return {
      x: Math.round((BOARD.cx + BOARD.rx * k * Math.cos(a)) * 10) / 10,
      y: Math.round((BOARD.cy + BOARD.ry * k * Math.sin(a)) * 10) / 10,
    };
  }

  /* Распределение типов: фиксированные старт (0) и пит (2), остальное — по весам. */
  function typeBag(n, rng) {
    const need = n - 2;
    const fixed = { straight: 6, turn: 4, sand: 2, debris: 2, ramp: 1, tunnel: 1, bridge: 1, event: 2, fork: 1 };
    const order = ['straight', 'turn', 'straight', 'sand', 'debris', 'event', 'turn', 'straight', 'sand', 'debris'];
    let total = Object.keys(fixed).reduce((s, k) => s + fixed[k], 0);
    let oi = 0;
    while (total < need) {
      fixed[order[oi % order.length]]++;
      total++; oi++;
    }
    // если перебор (маленькие трассы) — режем прямые
    while (total > need && fixed.straight > 5) { fixed.straight--; total--; }
    const bag = [];
    Object.keys(fixed).forEach((k) => { for (let i = 0; i < fixed[k]; i++) bag.push(k); });
    return CnA.shuffle(rng, bag);
  }

  function isHazardType(t) {
    return t === 'sand' || t === 'debris' || t === 'event';
  }

  /* Не больше трёх опасных тайлов подряд. */
  function fixHazardRuns(types, rng) {
    const n = types.length;
    const safe = [];
    for (let i = 0; i < n; i++) if (!isHazardType(types[i]) && types[i] !== 'start' && types[i] !== 'pit' && types[i] !== 'fork') safe.push(i);
    if (!safe.length) return;
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      let run = 0;
      for (let i = 0; i < n; i++) {
        run = isHazardType(types[i]) ? run + 1 : 0;
        if (run > 3) {
          const candidates = safe.filter((j) => !isHazardType(types[j]) && Math.abs(j - i) > 1);
          if (!candidates.length) break;
          const j = candidates[Math.floor(rng() * candidates.length)];
          const t = types[i]; types[i] = types[j]; types[j] = t;
          changed = true;
          run = 0;
        }
      }
      if (!changed) break;
    }
  }

  function generateTrack(seed, count) {
    const n = Math.max(24, Math.min(32, count || 28));
    const rng = CnA.mulberry32(seed || 1);
    const types = new Array(n).fill('straight');
    types[0] = 'start';
    types[2] = 'pit';
    const bag = typeBag(n, rng);
    let b = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === 2) continue;
      types[i] = bag[b++] || 'straight';
    }

    // Развилка: ставим в среднюю часть кольца, не рядом со стартом.
    let forkPos = -1;
    for (let i = 0; i < n; i++) if (types[i] === 'fork') { forkPos = i; break; }
    const preferred = 7 + Math.floor(rng() * (n - 14));
    if (forkPos !== preferred && types[preferred] !== 'start' && types[preferred] !== 'pit') {
      const displaced = types[preferred];
      types[preferred] = 'fork';
      if (forkPos >= 0) types[forkPos] = displaced;
      forkPos = preferred;
    }
    if (forkPos < 0) {
      forkPos = preferred;
      types[preferred] = 'fork';
    }
    // развилка не должна попасть на старт/пит
    if (types[forkPos] !== 'fork') { types[forkPos] = 'fork'; }

    fixHazardRuns(types, rng);

    // Трамплин не ставим рядом со старт-финишем: иначе прыжок «перепрыгнет» линию.
    const nearStart = [n - 2, n - 1, 0, 1, 2, 3];
    for (const i of nearStart) {
      if (types[i] !== 'ramp') continue;
      for (let j = 6; j < n - 2; j++) {
        if (types[j] === 'straight' && nearStart.indexOf(j) < 0) {
          types[i] = 'straight';
          types[j] = 'ramp';
          break;
        }
      }
    }

    // Стартовая решётка (4 тайла перед финишем) должна быть чистой.
    const gridSlots = [n - 1, n - 2, n - 3, n - 4];
    for (const i of gridSlots) {
      if (types[i] === 'straight' || types[i] === 'turn') continue;
      for (let j = 6; j < n - 2; j++) {
        if (types[j] === 'straight' && gridSlots.indexOf(j) < 0) {
          types[j] = types[i];
          types[i] = 'straight';
          break;
        }
      }
    }

    const nodes = [];
    for (let i = 0; i < n; i++) {
      const p = ringPos(i, n);
      nodes.push({
        id: i,
        ringIndex: i,
        type: types[i],
        x: p.x, y: p.y,
        inner: false,
        next: [(i + 1) % n],
        prev: [(i - 1 + n) % n],
      });
    }

    // Внутренний срез развилки: два шага вместо трёх.
    const shortcutId = nodes.length;
    const sp = innerPos(forkPos + 1.5, n);
    const shortcutTypes = ['straight', 'sand', 'debris', 'event', 'straight'];
    const sType = shortcutTypes[Math.floor(rng() * shortcutTypes.length)];
    nodes.push({
      id: shortcutId,
      ringIndex: forkPos + 1.5,
      type: sType,
      x: sp.x, y: sp.y,
      inner: true,
      next: [(forkPos + 3) % n],
      prev: [forkPos],
    });
    nodes[forkPos].next = [(forkPos + 1) % n, shortcutId];
    nodes[(forkPos + 3) % n].prev.push(shortcutId);

    // Кратчайшие расстояния по направлению движения.
    const distFromStart = new Array(nodes.length).fill(Infinity);
    const q = [0];
    distFromStart[0] = 0;
    while (q.length) {
      const u = q.shift();
      for (const v of nodes[u].next) {
        if (distFromStart[v] > distFromStart[u] + 1) {
          distFromStart[v] = distFromStart[u] + 1;
          q.push(v);
        }
      }
    }
    const distToFinish = new Array(nodes.length).fill(Infinity);
    const q2 = [0];
    distToFinish[0] = 0;
    while (q2.length) {
      const u = q2.shift();
      for (const v of nodes[u].prev) {
        if (distToFinish[v] > distToFinish[u] + 1) {
          distToFinish[v] = distToFinish[u] + 1;
          q2.push(v);
        }
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      if (!isFinite(distFromStart[i])) distFromStart[i] = n;
      if (!isFinite(distToFinish[i])) distToFinish[i] = n;
    }

    const half = Math.floor(n / 2);
    nodes[half].checkpoint = true;

    const edges = [];
    for (let i = 0; i < n; i++) edges.push({ from: i, to: (i + 1) % n, shortcut: false });
    edges.push({ from: forkPos, to: shortcutId, shortcut: true });
    edges.push({ from: shortcutId, to: (forkPos + 3) % n, shortcut: true });

    return {
      seed: seed || 1,
      count: n,
      nodes,
      edges,
      ring: Array.from({ length: n }, (_, i) => i),
      startNode: 0,
      checkpoints: [0, Math.floor(n / 2)],
      pitNodes: [2],
      fork: { fork: forkPos, shortcut: shortcutId, converge: (forkPos + 3) % n },
      shortcutType: sType,
      distFromStart,
      distToFinish,
      board: BOARD,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Навигация                                                        */
  /* ---------------------------------------------------------------- */
  function forwardPath(track, from, maxSteps) {
    const out = {};
    out[from] = { dist: 0, path: [from] };
    const q = [from];
    while (q.length) {
      const u = q.shift();
      const du = out[u].dist;
      if (du >= maxSteps) continue;
      for (const v of track.nodes[u].next) {
        if (out[v] === undefined) {
          out[v] = { dist: du + 1, path: out[u].path.concat(v) };
          q.push(v);
        }
      }
    }
    return out;
  }

  function backwardPath(track, from, maxSteps) {
    const out = {};
    out[from] = { dist: 0, path: [from] };
    const q = [from];
    while (q.length) {
      const u = q.shift();
      const du = out[u].dist;
      if (du >= maxSteps) continue;
      for (const v of track.nodes[u].prev) {
        if (out[v] === undefined) {
          out[v] = { dist: du + 1, path: out[u].path.concat(v) };
          q.push(v);
        }
      }
    }
    return out;
  }

  function behindNode(track, nodeId, steps) {
    let cur = nodeId;
    for (let i = 0; i < (steps || 1); i++) {
      const node = track.nodes[cur];
      if (!node || !node.prev.length) break;
      cur = node.prev[0];
    }
    return cur;
  }

  function aheadNode(track, nodeId, steps) {
    let cur = nodeId;
    for (let i = 0; i < (steps || 1); i++) {
      const node = track.nodes[cur];
      if (!node || !node.next.length) break;
      cur = node.next[0];
    }
    return cur;
  }

  /* ------------------------------------------------------------------ */
  /* Мозаичная трасса «Пыльная подкова»                                  */
  /* ------------------------------------------------------------------ */
  /* Замкнутый маршрут по гексам, а не кольцо. 36 тайлов в круге,
     3 тайла пит-лейна, 10 тайлов застройки/руин вокруг.
     Порядок точек — по часовой стрелке от старт-финиша. */
  function buildMosaicTrack() {
    const mainCoords = [
      [4, 0], [5, 0], [6, 0], [7, 0],          // стартовая прямая
      [8, -1], [9, -1], [10, 0],                 // шикана
      [11, 0], [11, 1], [11, 2], [11, 3],        // правый спуск
      [10, 4], [9, 5],                           // правый поворот
      [8, 5], [7, 5], [6, 5], [5, 5], [4, 5],    // нижняя прямая
      [4, 4], [3, 4], [3, 3], [2, 3],            // шпилька внутрь
      [2, 4], [1, 4], [1, 5],
      [0, 5], [-1, 5], [-2, 5],                  // нижний левый участок
      [-2, 4], [-2, 3], [-2, 2], [-1, 1],        // левый подъём
      [0, 0], [1, 0], [2, 0], [3, 0],            // возврат к старту
    ];
    const pitCoords = [[1, 1], [2, 1], [3, 1]];
    const decorCoords = [
      [3, 5, 'building'], [5, 2, 'building'], [6, 2, 'ruin'],
      [7, 3, 'building'], [8, 4, 'ruin'], [-1, 0, 'ruin'],
      [12, 2, 'building'], [-3, 3, 'ruin'], [4, 6, 'building'],
      [10, 1, 'ruin'],
    ];
    const feature = {
      '5,0': 'sand',
      '6,0': 'debris',
      '9,-1': 'event',
      '11,2': 'tunnel',
      '6,5': 'bridge',
      '5,5': 'ramp',
      '0,5': 'sand',
      '7,5': 'checkpoint',
    };

    const size = 38;
    const nodes = [];
    const byCoord = new Map();
    const key = (q, r) => q + ',' + r;

    function addNode(q, r, type, road, extra) {
      const id = nodes.length;
      const node = {
        id, q, r, type, road,
        x: 0, y: 0,
        next: [], prev: [],
        ringIndex: null,
        inner: false,
        checkpoint: false,
        pitLane: false,
      };
      if (extra) Object.assign(node, extra);
      nodes.push(node);
      byCoord.set(key(q, r), id);
      return id;
    }

    // основные тайлы
    const main = mainCoords.map(([q, r], i) => {
      let type = 'turn';
      if (i === 0) type = 'start';
      else if (feature[key(q, r)]) type = feature[key(q, r)];
      const id = addNode(q, r, type, true, { ringIndex: i, mainIndex: i });
      return id;
    });
    // пит-лейн
    const pit = pitCoords.map(([q, r]) => addNode(q, r, 'pit', true, { pitLane: true }));
    // застройка
    decorCoords.forEach(([q, r, type]) => addNode(q, r, type, false));

    // связи основного круга
    for (let i = 0; i < main.length; i++) {
      const cur = main[i];
      const nxt = main[(i + 1) % main.length];
      const prv = main[(i - 1 + main.length) % main.length];
      nodes[cur].next.push(nxt);
      nodes[cur].prev.push(prv);
    }
    // пит-ветка: (1,0) -> (1,1) -> (2,1) -> (3,1) -> (3,0)
    const pitEntry = main.find((id) => nodes[id].q === 1 && nodes[id].r === 0);
    const pitExit = main.find((id) => nodes[id].q === 3 && nodes[id].r === 0);
    nodes[pitEntry].next.push(pit[0]);
    nodes[pit[0]].prev.push(pitEntry);
    nodes[pit[0]].next.push(pit[1]);
    nodes[pit[1]].prev.push(pit[0]);
    nodes[pit[1]].next.push(pit[2]);
    nodes[pit[2]].prev.push(pit[1]);
    nodes[pit[2]].next.push(pitExit);
    nodes[pitExit].prev.push(pit[2]);
    nodes[pitEntry].pitEntry = true;
    nodes[pitExit].pitExit = true;

    // координаты и центрирование в viewBox 1000×784
    nodes.forEach((n) => {
      n.x = size * Math.sqrt(3) * (n.q + n.r / 2);
      n.y = size * 1.5 * n.r;
    });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    const dx = 500 - (minX + maxX) / 2;
    const dy = 392 - (minY + maxY) / 2;
    nodes.forEach((n) => {
      n.x = Math.round((n.x + dx) * 10) / 10;
      n.y = Math.round((n.y + dy) * 10) / 10;
    });

    // проверка/геометрия поворотов
    const dirVec = (from, to) => {
      const dq = to.q - from.q;
      const dr = to.r - from.r;
      if (dq === 1 && dr === 0) return 'E';
      if (dq === 1 && dr === -1) return 'NE';
      if (dq === 0 && dr === -1) return 'NW';
      if (dq === -1 && dr === 0) return 'W';
      if (dq === -1 && dr === 1) return 'SW';
      if (dq === 0 && dr === 1) return 'SE';
      return null;
    };
    const opposite = { E: 'W', W: 'E', NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW' };
    main.forEach((id) => {
      const n = nodes[id];
      if (!n.next.length || !n.prev.length) return;
      const entry = dirVec(n, nodes[n.prev[0]]);
      const exit = dirVec(n, nodes[n.next[0]]);
      n.entryDir = entry;
      n.exitDir = exit;
      n.geometry = entry && exit && opposite[entry] === exit ? 'straight' : 'turn';
      if (n.mainIndex === 0) n.type = 'start';
    });
    // связки junction
    [pitEntry, pitExit].forEach((id) => {
      const n = nodes[id];
      n.geometry = 'junction';
    });
    pit.forEach((id) => {
      const n = nodes[id];
      if (n.prev.length && n.next.length) {
        n.entryDir = dirVec(n, nodes[n.prev[0]]);
        n.exitDir = dirVec(n, nodes[n.next[0]]);
        n.geometry = 'straight';
      }
    });

    // расстояния по графу
    const distFromStart = new Array(nodes.length).fill(Infinity);
    distFromStart[0] = 0;
    const q1 = [0];
    while (q1.length) {
      const u = q1.shift();
      for (const v of nodes[u].next) {
        if (distFromStart[v] > distFromStart[u] + 1) {
          distFromStart[v] = distFromStart[u] + 1;
          q1.push(v);
        }
      }
    }
    const distToFinish = new Array(nodes.length).fill(Infinity);
    distToFinish[0] = 0;
    const q2 = [0];
    while (q2.length) {
      const u = q2.shift();
      for (const v of nodes[u].prev) {
        if (distToFinish[v] > distToFinish[u] + 1) {
          distToFinish[v] = distToFinish[u] + 1;
          q2.push(v);
        }
      }
    }
    nodes.forEach((n) => {
      if (!isFinite(distFromStart[n.id])) distFromStart[n.id] = main.length;
      if (!isFinite(distToFinish[n.id])) distToFinish[n.id] = main.length;
    });

    const checkpointIndex = main.findIndex((id) => nodes[id].q === 7 && nodes[id].r === 5);
    const checkpointId = main[checkpointIndex];
    nodes[checkpointId].checkpoint = true;
    nodes[checkpointId].type = 'checkpoint';

    const grid = [main[main.length - 1], main[main.length - 2], main[main.length - 3], main[main.length - 4]];
    const edges = [];
    nodes.forEach((n) => {
      n.next.forEach((to) => {
        edges.push({ from: n.id, to, pit: !!(n.pitLane || nodes[to].pitLane) });
      });
    });

    return {
      seed: 0,
      name: 'Пыльная подкова',
      label: 'Пыльная подкова · 36 тайлов + пит',
      mosaic: true,
      count: main.length,
      nodes,
      main,
      pit,
      decor: nodes.filter((n) => !n.road).map((n) => n.id),
      edges,
      ring: main,
      startNode: 0,
      checkpoints: [0, checkpointIndex],
      grid,
      pitNodes: pit,
      pitEntry,
      pitExit,
      fork: { fork: pitEntry, shortcut: pit[0], converge: pitExit, pit: true },
      distFromStart,
      distToFinish,
      board: BOARD,
      size,
    };
  }

  /* Проверка правил сборки, которой пользуется прототип. */
  function validateTrack(track) {
    const issues = [];
    const n = track.count;
    if (n < 24) issues.push('меньше 24 тайлов в кольце');
    const starts = track.nodes.filter((x) => x.type === 'start').length;
    if (starts !== 1) issues.push('стартовых тайлов: ' + starts);
    const pits = track.nodes.filter((x) => x.type === 'pit').length;
    if (pits < 1) issues.push('нет пит-лейна');
    for (let i = 0; i < n; i++) {
      let run = 0;
      for (let k = 0; k < n; k++) {
        const t = track.nodes[(i + k) % n].type;
        run = isHazardType(t) ? run + 1 : 0;
        if (run > 3) { issues.push('серия опасных тайлов подряд у ' + i); break; }
      }
    }
    if (track.fork && track.fork.converge !== track.fork.fork) {
      const d = (track.fork.converge - track.fork.fork + n) % n;
      if (d > 5) issues.push('развилка сходится дальше 5 тайлов');
    }
    return issues;
  }

  CnA.generateTrack = generateTrack;
  CnA.buildMosaicTrack = buildMosaicTrack;
  CnA.validateTrack = validateTrack;
  CnA.trackForwardPath = forwardPath;
  CnA.trackBackwardPath = backwardPath;
  CnA.behindNode = behindNode;
  CnA.aheadNode = aheadNode;
  CnA.BOARD = BOARD;

})(typeof globalThis !== 'undefined' ? globalThis : window);
