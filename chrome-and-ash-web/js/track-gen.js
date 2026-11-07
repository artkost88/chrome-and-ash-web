/* ХРОМ И ПЕПЕЛ — генератор трасс с архетипами.
   TrackSpec -> compileTrack -> runtime track (совместим с текущим рендером/движком). */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});
  const BOARD = { cx: 500, cy: 392, rx: 408, ry: 300, size: 34 };
  const DIRS = [
    { q: 1, r: 0, port: 'A' },
    { q: 1, r: -1, port: 'B' },
    { q: 0, r: -1, port: 'C' },
    { q: -1, r: 0, port: 'D' },
    { q: -1, r: 1, port: 'E' },
    { q: 0, r: 1, port: 'F' },
  ];
  const OPPOSITE = { A: 'D', B: 'E', C: 'F', D: 'A', E: 'B', F: 'C' };

  const ARCHETYPES = {
    club: {
      id: 'club', name: 'Клубное кольцо', label: 'Клубное кольцо',
      minSize: 24, maxSize: 28, defaultSize: 24,
      hazardBudget: [2, 4], pit: 'tile', shortcut: true,
      kind: 'ring',
    },
    horseshoe: {
      id: 'horseshoe', name: 'Пыльная подкова', label: 'Пыльная подкова',
      minSize: 36, maxSize: 36, defaultSize: 36,
      hazardBudget: [2, 4], pit: 'branch', shortcut: false,
      kind: 'mosaic',
    },
    snake: {
      id: 'snake', name: 'Змея', label: 'Змея',
      minSize: 28, maxSize: 32, defaultSize: 31,
      hazardBudget: [3, 5], pit: 'none', shortcut: true,
      kind: 'mosaic',
    },
  };

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function polarPos(i, n, seed, wave) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const k = wave ? 1 + 0.16 * Math.sin(3 * a + (seed % 17) * 0.2) : 1;
    return {
      x: Math.round((BOARD.cx + BOARD.rx * k * Math.cos(a)) * 10) / 10,
      y: Math.round((BOARD.cy + BOARD.ry * k * Math.sin(a)) * 10) / 10,
    };
  }
  function innerPos(i, n, seed) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const k = 0.63;
    return {
      x: Math.round((BOARD.cx + BOARD.rx * k * Math.cos(a)) * 10) / 10,
      y: Math.round((BOARD.cy + BOARD.ry * k * Math.sin(a)) * 10) / 10,
    };
  }
  function axialToScreen(q, r, size) {
    return { x: size * Math.sqrt(3) * (q + r / 2), y: size * 1.5 * r };
  }
  function centerNodes(nodes) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    const dx = BOARD.cx - (minX + maxX) / 2;
    const dy = BOARD.cy - (minY + maxY) / 2;
    nodes.forEach((n) => { n.x = Math.round((n.x + dx) * 10) / 10; n.y = Math.round((n.y + dy) * 10) / 10; });
  }
  function dirOf(q1, r1, q2, r2) {
    return DIRS.find((d) => d.q === q2 - q1 && d.r === r2 - r1) || null;
  }
  function hazardType(rng) {
    return ['sand', 'debris', 'event'][Math.floor(rng() * 3)];
  }
  function repairHazardRuns(types, protectedIdx, rng) {
    const n = types.length;
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (!CnA.HAZARD_TILES.includes(types[i])) continue;
        const prev = types[(i - 1 + n) % n];
        const next = types[(i + 1) % n];
        const bad = protectedIdx.has(i) || CnA.HAZARD_TILES.includes(prev) || CnA.HAZARD_TILES.includes(next);
        if (!bad) continue;
        const j = types.findIndex((t, k) => k !== i && !protectedIdx.has(k) && !CnA.HAZARD_TILES.includes(t) && t !== 'fork' && t !== 'ramp');
        if (j < 0) continue;
        const t = types[i]; types[i] = types[j]; types[j] = t;
        changed = true;
        break;
      }
      if (!changed) break;
    }
  }

  /* Конструктор: приводит число опасностей на основной петле к заданному
     бюджету. Опасности на старте, решётке, КП, пите и срезе не трогаем. */
  function applyHazardBudget(spec, budget, seed) {
    const min = Math.max(0, Math.floor(Number(budget[0]) || 0));
    const max = Math.max(min, Math.floor(Number(budget[1]) || min));
    const out = clone(spec);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    const main = (out.main || out.nodes.filter((n) => !n.inner).map((n) => n.id)).slice();
    if (!main.length) return clone(spec);

    const protectedIds = new Set([...(out.grid || []), out.startNode, ...(out.checkpoints || [])]);
    (out.pit && out.pit.nodes ? out.pit.nodes : []).forEach((id) => protectedIds.add(id));
    (out.shortcut && out.shortcut.nodes ? out.shortcut.nodes : []).forEach((id) => protectedIds.add(id));
    const startIdx = main.indexOf(out.startNode);
    const cpIdxes = (out.checkpoints || []).map((id) => main.indexOf(id)).filter((i) => i >= 0);
    const protectAround = (idx, radius) => {
      if (idx < 0) return;
      for (let d = -radius; d <= radius; d++) protectedIds.add(main[(idx + d + main.length) % main.length]);
    };
    protectAround(startIdx, 3);
    cpIdxes.forEach((idx) => protectAround(idx, 2));
    if (out.pit) {
      [out.pit.entry, out.pit.exit, out.pit.tile].forEach((id) => { if (id != null) protectedIds.add(id); });
    }
    if (out.shortcut) {
      [out.shortcut.entry, out.shortcut.exit].forEach((id) => { if (id != null) protectedIds.add(id); });
    }

    const isHazard = (id) => {
      const n = byId.get(id);
      return !!n && CnA.HAZARD_TILES.includes(n.type);
    };
    let hazardIds = main.filter(isHazard);
    while (hazardIds.length > max) {
      const id = hazardIds[hazardIds.length - 1];
      const n = byId.get(id);
      if (!n) break;
      n.type = 'straight';
      hazardIds = main.filter(isHazard);
    }

    const hasHazardNeighbor = (id) => {
      const idx = main.indexOf(id);
      if (idx < 0) return true;
      return isHazard(main[(idx - 1 + main.length) % main.length]) ||
        isHazard(main[(idx + 1) % main.length]);
    };
    const candidates = () => main.filter((id) => {
      const n = byId.get(id);
      return n && !protectedIds.has(id) && (n.type === 'straight' || n.type === 'turn') && !hasHazardNeighbor(id);
    });
    let guard = 0;
    while (hazardIds.length < min && guard++ < 40) {
      const pool = candidates();
      if (!pool.length) break;
      const pickIdx = Math.floor(CnA.mulberry32((seed >>> 0) + 73 + hazardIds.length)() * pool.length);
      const n = byId.get(pool[pickIdx]);
      n.type = ['sand', 'debris', 'event'][(seed + hazardIds.length) % 3];
      hazardIds = main.filter(isHazard);
    }

    return validateTrackSpec(out).ok ? out : clone(spec);
  }
  function pick(nodes, pred) { return nodes.find(pred) || null; }

  function buildAxialSpec(seed, coords, opt) {
    const n = coords.length;
    const rng = CnA.mulberry32(seed + 41);
    const grid = [n - 1, n - 1, n - 2, n - 2];
    const cpIndex = Math.floor(n / 2);
    const pitIndex = opt.pit ? Math.max(4, Math.floor(n / 4)) : -1;
    const protectedIdx = new Set([0, cpIndex, n - 1, n - 2, n - 3, 1, 2, 3]);
    if (pitIndex >= 0) protectedIdx.add(pitIndex);
    const types = new Array(n).fill('straight');
    for (let i = 0; i < n; i++) {
      const p = coords[(i - 1 + n) % n];
      const q = coords[i];
      const z = coords[(i + 1) % n];
      const d1 = dirOf(q[0], q[1], p[0], p[1]);
      const d2 = dirOf(q[0], q[1], z[0], z[1]);
      types[i] = d1 && d2 && OPPOSITE[d1.port] === d2.port ? 'straight' : 'turn';
    }
    types[0] = 'start';
    types[cpIndex] = 'checkpoint';
    types[n - 1] = 'straight'; types[n - 2] = 'straight';
    if (pitIndex >= 0) types[pitIndex] = 'pit';
    const hazardCount = opt.hazardBudget[0] + Math.floor((opt.hazardBudget[1] - opt.hazardBudget[0] + 1) * rng());
    const safe = [];
    for (let i = 0; i < n; i++) if (!protectedIdx.has(i) && types[i] === 'straight') safe.push(i);
    const chosen = [];
    for (let i = 0; i < safe.length && chosen.length < hazardCount; i++) {
      const idx = safe[(i + Math.floor(rng() * safe.length)) % safe.length];
      if (chosen.some((x) => (x - idx + n) % n <= 1 || (idx - x + n) % n <= 1)) continue;
      chosen.push(idx);
    }
    chosen.forEach((idx, i) => { types[idx] = ['sand', 'debris', 'event'][(i + seed) % 3]; });
    repairHazardRuns(types, protectedIdx, rng);
    const nodes = coords.map(([q, r], i) => {
      const p = axialToScreen(q, r, 34);
      return { id: i, q, r, x: p.x, y: p.y, type: types[i], next: [(i + 1) % n], prev: [(i - 1 + n) % n], checkpoint: i === cpIndex, pitLane: i === pitIndex, level: 0 };
    });
    let shortcut = null;
    if (opt.shortcut) {
      const entry = opt.shortcut.entry;
      const exit = opt.shortcut.exit;
      const coordsList = Array.isArray(opt.shortcut.node[0]) ? opt.shortcut.node : [opt.shortcut.node];
      const hazardIndex = opt.shortcut.hazardIndex;
      const ids = [];
      coordsList.forEach(([iq, ir], i) => {
        const id = n + i;
        ids.push(id);
        const p = axialToScreen(iq, ir, 34);
        nodes.push({
          id, q: iq, r: ir, x: p.x, y: p.y, type: i === hazardIndex ? 'debris' : 'straight',
          next: [i === coordsList.length - 1 ? exit : n + i + 1],
          prev: [i === 0 ? entry : n + i - 1],
          inner: true, level: 0,
        });
      });
      nodes[entry].next = [nodes[entry].next[0], ids[0]];
      nodes[exit].prev.push(ids[ids.length - 1]);
      shortcut = { entry, exit, nodes: ids, type: hazardIndex != null ? 'debris' : 'straight' };
    }
    return {
      schemaVersion: 1, id: opt.id + '-' + (seed >>> 0).toString(36),
      name: opt.name, archetype: opt.id, seed: seed >>> 0, size: n,
      hexSize: 34, levels: 1, theme: 'dust', layout: 'axial', startNode: 0,
      grid, main: Array.from({ length: n }, (_, i) => i), nodes,
      pit: pitIndex >= 0 ? { tile: pitIndex, entry: null, exit: null, nodes: [] } : null,
      shortcut, checkpoints: [0, cpIndex], decor: [],
    };
  }

  function hexRing(k) {
    const coords = [];
    let q = 0, r = -k;
    const sides = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
    for (const [dq, dr] of sides) {
      for (let i = 0; i < k; i++) { coords.push([q, r]); q += dq; r += dr; }
    }
    return coords;
  }

  function stadiumCoords() {
    const coords = [];
    // верхняя полоса с шиканой
    coords.push([0, 0], [1, 0], [2, 0]);
    coords.push([2, 1], [3, 1], [3, 0]);
    for (let q = 4; q <= 9; q++) coords.push([q, 0]);
    // правый разворот
    coords.push([10, 0], [10, 1], [10, 2], [10, 3], [9, 3]);
    // нижняя полоса с шиканой
    coords.push([8, 3], [7, 3], [6, 3]);
    coords.push([6, 4], [5, 4], [5, 3]);
    for (let q = 4; q >= 0; q--) coords.push([q, 3]);
    // левый разворот
    coords.push([-1, 3], [-1, 2], [-1, 1]);
    return coords;
  }

  function buildClubSpec(seed, size) {
    const coords = hexRing(4);
    const spec = buildAxialSpec(seed + 200003, coords, {
      id: 'club', name: 'Клубное кольцо', hazardBudget: [2, 4],
      pit: true, shortcut: null,
    });
    return spec;
  }

  function buildSnakeSpec(seed, size) {
    const coords = stadiumCoords();
    const spec = buildAxialSpec(seed + 100003, coords, {
      id: 'snake', name: 'Змея', hazardBudget: [3, 5],
      pit: false, shortcut: { entry: 11, exit: 16, node: [[9, 1], [9, 2]], hazardIndex: 1 },
    });
    return spec;
  }

  function buildPolarMain(seed, size, opt) {
    const n = Math.max(opt.minSize, Math.min(opt.maxSize, size || opt.defaultSize));
    const rng = CnA.mulberry32(seed + 17);
    const main = [];
    for (let i = 0; i < n; i++) main.push(i);
    const types = new Array(n).fill('straight');
    const grid = [n - 1, n - 1, n - 2, n - 2];
    const start = 0;
    const checkpoint = Math.floor(n / 2);
    const protectedIdx = new Set([start, checkpoint, n - 1, n - 2, n - 3, n - 4, 1, 2, 3, 4, 5]);
    const fork = 7 + Math.floor((n - 14) * 0.65);
    const safeFork = Math.max(6, Math.min(n - 4, fork));
    protectedIdx.add(safeFork);
    types[start] = 'start';
    types[checkpoint] = 'checkpoint';
    types[n - 1] = 'straight';
    types[n - 2] = 'straight';
    types[n - 3] = 'straight';
    types[n - 4] = 'straight';
    types[1] = 'straight';
    if (types[2] !== 'pit') types[2] = 'straight';
    types[3] = 'straight'; types[4] = 'straight'; types[5] = 'straight';
    if (opt.pit === 'tile') {
      types[2] = 'pit';
      protectedIdx.add(2);
    }
    types[safeFork] = 'fork';

    const bag = [];
    const add = (t, count) => { for (let i = 0; i < count; i++) bag.push(t); };
    add('straight', Math.round(n * 0.42));
    add('turn', Math.round(n * 0.34));
    const hazards = opt.hazardBudget[0] + Math.floor((opt.hazardBudget[1] - opt.hazardBudget[0] + 1) * ((seed >>> 3) % 100) / 100);
    for (let i = 0; i < hazards; i++) bag.push(hazardType(CnA.mulberry32(seed + i * 97)));
    add('ramp', 1);
    add('tunnel', 1);
    add('bridge', 1);
    while (bag.length < n - protectedIdx.size) bag.push('straight');
    CnA.shuffle(CnA.mulberry32(seed + 11), bag);
    let bi = 0;
    for (let i = 0; i < n; i++) {
      if (protectedIdx.has(i)) continue;
      types[i] = bag[bi++] || 'straight';
    }
    // опасности не на старте/решётке/КП/пите; разрывы > 2.
    repairHazardRuns(types, protectedIdx, rng);
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (!CnA.HAZARD_TILES.includes(types[i])) continue;
        const a = types[(i - 1 + n) % n];
        const b = types[(i + 1) % n];
        const bad = protectedIdx.has(i) || types[i] === 'ramp' ||
          (CnA.HAZARD_TILES.includes(a) && CnA.HAZARD_TILES.includes(types[(i - 2 + n) % n])) ||
          (CnA.HAZARD_TILES.includes(b) && CnA.HAZARD_TILES.includes(types[(i + 2) % n]));
        if (!bad) continue;
        const j = types.findIndex((t, k) => k !== i && !protectedIdx.has(k) && !CnA.HAZARD_TILES.includes(t) && t !== 'fork');
        if (j >= 0) { const t = types[i]; types[i] = types[j]; types[j] = t; changed = true; }
      }
      if (!changed) break;
    }
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const p = polarPos(i, n, seed, opt.id === 'snake');
      nodes.push({
        id: i, q: null, r: null, x: p.x, y: p.y, type: types[i],
        next: [(i + 1) % n], prev: [(i - 1 + n) % n],
        checkpoint: i === checkpoint, pitLane: types[i] === 'pit', level: 0,
      });
    }
    let shortcut = null;
    if (opt.shortcut) {
      const innerId = n;
      const st = hazardType(CnA.mulberry32(seed + 31));
      const converge = (safeFork + 3) % n;
      const sp = innerPos(safeFork + 1.5, n, seed);
      nodes.push({
        id: innerId, q: null, r: null, x: sp.x, y: sp.y, type: st,
        next: [converge], prev: [safeFork], inner: true, level: 0,
      });
      nodes[safeFork].next = [(safeFork + 1) % n, innerId];
      nodes[converge].prev.push(innerId);
      shortcut = { entry: safeFork, exit: converge, nodes: [innerId], type: st };
    }
    return {
      schemaVersion: 1, id: opt.id + '-' + (seed >>> 0).toString(36),
      name: opt.name, archetype: opt.id, seed: seed >>> 0, size: n,
      levels: 1, theme: 'dust', layout: 'polar', startNode: start,
      grid, main, nodes, pit: opt.pit === 'tile' ? { entry: null, exit: null, nodes: [], tile: 2 } : null,
      shortcut, checkpoints: [start, checkpoint], decor: [],
    };
  }

  function buildHorseshoeSpec(seed, size) {
    const mainCoords = [
      [4, 0], [5, 0], [6, 0], [7, 0],
      [8, -1], [9, -1], [10, 0],
      [11, 0], [11, 1], [11, 2], [11, 3],
      [10, 4], [9, 5],
      [8, 5], [7, 5], [6, 5], [5, 5], [4, 5],
      [4, 4], [3, 4], [3, 3], [2, 3],
      [2, 4], [1, 4], [1, 5],
      [0, 5], [-1, 5], [-2, 5],
      [-2, 4], [-2, 3], [-2, 2], [-1, 1],
      [0, 0], [1, 0], [2, 0], [3, 0],
    ];
    const pitCoords = [[1, 1], [2, 1], [3, 1]];
    const decorCoords = [
      [3, 5, 'building'], [5, 2, 'building'], [6, 2, 'ruin'],
      [7, 3, 'building'], [8, 4, 'ruin'], [-1, 0, 'ruin'],
      [12, 2, 'building'], [-3, 3, 'ruin'], [4, 6, 'building'], [10, 1, 'ruin'],
    ];
    const rng = CnA.mulberry32(seed + 7);
    const n = 36;
    const key = (q, r) => q + ',' + r;
    const start = 0;
    const cpIndex = mainCoords.findIndex(([q, r]) => q === 7 && r === 5);
    const grid = [n - 1, n - 1, n - 2, n - 2];
    const protectedIdx = new Set([start, cpIndex, n - 1, n - 2, n - 3, n - 4, 1, 2, 3, 4, 5]);
    const safe = [];
    for (let i = 0; i < n; i++) {
      if (protectedIdx.has(i)) continue;
      const [q, r] = mainCoords[i];
      if (q === 11 && r >= 2 && r <= 3) continue; // tunnel
      if (q === 6 && r === 5) continue; // bridge
      if (q === 5 && r === 5) continue; // ramp
      safe.push(i);
    }
    const types = new Array(n).fill('straight');
    types[start] = 'start';
    types[cpIndex] = 'checkpoint';
    types[n - 1] = 'straight'; types[n - 2] = 'straight'; types[n - 3] = 'straight'; types[n - 4] = 'straight';
    types[1] = 'straight'; types[2] = 'straight'; types[3] = 'straight'; types[4] = 'straight'; types[5] = 'straight';
    types[mainCoords.findIndex(([q, r]) => q === 11 && r === 2)] = 'tunnel';
    types[mainCoords.findIndex(([q, r]) => q === 6 && r === 5)] = 'bridge';
    types[mainCoords.findIndex(([q, r]) => q === 5 && r === 5)] = 'ramp';
    const hazardPlaces = [];
    const pool = safe.filter((i) => ![11, 6, 5].includes(i));
    CnA.shuffle(rng, pool);
    const hz = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < Math.min(hz, pool.length); i++) hazardPlaces.push(pool[i]);
    const hazardTypes = ['sand', 'debris', 'event'];
    hazardPlaces.forEach((idx, i) => { types[idx] = hazardTypes[(i + seed) % 3]; });
    for (let i = 0; i < n; i++) {
      if (types[i] !== 'straight' || protectedIdx.has(i) || hazardPlaces.includes(i)) continue;
      if (i === 11 || i === 6 || i === 5) continue;
      types[i] = 'turn';
    }
    repairHazardRuns(types, protectedIdx, rng);
    const nodes = mainCoords.map(([q, r], i) => {
      const p = axialToScreen(q, r, 38);
      return { id: i, q, r, x: p.x, y: p.y, type: types[i], next: [(i + 1) % n], prev: [(i - 1 + n) % n], checkpoint: i === cpIndex, pitLane: false, level: 0 };
    });
    const pit = [];
    pitCoords.forEach(([q, r], i) => {
      const p = axialToScreen(q, r, 38);
      pit.push(n + i);
      nodes.push({ id: n + i, q, r, x: p.x, y: p.y, type: 'pit', next: [], prev: [], pitLane: true, level: 0 });
    });
    const pitEntry = mainCoords.findIndex(([q, r]) => q === 1 && r === 0);
    const pitExit = mainCoords.findIndex(([q, r]) => q === 3 && r === 0);
    nodes[pitEntry].next.push(pit[0]);
    nodes[pit[0]].prev.push(pitEntry);
    for (let i = 0; i < pit.length - 1; i++) { nodes[pit[i]].next.push(pit[i + 1]); nodes[pit[i + 1]].prev.push(pit[i]); }
    nodes[pit[pit.length - 1]].next.push(pitExit);
    nodes[pitExit].prev.push(pit[pit.length - 1]);
    const decor = decorCoords.map(([q, r, type], i) => {
      const p = axialToScreen(q, r, 38);
      const id = n + pit.length + i;
      nodes.push({ id, q, r, x: p.x, y: p.y, type, next: [], prev: [], road: false, level: 0 });
      return id;
    });
    return {
      schemaVersion: 1, id: 'horseshoe-' + (seed >>> 0).toString(36),
      name: 'Пыльная подкова', archetype: 'horseshoe', seed: seed >>> 0, size: n,
      hexSize: 38,
      levels: 1, theme: 'dust', layout: 'axial', startNode: start,
      grid, main: Array.from({ length: n }, (_, i) => i), nodes,
      pit: { entry: pitEntry, exit: pitExit, nodes: pit },
      shortcut: null, checkpoints: [start, cpIndex], decor,
    };
  }

  function compileTrack(spec) {
    const nodes = spec.nodes.map((n) => Object.assign({}, n, { next: [], prev: [] }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    spec.nodes.forEach((sn) => {
      const n = byId.get(sn.id);
      (sn.next || []).forEach((to) => {
        if (!byId.has(to)) return;
        n.next.push(to);
        byId.get(to).prev.push(n.id);
      });
    });
    if (spec.layout === 'axial' || spec.layout === 'snake') {
      const hexSize = spec.hexSize || (spec.archetype === 'horseshoe' ? 38 : 34);
      nodes.forEach((n) => {
        if (n.q == null || n.r == null) return;
        const p = axialToScreen(n.q, n.r, hexSize);
        n.x = p.x; n.y = p.y;
      });
    }
    centerNodes(nodes);
    const main = (spec.main || []).slice();
    const mainSet = new Set(main);
    nodes.forEach((n) => {
      if (!n.road && !mainSet.has(n.id) && !(spec.pit && spec.pit.nodes.includes(n.id))) n.road = false;
      else n.road = true;
      const p = n.prev.length ? byId.get(n.prev[0]) : null;
      const nx = n.next.length ? byId.get(n.next[0]) : null;
      if (p && nx && n.q != null) {
        const d1 = dirOf(n.q, n.r, p.q, p.r);
        const d2 = dirOf(n.q, n.r, nx.q, nx.r);
        n.entryDir = d1 ? d1.port : null;
        n.exitDir = d2 ? d2.port : null;
        n.geometry = d1 && d2 && OPPOSITE[n.entryDir] === n.exitDir ? 'straight' : 'turn';
      }
    });
    const edges = [];
    nodes.forEach((n) => {
      n.next.forEach((to) => {
        const t = byId.get(to);
        edges.push({
          from: n.id, to,
          pit: !!(n.pitLane || (t && t.pitLane)),
          shortcut: !!(n.inner || (t && t.inner)),
        });
      });
    });
    const distFromStart = new Array(nodes.length).fill(Infinity);
    distFromStart[spec.startNode] = 0;
    const q1 = [spec.startNode];
    while (q1.length) {
      const u = q1.shift();
      for (const v of nodes[u].next) if (distFromStart[v] > distFromStart[u] + 1) { distFromStart[v] = distFromStart[u] + 1; q1.push(v); }
    }
    const distToFinish = new Array(nodes.length).fill(Infinity);
    distToFinish[spec.startNode] = 0;
    const q2 = [spec.startNode];
    while (q2.length) {
      const u = q2.shift();
      for (const v of nodes[u].prev) if (distToFinish[v] > distToFinish[u] + 1) { distToFinish[v] = distToFinish[u] + 1; q2.push(v); }
    }
    nodes.forEach((n) => {
      if (!isFinite(distFromStart[n.id])) distFromStart[n.id] = main.length;
      if (!isFinite(distToFinish[n.id])) distToFinish[n.id] = main.length;
    });
    const pitEntry = spec.pit && spec.pit.entry != null ? spec.pit.entry : null;
    const pitExit = spec.pit && spec.pit.exit != null ? spec.pit.exit : null;
    const fork = spec.shortcut
      ? { fork: spec.shortcut.entry, shortcut: spec.shortcut.nodes[0], converge: spec.shortcut.exit }
      : (spec.pit && pitEntry != null ? { fork: pitEntry, shortcut: (spec.pit.nodes[0] || pitEntry), converge: pitExit, pit: true } : null);
    return {
      id: spec.id, name: spec.name, label: spec.label || (spec.name + ' · ' + main.length + ' тайлов'),
      archetype: spec.archetype, seed: spec.seed, count: main.length,
      size: spec.hexSize || (spec.archetype === 'horseshoe' ? 38 : 34),
      nodes, edges, main, ring: main, pit: spec.pit ? spec.pit.nodes : [],
      pitNodes: spec.pit ? spec.pit.nodes : [], pitEntry, pitExit,
      decor: spec.decor || [], startNode: spec.startNode, grid: spec.grid.slice(),
      checkpoints: spec.checkpoints.slice(), fork,
      distFromStart, distToFinish, board: BOARD, levels: spec.levels || 1,
      shortcut: spec.shortcut || null,
    };
  }

  function validateTrackSpec(spec) {
    const issues = [];
    const add = (code, message, nodeId) => issues.push({ code, message, nodeId });
    if (!spec || spec.schemaVersion !== 1) { add('E_SCHEMA', 'нет TrackSpec schemaVersion 1'); return { ok: false, issues }; }
    const nodes = spec.nodes || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const main = spec.main || [];
    const mainSet = new Set(main);
    if (main.length < 24 || main.length > 36) add('E_LENGTH', 'длина круга вне 24..36');
    const starts = nodes.filter((n) => n.type === 'start');
    if (starts.length !== 1) add('E_START_COUNT', 'стартовых тайлов: ' + starts.length);
    if (!byId.has(spec.startNode)) add('E_START_COUNT', 'startNode отсутствует');
    if (!Array.isArray(spec.grid) || spec.grid.length !== 4) add('E_GRID', 'grid должен содержать 4 слота');
    else {
      const unique = [...new Set(spec.grid)];
      if (unique.length !== 2) add('E_GRID', 'grid должен занимать 2 тайла');
      spec.grid.forEach((id) => {
        const n = byId.get(id);
        if (!n) return add('E_GRID', 'grid ссылается на несуществующий тайл');
        if (CnA.HAZARD_TILES.includes(n.type) || n.type === 'ramp' || n.type === 'fork' || n.pitLane) add('E_GRID', 'grid на опасном/пит-тайле', id);
      });
    }
    nodes.forEach((n) => {
      (n.next || []).forEach((to) => { if (!byId.has(to)) add('E_DEGREE', 'next ссылается на несуществующий тайл', n.id); });
    });
    // достижимость по next от старта
    const seen = new Set();
    const q = [spec.startNode];
    while (q.length) {
      const u = q.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      for (const v of (byId.get(u)?.next || [])) if (!seen.has(v)) q.push(v);
    }
    main.forEach((id) => { if (!seen.has(id)) add('E_REACHABILITY', 'тайл не достижим из старта', id); });
    main.forEach((id) => {
      const n = byId.get(id);
      if (!n) return;
      if (!n.next || !n.next.length) add('E_DEAD_END', 'тупик', id);
      if (!n.prev || !n.prev.length) add('E_DEAD_END', 'нет входа', id);
    });
    const protectedSet = new Set([spec.startNode, ...(spec.grid || []), ...(spec.checkpoints || [])]);
    let run = 0;
    for (let k = 0; k < main.length; k++) {
      const n = byId.get(main[k]);
      if (!n) continue;
      run = CnA.HAZARD_TILES.includes(n.type) ? run + 1 : 0;
      if (run > 2) add('E_HAZARD_RUN', 'больше двух опасных подряд', n.id);
      if (CnA.HAZARD_TILES.includes(n.type) && protectedSet.has(n.id)) add('E_HAZARD_ZONE', 'опасность на старте/решётке/КП', n.id);
      if (n.type === 'ramp' && protectedSet.has(n.id)) add('E_RAMP_ZONE', 'трамплин на старте/решётке/КП', n.id);
    }
    const cps = (spec.checkpoints || []).filter((id) => id !== spec.startNode);
    if (cps.length < 1) add('E_CHECKPOINT', 'нет контрольного пункта');
    cps.forEach((id) => {
      const idx = main.indexOf(id);
      if (idx < 0) add('E_CHECKPOINT', 'КП не на основном круге', id);
      else if (idx / main.length < 0.25 || idx / main.length > 0.65) add('E_CHECKPOINT', 'КП вне 25..65% круга', id);
    });
    if (spec.pit && spec.pit.nodes && spec.pit.nodes.length) {
      if (spec.pit.entry == null || spec.pit.exit == null) add('E_PIT', 'у пита нет входа/выхода');
      else {
        const a = main.indexOf(spec.pit.entry), b = main.indexOf(spec.pit.exit);
        if (a < 0 || b < 0) add('E_PIT', 'пит не связан с основным кругом');
        else {
          const mainDist = (b - a + main.length) % main.length;
          if (mainDist < 2 || mainDist > 5) add('E_PIT', 'вход/выход пита слишком далеко');
          if (spec.pit.nodes.length < 2) add('E_PIT', 'пит-ветка короче 2 тайлов');
        }
      }
    }
    if (spec.shortcut) {
      const s = spec.shortcut;
      if (!mainSet.has(s.entry) || !mainSet.has(s.exit)) add('E_SHORTCUT', 'срез не связан с кругом');
      else {
        const mainDist = (main.indexOf(s.exit) - main.indexOf(s.entry) + main.length) % main.length;
        const branchLen = (s.nodes || []).length + 1;
        if (mainDist - branchLen < 1 || mainDist - branchLen > 2) add('E_SHORTCUT', 'срез экономит не 1–2 тайла');
        if (s.entry <= 3 || s.exit >= main.length - 3) add('E_SHORTCUT', 'срез слишком близко к старту/финишу');
      }
    }
    const coordKey = (n) => n.q != null ? n.q + ',' + n.r : Math.round(n.x) + ',' + Math.round(n.y);
    const coords = new Map();
    nodes.filter((n) => n.road !== false && n.type !== 'building' && n.type !== 'ruin').forEach((n) => {
      if (!coords.has(coordKey(n))) coords.set(coordKey(n), []);
      coords.get(coordKey(n)).push(n.id);
    });
    coords.forEach((ids) => { if (ids.length > 1) add('E_DUPLICATE_COORD', 'две дороги в одной клетке', ids[0]); });
    return { ok: issues.length === 0, issues };
  }

  function validateTrack(track) {
    const issues = [];
    if (!track || !Array.isArray(track.nodes)) return ['нет узлов трассы'];
    const starts = track.nodes.filter((n) => n.type === 'start').length;
    if (starts !== 1) issues.push('стартовых тайлов: ' + starts);
    if (!track.grid || track.grid.length !== 4) issues.push('grid должен содержать 4 слота');
    else if (new Set(track.grid).size !== 2) issues.push('grid должен занимать 2 тайла');
    track.main.forEach((id) => {
      const n = track.nodes[id];
      if (!n || !n.next.length || !n.prev.length) issues.push('тупик/нет входа у тайла ' + id);
    });
    let run = 0;
    track.main.forEach((id) => {
      const n = track.nodes[id];
      run = n && CnA.HAZARD_TILES.includes(n.type) ? run + 1 : 0;
      if (run > 2) issues.push('больше двух опасных подряд у ' + id);
    });
    return issues;
  }

  function resolveArchetype(opts) {
    if (typeof opts === 'number') return ARCHETYPES.club;
    if (opts && typeof opts.archetype === 'string' && ARCHETYPES[opts.archetype]) return ARCHETYPES[opts.archetype];
    if (opts && opts.kind === 'ring') return ARCHETYPES.club;
    return ARCHETYPES.horseshoe;
  }

  function generateTrackSpec(seed, opts) {
    const arch = resolveArchetype(opts);
    const size = opts && typeof opts === 'object' ? opts.size : (typeof opts === 'number' ? opts : undefined);
    const s = (seed >>> 0) || 1;
    let spec;
    if (arch.id === 'club') spec = buildClubSpec(s, size);
    else if (arch.id === 'snake') spec = buildSnakeSpec(s, size);
    else spec = buildHorseshoeSpec(s, size || 36);
    if (opts && typeof opts === 'object' && Array.isArray(opts.hazardBudget)) {
      spec = applyHazardBudget(spec, opts.hazardBudget, s);
    }
    let check = validateTrackSpec(spec);
    if (!check.ok) {
      // Детерминированный fallback: тот же архетип, seed 0; если и он плох — вернуть как есть.
      let fallback = arch.id === 'club' ? buildClubSpec(0, arch.defaultSize)
        : arch.id === 'snake' ? buildSnakeSpec(0, arch.defaultSize)
        : buildHorseshoeSpec(0, 36);
      if (opts && typeof opts === 'object' && Array.isArray(opts.hazardBudget)) {
        fallback = applyHazardBudget(fallback, opts.hazardBudget, 0);
      }
      if (validateTrackSpec(fallback).ok) spec = fallback;
    }
    return spec;
  }

  function generateTrack(seed, opts) {
    const spec = generateTrackSpec(seed, opts);
    return compileTrack(spec);
  }

  CnA.TRACK_ARCHETYPES = ARCHETYPES;
  CnA.generateTrackSpec = generateTrackSpec;
  CnA.applyHazardBudget = applyHazardBudget;
  CnA.compileTrack = compileTrack;
  CnA.generateTrack = generateTrack;
  CnA.validateTrackSpec = validateTrackSpec;
  CnA.validateTrack = validateTrack;
  CnA.CnATrackGen = { buildClubSpec, buildHorseshoeSpec, buildSnakeSpec };
})(typeof globalThis !== 'undefined' ? globalThis : window);
