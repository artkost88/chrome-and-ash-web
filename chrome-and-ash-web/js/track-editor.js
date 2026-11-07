/* ХРОМ И ПЕПЕЛ — конструктор трасс.
   Чистая модель: параметры, генерация, отчёт, SVG-превью и локальное хранилище.
   DOM-контроллер живёт отдельно в track-editor-ui.js. */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});
  const STORE_KEY = 'cna.customTracks.v1';
  const STORE_VERSION = 1;
  const MAX_TRACKS = 40;
  const MAX_IMPORT_BYTES = 100 * 1024;
  const HAZARD_TYPES = ['sand', 'debris', 'event'];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function cleanName(name) {
    return String(name || '').replace(/<[^>]*>/g, '').trim().slice(0, 40) || 'Моя трасса';
  }
  function clampInt(v, lo, hi, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  }
  function nowIso() { return new Date().toISOString(); }
  function customId() { return 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

  function normalizeOptions(input) {
    input = input || {};
    const archetypes = CnA.TRACK_ARCHETYPES || {};
    const archetype = archetypes[input.archetype] ? input.archetype : 'horseshoe';
    const arch = archetypes[archetype];
    const defaults = arch && Array.isArray(arch.hazardBudget) ? arch.hazardBudget : [2, 4];
    let hazardMin = clampInt(input.hazardMin, 0, MAX_HAZARDS, defaults[0]);
    let hazardMax = clampInt(input.hazardMax, 0, MAX_HAZARDS, defaults[1]);
    if (hazardMin > hazardMax) { const t = hazardMin; hazardMin = hazardMax; hazardMax = t; }
    const seedNum = Number(input.seed);
    const seed = Number.isFinite(seedNum) ? Math.max(0, Math.floor(seedNum)) >>> 0 : 1;
    return { archetype, seed, hazardMin, hazardMax, name: cleanName(input.name) };
  }

  function statsFor(spec) {
    const byId = new Map((spec.nodes || []).map((n) => [n.id, n]));
    const main = spec.main || [];
    const hazards = main.filter((id) => {
      const n = byId.get(id);
      return n && CnA.HAZARD_TILES.includes(n.type);
    }).length;
    return {
      length: main.length || (spec.nodes || []).length,
      hazards,
      checkpointId: (spec.checkpoints || [])[1] ?? null,
      hasPit: !!spec.pit,
      hasShortcut: !!spec.shortcut,
      archetype: spec.archetype || 'custom',
    };
  }

  function report(spec) {
    if (!spec || spec.schemaVersion !== 1) {
      return { ok: false, issues: [{ code: 'E_SCHEMA', message: 'нет TrackSpec schemaVersion 1' }], stats: null, readOnly: false, warnings: [] };
    }
    try {
      const prepared = prepareSpec(spec);
      if (!prepared.ok) {
        return { ok: false, issues: prepared.issues || [], stats: null, readOnly: false, warnings: prepared.warnings || [] };
      }
      return {
        ok: true,
        issues: [],
        warnings: prepared.warnings || [],
        readOnly: !!prepared.readOnly,
        reason: prepared.reason || null,
        stats: statsFor(prepared.canonical || spec),
      };
    } catch (e) {
      return { ok: false, issues: [{ code: 'E_COMPILE', message: String(e && e.message || e) }], stats: null, readOnly: false, warnings: [] };
    }
  }

  function generate(input) {
    const o = normalizeOptions(input);
    const archetypes = CnA.TRACK_ARCHETYPES || {};
    const arch = archetypes[o.archetype];
    let spec;
    try {
      spec = CnA.generateTrackSpec(o.seed, {
        archetype: o.archetype,
        size: arch ? arch.defaultSize : undefined,
        hazardBudget: [o.hazardMin, o.hazardMax],
      });
    } catch (e) {
      return { spec: null, ok: false, issues: [{ code: 'E_GENERATE', message: String(e && e.message || e) }], stats: null };
    }
    spec.name = o.name;
    spec.label = o.name;
    spec.seed = o.seed;
    const r = report(spec);
    const budget = hazardBudgetReport(spec, o.hazardMin, o.hazardMax);
    const issues = (r.issues || []).slice();
    if (budget.actual < budget.requestedMin) {
      issues.push({
        code: 'W_HAZARD_BUDGET',
        message: 'Запрошено минимум ' + budget.requestedMin + ', размещено ' + budget.actual +
          '; максимум — ' + budget.achievable + '.',
      });
    }
    return { spec, ok: r.ok, issues, warnings: issues.filter((i) => String(i.code).startsWith('W_')), stats: r.stats, budget, options: o };
  }

  function hexPoints(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
    }
    return pts.join(' ');
  }

  function previewSvg(spec, opts) {
    opts = opts || {};
    if (!spec) {
      return '<svg class="track-preview-svg" viewBox="0 0 1000 784" role="img" aria-label="Нет трассы"><text x="500" y="390" text-anchor="middle" fill="#a99c88">Сгенерируйте трассу</text></svg>';
    }
    let track;
    try { track = CnA.compileTrack(spec); } catch (e) {
      return '<svg class="track-preview-svg" viewBox="0 0 1000 784" role="img" aria-label="Ошибка трассы"><text x="500" y="390" text-anchor="middle" fill="#f0a07a">' + esc(e.message || 'Ошибка') + '</text></svg>';
    }
    const nodes = track.nodes || [];
    if (!nodes.length) return '<svg class="track-preview-svg" viewBox="0 0 1000 784"></svg>';
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    const pad = 58;
    const vb = { x: minX - pad, y: minY - pad, w: Math.max(1, maxX - minX + pad * 2), h: Math.max(1, maxY - minY + pad * 2) };
    const size = opts.hexSize || spec.hexSize || 34;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (track.edges || []).map((e) => {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) return '';
      return '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" class="pv-edge' + (e.shortcut ? ' shortcut' : '') + (e.pit ? ' pit' : '') + '"/>';
    }).join('');
    const tiles = nodes.map((n) => {
      const tile = (CnA.TILES && CnA.TILES[n.type]) || { fill: '#3a332c', ink: '#f5f0e8', label: n.type };
      const isStart = n.id === spec.startNode;
      const isCp = (spec.checkpoints || []).includes(n.id) && !isStart;
      const inner = !!n.inner;
      const short = isStart ? 'СТАРТ' : isCp ? 'КП' : inner ? 'СРЕЗ' : (tile.short || '');
      return '<g data-node="' + esc(String(n.id)) + '" data-type="' + esc(n.type) + '" data-start="' + (isStart ? '1' : '0') + '" class="pv-node' + (inner ? ' inner' : '') + '">' +
        '<polygon points="' + hexPoints(n.x, n.y, size * (inner ? 0.8 : 1)) + '" fill="' + tile.fill + '" stroke="' + (isStart ? '#f5f0e8' : 'rgba(245,240,232,.3)') + '" stroke-width="' + (isStart ? 2.5 : 1.2) + '"/>' +
        (short ? '<text x="' + n.x.toFixed(1) + '" y="' + (n.y - 3).toFixed(1) + '" text-anchor="middle" fill="' + tile.ink + '" font-size="' + (short.length > 4 ? 8 : 10) + '" font-family="monospace">' + esc(short) + '</text>' : '') +
        (tile.label ? '<text x="' + n.x.toFixed(1) + '" y="' + (n.y + 12).toFixed(1) + '" text-anchor="middle" fill="rgba(245,240,232,.55)" font-size="7" font-family="monospace">' + esc(tile.label) + '</text>' : '') +
        '</g>';
    }).join('');
    return '<svg class="track-preview-svg" viewBox="' + vb.x.toFixed(1) + ' ' + vb.y.toFixed(1) + ' ' + vb.w.toFixed(1) + ' ' + vb.h.toFixed(1) + '" role="img" aria-label="Предпросмотр трассы">' +
      '<g class="pv-edges">' + edges + '</g><g class="pv-tiles">' + tiles + '</g></svg>';
  }

  function envelope(spec, name, id) {
    const s = clone(spec);
    const now = nowIso();
    return {
      schemaVersion: 1,
      id: id || customId(),
      name: cleanName(name || (spec && spec.name)),
      createdAt: now,
      updatedAt: now,
      spec: s,
    };
  }

  function normalizeEnvelope(input, fallbackId) {
    if (!input || typeof input !== 'object') return { ok: false, issues: [{ code: 'E_IMPORT', message: 'ожидался объект трассы' }] };
    const raw = input.track && input.track.spec ? input.track : input;
    const spec = raw.spec;
    if (!spec) return { ok: false, issues: [{ code: 'E_IMPORT', message: 'нет TrackSpec' }] };
    const prepared = prepareSpec(spec);
    if (!prepared.ok) return { ok: false, issues: prepared.issues };
    const canonical = prepared.readOnly ? clone(spec) : clone(prepared.canonical || spec);
    return {
      ok: true,
      readOnly: !!prepared.readOnly,
      reason: prepared.reason || null,
      warnings: prepared.warnings || [],
      track: {
        schemaVersion: 1,
        id: String(raw.id || fallbackId || customId()).slice(0, 80),
        name: cleanName(raw.name || spec.name),
        createdAt: raw.createdAt || nowIso(),
        updatedAt: raw.updatedAt || nowIso(),
        spec: canonical,
      },
    };
  }

  function createStore(storage) {
    function read() {
      try {
        const raw = storage && storage.getItem(STORE_KEY);
        if (!raw) return { schemaVersion: STORE_VERSION, tracks: [] };
        const data = JSON.parse(raw);
        const tracks = Array.isArray(data) ? data : (Array.isArray(data.tracks) ? data.tracks : []);
        const valid = [];
        tracks.forEach((t) => {
          const n = normalizeEnvelope(t);
          if (n.ok) valid.push(n.track);
        });
        return { schemaVersion: STORE_VERSION, tracks: valid.slice(0, MAX_TRACKS) };
      } catch (e) {
        return { schemaVersion: STORE_VERSION, tracks: [] };
      }
    }
    function write(data) {
      try {
        storage.setItem(STORE_KEY, JSON.stringify(data));
        return { ok: true };
      } catch (e) {
        return { ok: false, issues: [{ code: 'E_STORAGE', message: 'Не удалось сохранить трассу: хранилище недоступно.' }] };
      }
    }
    function list() {
      const data = read();
      return data.tracks.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    function get(id) {
      return list().find((t) => t.id === id) || null;
    }
    function save(env) {
      const n = normalizeEnvelope(env);
      if (!n.ok) return n;
      const data = read();
      const track = n.track;
      track.updatedAt = nowIso();
      const i = data.tracks.findIndex((t) => t.id === track.id);
      if (i >= 0) data.tracks[i] = track;
      else data.tracks.unshift(track);
      data.tracks = data.tracks.slice(0, MAX_TRACKS);
      const w = write(data);
      return w.ok ? { ok: true, track } : w;
    }
    function remove(id) {
      const data = read();
      data.tracks = data.tracks.filter((t) => t.id !== id);
      const w = write(data);
      return w.ok ? { ok: true } : w;
    }
    function exportJson(env) {
      const n = normalizeEnvelope(env);
      if (!n.ok) return null;
      return JSON.stringify({ kind: 'cna-track', version: 1, track: n.track }, null, 2);
    }
    function importJson(text, now) {
      const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(text)).length : String(text).length;
      if (bytes > MAX_IMPORT_BYTES) return { ok: false, issues: [{ code: 'E_IMPORT_SIZE', message: 'Файл больше 100 КБ' }] };
      let data;
      try { data = JSON.parse(String(text)); } catch (e) {
        return { ok: false, issues: [{ code: 'E_IMPORT_JSON', message: 'Некорректный JSON' }] };
      }
      if (data && data.kind && data.kind !== 'cna-track') {
        return { ok: false, issues: [{ code: 'E_IMPORT_KIND', message: 'Это не файл трассы' }] };
      }
      const n = normalizeEnvelope(data, customId());
      if (!n.ok) return n;
      if (now) n.track.updatedAt = now.toISOString ? now.toISOString() : String(now);
      return n;
    }
    return { list, get, save, remove, exportJson, importJson, key: STORE_KEY };
  }

  /* ================================================================== */
  /* Stage B — чистая модель ручного редактора (TrackDraft).            */
  /* TrackSpec остаётся контрактом; draft — внутреннее представление.   */
  /* ================================================================== */

  const AXIAL_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const MAIN_TYPES = ['start', 'straight', 'turn', 'checkpoint', 'sand', 'debris', 'event', 'ramp', 'tunnel', 'bridge', 'pit', 'fork'];
  const PAINT_TYPES = ['straight', 'turn', 'sand', 'debris', 'event', 'ramp', 'tunnel', 'bridge'];
  const SHORTCUT_TYPES = ['straight', 'turn', 'sand', 'debris', 'event', 'ramp'];
  const NORMAL_GRID_TYPES = ['straight', 'turn'];
  const MAX_HAZARDS = 6;
  const FEATURE_NAMES = ['start', 'checkpoint', 'grid', 'pit', 'shortcut'];
  const HISTORY_LIMIT = 50;
  const LEGACY_HORSESHOE_MAIN = [
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

  function isInt(v) { return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v; }
  function isHazardType(t) { return CnA.HAZARD_TILES.includes(t); }
  function issue(code, message, nodeId) { return { code, message, nodeId }; }
  function hasError(issues) { return (issues || []).some((i) => String(i.code).startsWith('E_')); }
  function axialAdjacent(a, b) {
    if (!a || !b) return false;
    const dq = b.q - a.q;
    const dr = b.r - a.r;
    return AXIAL_DIRS.some(([q, r]) => q === dq && r === dr);
  }
  function axialNeighbors(q, r) {
    return AXIAL_DIRS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
  }
  function hexXY(q, r, hexSize) {
    return { x: hexSize * Math.sqrt(3) * (q + r / 2), y: hexSize * 1.5 * r };
  }
  function coordKey(n) {
    if (n.q != null && n.r != null) return n.q + ',' + n.r;
    return Math.round(n.x) + ',' + Math.round(n.y);
  }
  function remapList(list, map) { return (list || []).map((id) => map.get(id)); }
  function derivedGrid(main) {
    const n = (main || []).length;
    return n >= 2 ? [main[n - 1], main[n - 1], main[n - 2], main[n - 2]] : [];
  }
  function zoneBufferUids(main, startUid, cpUids, startRadius, cpRadius) {
    const set = new Set();
    const add = (uid, radius) => {
      const idx = (main || []).indexOf(uid);
      if (idx < 0) return;
      for (let d = -radius; d <= radius; d++) set.add(main[(idx + d + main.length) % main.length]);
    };
    add(startUid, startRadius == null ? 3 : startRadius);
    (cpUids || []).forEach((uid) => add(uid, cpRadius == null ? 2 : cpRadius));
    return set;
  }

  /* --- B1: canonical representation ---------------------------------- */

  function canonicalizeRepresentation(input) {
    if (!input || input.schemaVersion !== 1) {
      return { ok: false, issues: [issue('E_SCHEMA', 'нет TrackSpec schemaVersion 1')] };
    }
    const out = clone(input);
    const issues = [];
    const nodes = Array.isArray(out.nodes) ? out.nodes : [];
    const byId = new Map();
    nodes.forEach((n) => {
      if (byId.has(n.id)) issues.push(issue('E_DUP_ID', 'повторяющийся id узла ' + n.id, n.id));
      else byId.set(n.id, n);
    });
    if (issues.length) return { ok: false, issues };

    const ref = (id, message, nodeId) => {
      if (id == null || !byId.has(id)) issues.push(issue('E_REF', message, nodeId));
    };
    const main = (out.main || []).slice();
    main.forEach((id) => ref(id, 'main ссылается на несуществующий тайл'));
    ref(out.startNode, 'startNode ссылается на несуществующий тайл');
    (out.grid || []).forEach((id) => ref(id, 'grid ссылается на несуществующий тайл'));
    (out.checkpoints || []).forEach((id) => ref(id, 'checkpoints ссылаются на несуществующий тайл'));
    if (out.pit) {
      ['tile', 'entry', 'exit'].forEach((k) => { if (out.pit[k] != null) ref(out.pit[k], 'pit.' + k + ' ссылается на несуществующий тайл'); });
      (out.pit.nodes || []).forEach((id) => ref(id, 'pit.nodes ссылается на несуществующий тайл'));
    }
    if (out.shortcut) {
      ['entry', 'exit'].forEach((k) => { if (out.shortcut[k] != null) ref(out.shortcut[k], 'shortcut.' + k + ' ссылается на несуществующий тайл'); });
      (out.shortcut.nodes || []).forEach((id) => ref(id, 'shortcut.nodes ссылается на несуществующий тайл'));
    }
    (out.decor || []).forEach((d) => { if (typeof d !== 'object') ref(d, 'decor ссылается на несуществующий тайл'); });
    nodes.forEach((n) => {
      (n.next || []).forEach((to) => ref(to, 'next ссылается на несуществующий тайл', n.id));
      (n.prev || []).forEach((to) => ref(to, 'prev ссылается на несуществующий тайл', n.id));
    });
    if (issues.length) return { ok: false, issues };

    const startIdx = main.indexOf(out.startNode);
    if (startIdx < 0) return { ok: false, issues: [issue('E_START_INDEX', 'startNode не входит в main')] };
    const mainRot = main.slice(startIdx).concat(main.slice(0, startIdx));
    const pitNodes = out.pit && Array.isArray(out.pit.nodes) ? out.pit.nodes.slice() : [];
    const shortcutNodes = out.shortcut && Array.isArray(out.shortcut.nodes) ? out.shortcut.nodes.slice() : [];
    const decorIds = (out.decor || []).filter((d) => typeof d !== 'object');
    const decorObjects = (out.decor || []).filter((d) => typeof d === 'object').map((d) => clone(d));

    const order = [];
    const orderSet = new Set();
    const push = (id) => { if (!orderSet.has(id)) { orderSet.add(id); order.push(id); } };
    mainRot.forEach(push);
    pitNodes.forEach(push);
    shortcutNodes.forEach(push);
    decorIds.forEach(push);
    nodes.forEach((n) => push(n.id));

    const map = new Map(order.map((id, i) => [id, i]));
    const remap = (id) => (id == null ? null : map.get(id));
    out.nodes = order.map((id, i) => {
      const n = byId.get(id);
      return Object.assign({}, n, {
        id: i,
        next: (n.next || []).map(remap),
        prev: (n.prev || []).map(remap),
      });
    });
    out.main = mainRot.map(remap);
    out.startNode = 0;
    out.grid = (out.grid || []).map(remap);
    const cps = (out.checkpoints || []).map(remap);
    const cpOnly = cps.filter((id) => id !== 0);
    out.checkpoints = cpOnly.length === 1 ? [0, cpOnly[0]] : [0].concat(cpOnly);
    if (out.pit) {
      out.pit = Object.assign({}, out.pit, {
        nodes: (out.pit.nodes || []).map(remap),
        tile: out.pit.tile != null ? remap(out.pit.tile) : out.pit.tile,
        entry: out.pit.entry != null ? remap(out.pit.entry) : out.pit.entry,
        exit: out.pit.exit != null ? remap(out.pit.exit) : out.pit.exit,
      });
    }
    if (out.shortcut) {
      out.shortcut = Object.assign({}, out.shortcut, {
        entry: remap(out.shortcut.entry),
        exit: remap(out.shortcut.exit),
        nodes: (out.shortcut.nodes || []).map(remap),
      });
    }
    out.decor = decorIds.map(remap).concat(decorObjects);
    return { ok: true, spec: out, issues: [] };
  }

  /* --- B1: migration of the known v1 horseshoe bump ------------------- */

  function migrateKnownHorseshoe(input) {
    const out = clone(input);
    const main = out.main || [];
    if (out.layout && out.layout !== 'axial') return { ok: true, spec: out, migrated: false, issues: [] };
    if (main.length !== LEGACY_HORSESHOE_MAIN.length) return { ok: true, spec: out, migrated: false, issues: [] };
    const byId = new Map((out.nodes || []).map((n) => [n.id, n]));
    const coords = main.map((id) => { const n = byId.get(id); return n ? [n.q, n.r] : null; });
    if (coords.some((c) => !c || !isInt(c[0]) || !isInt(c[1]))) {
      return { ok: true, spec: out, migrated: false, issues: [] };
    }
    const n = main.length;
    let offset = -1;
    for (let k = 0; k < n && offset < 0; k++) {
      let same = true;
      for (let i = 0; i < n; i++) {
        const c = coords[(k + i) % n];
        if (c[0] !== LEGACY_HORSESHOE_MAIN[i][0] || c[1] !== LEGACY_HORSESHOE_MAIN[i][1]) { same = false; break; }
      }
      if (same) offset = k;
    }
    if (offset < 0) return { ok: true, spec: out, migrated: false, issues: [] };
    const fixes = [[4, 8, 0], [5, 9, 0], [6, 10, 0]];
    fixes.forEach(([templateIdx, q, r]) => {
      const node = byId.get(main[(offset + templateIdx) % n]);
      if (node) { node.q = q; node.r = r; }
    });
    return { ok: true, spec: out, migrated: true, issues: [] };
  }

  /* --- B1: strict structural validator ------------------------------- */

  function validateStructural(input, opts) {
    opts = opts || {};
    const issues = [];
    const add = (code, message, nodeId) => issues.push(issue(code, message, nodeId));
    if (!input || input.schemaVersion !== 1) {
      add('E_SCHEMA', 'нет TrackSpec schemaVersion 1');
      return { ok: false, issues };
    }
    const nodes = input.nodes || [];
    const byId = new Map();
    nodes.forEach((n) => {
      if (byId.has(n.id)) add('E_DUP_ID', 'повторяющийся id узла ' + n.id, n.id);
      else byId.set(n.id, n);
    });
    if (issues.length) return { ok: false, issues };
    const main = (input.main || []).slice();
    const mainSet = new Set(main);
    const mainIndex = new Map(main.map((id, i) => [id, i]));
    const ref = (id, message, nodeId) => {
      if (id == null || !byId.has(id)) add('E_REF', message, nodeId);
    };
    main.forEach((id) => ref(id, 'main ссылается на несуществующий тайл'));
    ref(input.startNode, 'startNode ссылается на несуществующий тайл');
    (input.grid || []).forEach((id) => ref(id, 'grid ссылается на несуществующий тайл'));
    (input.checkpoints || []).forEach((id) => ref(id, 'checkpoints ссылаются на несуществующий тайл'));
    if (input.pit) {
      ['tile', 'entry', 'exit'].forEach((k) => { if (input.pit[k] != null) ref(input.pit[k], 'pit.' + k + ' ссылается на несуществующий тайл'); });
      (input.pit.nodes || []).forEach((id) => ref(id, 'pit.nodes ссылается на несуществующий тайл'));
    }
    if (input.shortcut) {
      ['entry', 'exit'].forEach((k) => { if (input.shortcut[k] != null) ref(input.shortcut[k], 'shortcut.' + k + ' ссылается на несуществующий тайл'); });
      (input.shortcut.nodes || []).forEach((id) => ref(id, 'shortcut.nodes ссылается на несуществующий тайл'));
    }
    (input.decor || []).forEach((d) => {
      if (typeof d === 'object') {
        if (!d || !['building', 'ruin'].includes(d.type)) add('E_DECOR', 'объектный декор должен быть building/ruin');
        return;
      }
      ref(d, 'decor ссылается на несуществующий тайл');
    });
    nodes.forEach((n) => {
      (n.next || []).forEach((to) => ref(to, 'next ссылается на несуществующий тайл', n.id));
      (n.prev || []).forEach((to) => ref(to, 'prev ссылается на несуществующий тайл', n.id));
    });
    if (issues.length) return { ok: false, issues };
    if (nodes.some((n, i) => n.id !== i)) {
      add('E_IDS', 'id узлов должны быть плотными (nodes[i].id === i)');
    }

    const pitBranch = !!(input.pit && input.pit.nodes && input.pit.nodes.length);
    const pitTile = !!(input.pit && !pitBranch && input.pit.tile != null);
    if (input.pit && input.pit.tile != null && (input.pit.nodes || []).length) {
      add('E_PIT', 'пит не может быть одновременно тайлом и ветвью');
    }
    const shortcut = input.shortcut || null;
    const pitNodes = pitBranch ? input.pit.nodes : [];
    const shortcutNodes = shortcut ? (shortcut.nodes || []) : [];
    const decorIds = (input.decor || []).filter((d) => typeof d !== 'object');
    const roadIds = new Set(main);
    pitNodes.forEach((id) => roadIds.add(id));
    shortcutNodes.forEach((id) => roadIds.add(id));
    const roadCoordKeys = new Set();
    roadIds.forEach((id) => {
      const node = byId.get(id);
      if (node) roadCoordKeys.add(coordKey(node));
    });

    if (input.size != null && input.size !== main.length) add('E_SIZE', 'size не совпадает с длиной main');
    if (main.length < 24 || main.length > 36) add('E_LENGTH', 'длина круга вне 24..36');

    main.forEach((id) => {
      const n = byId.get(id);
      if (n && !MAIN_TYPES.includes(n.type)) add('E_TYPE', 'недопустимый тип тайла: ' + n.type, id);
    });
    pitNodes.concat(shortcutNodes).forEach((id) => {
      const node = byId.get(id);
      if (node && !MAIN_TYPES.includes(node.type)) add('E_TYPE', 'недопустимый тип тайла ветки: ' + node.type, id);
    });
    shortcutNodes.forEach((id) => {
      const node = byId.get(id);
      if (node && !SHORTCUT_TYPES.includes(node.type)) {
        add('E_TYPE', 'недопустимый тип тайла среза: ' + node.type, id);
      }
    });

    const starts = nodes.filter((n) => n.type === 'start');
    if (starts.length !== 1) add('E_START_COUNT', 'стартовых тайлов: ' + starts.length);
    if (!mainSet.has(input.startNode)) add('E_START_INDEX', 'startNode не на main');
    else if (main[0] !== input.startNode) add('E_START_INDEX', 'startNode должен быть main[0]');
    const startNode = byId.get(input.startNode);
    if (startNode && startNode.type !== 'start') add('E_START_COUNT', 'startNode должен иметь type start', input.startNode);

    if (new Set(main).size !== main.length) add('E_LOOP', 'main содержит повторяющиеся тайлы');
    for (let i = 0; i < main.length; i++) {
      const node = byId.get(main[i]);
      if (!node) continue;
      const nextId = main[(i + 1) % main.length];
      const prevId = main[(i - 1 + main.length) % main.length];
      if (!(node.next || []).includes(nextId)) add('E_LOOP', 'main[i].next не содержит main[i+1]', main[i]);
      if (!(node.prev || []).includes(prevId)) add('E_LOOP', 'main[i].prev не содержит main[i-1]', main[i]);
    }

    const grid = input.grid || [];
    if (grid.length !== 4) add('E_GRID', 'grid должен содержать 4 слота');
    if (new Set(grid).size !== 2) add('E_GRID', 'grid должен занимать 2 тайла');
    const n = main.length;
    if (n >= 2) {
      const derived = [main[n - 1], main[n - 1], main[n - 2], main[n - 2]];
      if (grid.length === 4 && grid.some((id, i) => id !== derived[i])) add('E_GRID', 'grid должен быть [main[n-1],main[n-1],main[n-2],main[n-2]]');
    }
    const branchEntries = new Set();
    const branchExits = new Set();
    if (pitBranch) { branchEntries.add(input.pit.entry); branchExits.add(input.pit.exit); }
    if (shortcut) { branchEntries.add(shortcut.entry); branchExits.add(shortcut.exit); }
    [...new Set(grid)].forEach((id) => {
      const node = byId.get(id);
      if (!node) return;
      if (branchEntries.has(id)) add('E_GRID_ENTRY', 'grid не может стоять на входе/развилке ветки', id);
      else if (branchExits.has(id)) {
        const allowed = (id === main[n - 1] || id === main[n - 2]);
        if (!allowed) add('E_GRID_ENTRY', 'выход ветки на решётке разрешён только на main[n-1]/main[n-2]', id);
      }
      if (node.type === 'fork') add('E_GRID_ENTRY', 'grid не может стоять на развилке', id);
      if (!NORMAL_GRID_TYPES.includes(node.type)) add('E_GRID', 'grid должен стоять на прямой/повороте', id);
      if (pitTile && input.pit.tile === id) add('E_GRID', 'grid не может стоять на пит-тайле', id);
      if ((input.checkpoints || []).includes(id)) add('E_GRID', 'grid не может стоять на КП', id);
      if (isHazardType(node.type)) add('E_GRID', 'grid не может стоять на опасности', id);
      if (node.type === 'ramp') add('E_GRID', 'grid не может стоять на трамплине', id);
      if (node.road === false) add('E_GRID', 'grid не может стоять на декоре', id);
    });

    if (pitBranch && shortcut) add('E_BRANCH_CONFLICT', 'пит-ветка и срез не могут существовать одновременно');

    let pitA = null, pitB = null, scA = null, scB = null;
    if (pitBranch) {
      pitA = mainIndex.get(input.pit.entry);
      pitB = mainIndex.get(input.pit.exit);
      if (pitA == null || pitB == null) add('E_PIT', 'пит-ветка не связана с main');
      else {
        if (pitA >= pitB) add('E_PIT_WRAP', 'пит-ветка замыкается через старт/финиш');
        const dist = pitB - pitA;
        if (dist < 2 || dist > 5) add('E_PIT_DISTANCE', 'вход/выход пита слишком далеко');
        if (pitNodes.length < 2) add('E_PIT_LENGTH', 'пит-ветка короче 2 тайлов');
        if (pitNodes.length + 1 <= dist) add('E_PIT_LENGTH', 'пит-ветка не длиннее main-сегмента');
        const cpId = (input.checkpoints || []).find((id) => id !== input.startNode);
        const cpIdx = cpId != null ? mainIndex.get(cpId) : null;
        if (cpIdx != null && cpIdx > pitA && cpIdx < pitB) add('E_PIT_CP_BYPASS', 'пит обходит контрольный пункт');
        pitNodes.forEach((id) => {
          const node = byId.get(id);
          if (!node) return;
          if (node.type !== 'pit') add('E_PIT', 'тайл пит-ветки должен быть типа pit', id);
          if (isHazardType(node.type)) add('E_HAZARD_ZONE', 'опасность на пите', id);
        });
      }
    }
    if (pitTile) {
      const tile = byId.get(input.pit.tile);
      if (!mainSet.has(input.pit.tile)) add('E_PIT', 'пит-тайл не на main');
      else if (input.pit.tile === input.startNode || (input.checkpoints || []).includes(input.pit.tile)) add('E_PIT', 'пит-тайл на старте/КП');
      else if (grid.includes(input.pit.tile)) add('E_GRID', 'grid не может стоять на пит-тайле');
      else if (!tile || tile.type !== 'pit' || !tile.pitLane) add('E_PIT', 'пит-тайл должен иметь type pit/pitLane');
      if (tile && isHazardType(tile.type)) add('E_HAZARD_ZONE', 'опасность на пите', tile.id);
    }
    if (shortcut) {
      scA = mainIndex.get(shortcut.entry);
      scB = mainIndex.get(shortcut.exit);
      if (scA == null || scB == null) add('E_SHORTCUT', 'срез не связан с main');
      else {
        if (scA >= scB) add('E_SHORTCUT_WRAP', 'срез замыкается через старт/финиш');
        const dist = scB - scA;
        if (scA <= 3 || scB >= main.length - 3) add('E_SHORTCUT_NEAR_START', 'срез слишком близко к старту/финишу');
        const branchLen = shortcutNodes.length + 1;
        const saving = dist - branchLen;
        if (saving < 1 || saving > 2) add('E_SHORTCUT_SAVING', 'срез должен экономить 1–2 тайла');
        if (!shortcutNodes.length) add('E_SHORTCUT', 'срез должен иметь хотя бы один тайл');
        if (!shortcutNodes.some((id) => { const node = byId.get(id); return node && isHazardType(node.type); })) {
          add('E_SHORTCUT_RISK', 'на срезе должна остаться хотя бы одна опасность');
        }
        const cpId = (input.checkpoints || []).find((id) => id !== input.startNode);
        const cpIdx = cpId != null ? mainIndex.get(cpId) : null;
        if (cpIdx != null && cpIdx > scA && cpIdx < scB) {
          add('W_SHORTCUT_CP_BYPASS', 'КП пропущен; движок не требует КП для финиша');
        }
      }
    }

    const expectNext = new Map(nodes.map((nd) => [nd.id, 0]));
    const expectPrev = new Map(nodes.map((nd) => [nd.id, 0]));
    main.forEach((id) => { expectNext.set(id, 1); expectPrev.set(id, 1); });
    pitNodes.forEach((id) => { expectNext.set(id, 1); expectPrev.set(id, 1); });
    shortcutNodes.forEach((id) => { expectNext.set(id, 1); expectPrev.set(id, 1); });
    decorIds.forEach((id) => { expectNext.set(id, 0); expectPrev.set(id, 0); });
    if (pitBranch) { expectNext.set(input.pit.entry, (expectNext.get(input.pit.entry) || 0) + 1); expectPrev.set(input.pit.exit, (expectPrev.get(input.pit.exit) || 0) + 1); }
    if (shortcut) { expectNext.set(shortcut.entry, (expectNext.get(shortcut.entry) || 0) + 1); expectPrev.set(shortcut.exit, (expectPrev.get(shortcut.exit) || 0) + 1); }
    nodes.forEach((nd) => {
      const en = expectNext.get(nd.id);
      const ep = expectPrev.get(nd.id);
      if (en == null) { add('E_DEGREE', 'лишний узел вне main/веток/декора', nd.id); return; }
      if ((nd.next || []).length !== en) add('E_DEGREE', 'неверное число выходов', nd.id);
      if ((nd.prev || []).length !== ep) add('E_DEGREE', 'неверное число входов', nd.id);
    });
    const inverse = new Map(nodes.map((nd) => [nd.id, []]));
    nodes.forEach((nd) => (nd.next || []).forEach((to) => { if (inverse.has(to)) inverse.get(to).push(nd.id); }));
    nodes.forEach((nd) => {
      const a = (nd.prev || []).slice().sort((x, y) => x - y);
      const b = (inverse.get(nd.id) || []).slice().sort((x, y) => x - y);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) add('E_DEGREE', 'prev не является точной инверсией next', nd.id);
    });

    const checkChain = (entry, exit, list, code) => {
      if (entry == null || exit == null) return;
      let prev = entry;
      for (const id of list) {
        const node = byId.get(id);
        if (!node || !(node.prev || []).includes(prev)) { add(code, 'ветка разорвана', id); return; }
        prev = id;
      }
      const last = byId.get(prev);
      if (!last || !(last.next || []).includes(exit)) add(code, 'ветка не доходит до exit', prev);
    };
    if (pitBranch) checkChain(input.pit.entry, input.pit.exit, pitNodes, 'E_BRANCH');
    if (shortcut) checkChain(shortcut.entry, shortcut.exit, shortcutNodes, 'E_BRANCH');

    const seen = new Set();
    const queue = [input.startNode];
    while (queue.length) {
      const u = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      const node = byId.get(u);
      if (node) (node.next || []).forEach((v) => { if (!seen.has(v)) queue.push(v); });
    }
    main.forEach((id) => { if (!seen.has(id)) add('E_REACHABILITY', 'тайл не достижим из старта', id); });
    pitNodes.concat(shortcutNodes).forEach((id) => { if (!seen.has(id)) add('E_BRANCH', 'узел ветки не достижим из старта', id); });

    const protectedIds = new Set([input.startNode, ...(input.grid || []), ...(input.checkpoints || [])]);
    const startZone = zoneBufferUids(main, input.startNode, [], 3, 0);
    startZone.forEach((id) => protectedIds.add(id));
    const cpId = (input.checkpoints || []).find((id) => id !== input.startNode);
    const cpZone = cpId != null ? zoneBufferUids(main, input.startNode, [cpId], 0, 2) : new Set();
    if (pitBranch) { protectedIds.add(input.pit.entry); protectedIds.add(input.pit.exit); }
    if (pitTile) protectedIds.add(input.pit.tile);
    let run = 0;
    for (let i = 0; i < main.length * 2; i++) {
      const node = byId.get(main[i % main.length]);
      run = node && isHazardType(node.type) ? run + 1 : 0;
      if (run > 2) { add('E_HAZARD_RUN', 'больше двух опасных подряд', node && node.id); break; }
    }
    main.forEach((id) => {
      const node = byId.get(id);
      if (!node) return;
      if (isHazardType(node.type)) {
        if (protectedIds.has(id)) add('E_HAZARD_ZONE', 'опасность на старте/решётке/КП', id);
        else if (cpZone.has(id)) add('E_CP_BUFFER', 'опасность в буфере КП ±2', id);
      }
      if (node.type === 'ramp') {
        if (protectedIds.has(id)) add('E_RAMP_ZONE', 'трамплин на старте/решётке/КП', id);
        else if (cpZone.has(id)) add('E_CP_BUFFER', 'трамплин в буфере КП ±2', id);
      }
    });

    const cpNodes = nodes.filter((n) => n.type === 'checkpoint');
    if ((input.checkpoints || [])[0] !== input.startNode) {
      add('E_CHECKPOINT', 'checkpoints[0] должен совпадать со startNode');
    }
    const cps = (input.checkpoints || []).filter((id) => id !== input.startNode);
    if (cpNodes.length !== 1) add('E_CHECKPOINT', 'должен быть ровно один узел КП, найдено: ' + cpNodes.length);
    if (cps.length !== 1) add('E_CHECKPOINT', 'должен быть ровно один не-стартовый КП');
    if (cpNodes.length === 1) {
      if (!mainSet.has(cpNodes[0].id)) add('E_CHECKPOINT', 'узел КП должен быть на main', cpNodes[0].id);
      if (cps.length === 1 && cps[0] !== cpNodes[0].id) add('E_CHECKPOINT', 'checkpoints не совпадает с узлом КП', cpNodes[0].id);
    }
    cps.forEach((id) => {
      const idx = mainIndex.get(id);
      const node = byId.get(id);
      if (idx == null) { add('E_CHECKPOINT', 'КП не на main', id); return; }
      if (idx / main.length < 0.25 || idx / main.length > 0.65) add('E_CHECKPOINT', 'КП вне 25..65% круга', id);
      if (!node || node.type !== 'checkpoint') add('E_CHECKPOINT', 'узел КП должен иметь type checkpoint', id);
      if (protectedIds.has(id) && (input.grid || []).includes(id)) add('E_CHECKPOINT', 'КП на решётке', id);
    });

    if (opts.allowNonAxial !== true) {
      roadIds.forEach((id) => {
        const node = byId.get(id);
        if (!node) return;
        if (!isInt(node.q) || !isInt(node.r)) add('E_COORD', 'дорога вне осевой сетки', id);
      });
      const coords = new Map();
      roadIds.forEach((id) => {
        const node = byId.get(id);
        if (!node) return;
        const key = coordKey(node);
        if (!coords.has(key)) coords.set(key, []);
        coords.get(key).push(id);
      });
      coords.forEach((ids) => { if (ids.length > 1) add('E_DUPLICATE_COORD', 'две дороги в одной клетке', ids[0]); });
    }
    const decorSet = new Set();
    decorIds.forEach((id) => {
      const node = byId.get(id);
      if (!node) return;
      if (!['building', 'ruin'].includes(node.type)) add('E_DECOR', 'декор должен быть building/ruin', id);
      if (node.road !== false) add('E_DECOR', 'у декора road должен быть false', id);
      if (roadIds.has(id)) add('E_DECOR', 'декор не может быть дорогой', id);
      const key = coordKey(node);
      if (decorSet.has(key)) add('E_DUPLICATE_COORD', 'два декора в одной клетке', id);
      decorSet.add(key);
      const road = [...roadIds].map((rid) => byId.get(rid)).find((rn) => rn && coordKey(rn) === key);
      if (road) add('E_DUPLICATE_COORD', 'декор стоит на дороге', id);
    });
    const seenDecorKeys = new Set(decorSet);
    (input.decor || []).forEach((d) => {
      if (typeof d !== 'object') return;
      if (!d || !isInt(d.q) || !isInt(d.r)) {
        add('E_COORD', 'объектный декор вне осевой сетки');
        return;
      }
      const key = d.q + ',' + d.r;
      if (roadCoordKeys.has(key)) add('E_DUPLICATE_COORD', 'объектный декор стоит на дороге');
      if (seenDecorKeys.has(key)) add('E_DUPLICATE_COORD', 'объектный декор в занятой клетке');
      seenDecorKeys.add(key);
    });

    return { ok: !hasError(issues), issues };
  }

  /* --- B1: read-only detection / validate-first pipeline ------------- */

  function detectReadOnly(canonical) {
    if (Array.isArray(canonical.decor) && canonical.decor.some((d) => typeof d === 'object')) return 'decor';
    if (canonical.layout && canonical.layout !== 'axial') return 'layout';
    const byId = new Map((canonical.nodes || []).map((n) => [n.id, n]));
    const main = canonical.main || [];
    const road = new Set(main);
    (canonical.pit && canonical.pit.nodes || []).forEach((id) => road.add(id));
    (canonical.shortcut && canonical.shortcut.nodes || []).forEach((id) => road.add(id));
    for (const id of road) {
      const node = byId.get(id);
      if (node && node.type === 'fork') return 'fork';
    }
    for (const id of road) {
      const node = byId.get(id);
      if (!node) continue;
      if (!isInt(node.q) || !isInt(node.r)) return 'coord';
      for (const to of (node.next || [])) {
        const target = byId.get(to);
        if (!target || target.road === false) continue;
        if (!axialAdjacent(node, target)) return 'edge';
      }
    }
    return null;
  }

  function prepareSpec(spec) {
    if (!spec || spec.schemaVersion !== 1) {
      return { ok: false, readOnly: false, issues: [issue('E_SCHEMA', 'нет TrackSpec schemaVersion 1')], warnings: [] };
    }
    const stageA = CnA.validateTrackSpec(spec);
    if (!stageA.ok) return { ok: false, readOnly: false, issues: stageA.issues, warnings: [] };
    if ((spec.checkpoints || [])[0] !== spec.startNode) {
      return { ok: false, readOnly: false, issues: [issue('E_CHECKPOINT', 'checkpoints[0] должен совпадать со startNode')], warnings: [] };
    }

    const canon = canonicalizeRepresentation(spec);
    if (!canon.ok) return { ok: false, readOnly: false, issues: canon.issues, warnings: [] };
    const mig = migrateKnownHorseshoe(canon.spec);
    const canonical = mig.spec;
    const warnings = [];
    if (mig.migrated) {
      warnings.push(issue('W_MIGRATED_GEOMETRY', 'Геометрия подковы исправлена: [8,−1]/[9,−1] → [8,0]/[9,0].'));
    }
    const reason = detectReadOnly(canonical);
    const structural = validateStructural(canonical, {
      allowNonAxial: reason === 'layout' || reason === 'coord',
      allowFork: reason === 'fork',
    });
    const cpBuffer = structural.issues.filter((i) => i.code === 'E_CP_BUFFER');
    const hard = structural.issues.filter((i) => String(i.code).startsWith('E_') && i.code !== 'E_CP_BUFFER');
    if (hard.length) {
      return { ok: false, readOnly: false, issues: structural.issues, warnings };
    }
    cpBuffer.forEach((i) => warnings.push(issue('W_CP_BUFFER', i.message, i.nodeId)));
    const again = CnA.validateTrackSpec(canonical);
    if (!again.ok) {
      return { ok: false, readOnly: false, issues: again.issues, warnings };
    }
    warnings.push(...structural.issues.filter((i) => String(i.code).startsWith('W_')));
    return {
      ok: true,
      readOnly: !!reason,
      reason,
      issues: [],
      warnings,
      canonical,
      originalSpec: clone(spec),
      migrated: mig.migrated,
    };
  }

  /* --- B1: draft <-> spec ------------------------------------------- */

  function draftFromCanonical(spec, opts) {
    opts = opts || {};
    const uidOf = new Map((spec.nodes || []).map((n) => [n.id, 'd' + n.id]));
    const nodes = (spec.nodes || []).map((n) => ({ uid: uidOf.get(n.id), q: n.q, r: n.r, type: n.type }));
    const main = (spec.main || []).map((id) => uidOf.get(id));
    const n = main.length;
    const cpId = (spec.checkpoints || []).find((id) => id !== spec.startNode);
    let pit = null;
    if (spec.pit) {
      if (spec.pit.nodes && spec.pit.nodes.length) {
        pit = {
          kind: 'branch',
          entry: uidOf.get(spec.pit.entry),
          exit: uidOf.get(spec.pit.exit),
          nodes: spec.pit.nodes.map((id) => uidOf.get(id)),
        };
      } else if (spec.pit.tile != null) {
        pit = { kind: 'tile', tile: uidOf.get(spec.pit.tile) };
      }
    }
    let shortcut = null;
    if (spec.shortcut) {
      shortcut = {
        entry: uidOf.get(spec.shortcut.entry),
        exit: uidOf.get(spec.shortcut.exit),
        nodes: (spec.shortcut.nodes || []).map((id) => uidOf.get(id)),
        type: spec.shortcut.type || 'debris',
      };
    }
    const locks = { nodes: {}, features: {} };
    FEATURE_NAMES.forEach((f) => { locks.features[f] = false; });
    const source = {
      kind: opts.kind || 'generated',
      trackId: opts.trackId || null,
      archetype: spec.archetype,
      seed: spec.seed,
      specId: spec.id,
      sourceSpec: clone(spec),
      originalSpec: opts.originalSpec ? clone(opts.originalSpec) : clone(spec),
      migrated: opts.migrated ? ['horseshoe-bump-v1'] : [],
    };
    if (Object.prototype.hasOwnProperty.call(spec, 'label')) source.label = spec.label;
    return {
      draftVersion: 1,
      name: cleanName(spec.name),
      hexSize: spec.hexSize || 34,
      layout: 'axial',
      nodes,
      main,
      startUid: uidOf.get(spec.startNode),
      checkpointUid: cpId != null ? uidOf.get(cpId) : null,
      grid: n >= 2 ? [main[n - 1], main[n - 1], main[n - 2], main[n - 2]] : [],
      pit,
      shortcut,
      decor: (spec.decor || []).filter((d) => typeof d !== 'object').map((id) => uidOf.get(id)),
      legacyDecor: Array.isArray(spec.decor) ? spec.decor.filter((d) => typeof d === 'object') : [],
      locks,
      uidSeq: (spec.nodes || []).length,
      source,
    };
  }

  function fromSpec(spec, opts) {
    opts = opts || {};
    const prepared = prepareSpec(spec);
    if (!prepared.ok) return prepared;
    if (prepared.readOnly && !prepared.canonical) {
      return {
        ok: true,
        readOnly: true,
        reason: prepared.reason,
        issues: [],
        warnings: prepared.warnings || [],
        draft: null,
        originalSpec: prepared.originalSpec,
      };
    }
    const draft = draftFromCanonical(prepared.canonical, {
      kind: opts.kind,
      trackId: opts.trackId,
      migrated: prepared.migrated,
      originalSpec: prepared.originalSpec,
    });
    return {
      ok: true,
      readOnly: !!prepared.readOnly,
      reason: prepared.reason || null,
      issues: [],
      warnings: prepared.warnings || [],
      draft,
      canonical: prepared.canonical,
      originalSpec: prepared.originalSpec,
    };
  }

  function toSpec(draft) {
    const byUid = new Map((draft.nodes || []).map((n) => [n.uid, n]));
    const mainUids = (draft.main || []).slice();
    const pitBranch = draft.pit && draft.pit.kind === 'branch';
    const pitUids = pitBranch ? (draft.pit.nodes || []).slice() : [];
    const shortcut = draft.shortcut || null;
    const shortcutUids = shortcut ? (shortcut.nodes || []).slice() : [];
    const decorUids = (draft.decor || []).slice();
    const order = mainUids.concat(pitUids, shortcutUids, decorUids);
    const idOf = new Map();
    let seq = 0;
    mainUids.forEach((u) => idOf.set(u, seq++));
    pitUids.forEach((u) => idOf.set(u, seq++));
    shortcutUids.forEach((u) => idOf.set(u, seq++));
    decorUids.forEach((u) => idOf.set(u, seq++));
    const hexSize = draft.hexSize || 34;
    const n = mainUids.length;
    const next = new Map(order.map((u) => [u, []]));
    const prev = new Map(order.map((u) => [u, []]));
    const link = (a, b) => { if (!next.has(a) || !prev.has(b)) return; next.get(a).push(b); prev.get(b).push(a); };

    for (let i = 0; i < n; i++) link(mainUids[i], mainUids[(i + 1) % n]);
    const wireBranch = (spec) => {
      if (!spec) return;
      const entry = spec.entry;
      const exit = spec.exit;
      const list = spec.nodes || [];
      if (!list.length) return;
      link(entry, list[0]);
      for (let i = 0; i < list.length - 1; i++) link(list[i], list[i + 1]);
      link(list[list.length - 1], exit);
    };
    if (pitBranch) wireBranch(draft.pit);
    if (shortcut) wireBranch(shortcut);

    const nodes = order.map((uid) => {
      const src = byUid.get(uid) || { uid, q: 0, r: 0, type: 'straight' };
      const p = hexXY(src.q, src.r, hexSize);
      const base = {
        id: idOf.get(uid),
        q: src.q,
        r: src.r,
        x: p.x,
        y: p.y,
        type: src.type,
        next: next.get(uid).map((u) => idOf.get(u)),
        prev: prev.get(uid).map((u) => idOf.get(u)),
      };
      if (decorUids.includes(uid)) return Object.assign(base, { road: false, level: 0 });
      if (pitUids.includes(uid)) return Object.assign(base, { pitLane: true, level: 0 });
      if (shortcutUids.includes(uid)) return Object.assign(base, { inner: true, level: 0 });
      return Object.assign(base, {
        checkpoint: uid === draft.checkpointUid,
        pitLane: !!(draft.pit && draft.pit.kind === 'tile' && draft.pit.tile === uid),
        level: 0,
      });
    });

    const out = {
      schemaVersion: 1,
      id: (draft.source && draft.source.specId) || 'custom-draft',
      name: draft.name,
      archetype: (draft.source && draft.source.archetype) || 'custom',
      seed: (draft.source && draft.source.seed != null) ? draft.source.seed : 0,
      size: n,
      hexSize,
      levels: 1,
      theme: 'dust',
      layout: 'axial',
      startNode: 0,
      grid: n >= 2 ? [n - 1, n - 1, n - 2, n - 2] : [],
      main: Array.from({ length: n }, (_, i) => i),
      nodes,
      pit: null,
      shortcut: null,
      checkpoints: [0, idOf.get(draft.checkpointUid)],
      decor: decorUids.map((u) => idOf.get(u)),
    };
    if (draft.source && draft.source.label !== undefined) out.label = draft.source.label;
    if (draft.pit) {
      out.pit = draft.pit.kind === 'branch'
        ? { entry: idOf.get(draft.pit.entry), exit: idOf.get(draft.pit.exit), nodes: pitUids.map((u) => idOf.get(u)) }
        : { tile: idOf.get(draft.pit.tile), entry: null, exit: null, nodes: [] };
    }
    if (draft.shortcut) {
      out.shortcut = {
        entry: idOf.get(draft.shortcut.entry),
        exit: idOf.get(draft.shortcut.exit),
        nodes: shortcutUids.map((u) => idOf.get(u)),
        type: draft.shortcut.type || 'debris',
      };
    }
    return out;
  }

  /* --- B2/B4: draft invariants, session and operations ---------------- */

  function validateDraft(draft) {
    const issues = [];
    const add = (code, message, uid) => issues.push(issue(code, message, uid));
    if (!draft || draft.draftVersion !== 1) {
      add('E_SCHEMA', 'нет TrackDraft draftVersion 1');
      return { ok: false, issues, warnings: [] };
    }
    const nodes = draft.nodes || [];
    const byUid = new Map();
    nodes.forEach((n) => {
      if (byUid.has(n.uid)) add('E_DUP_ID', 'повторяющийся uid узла ' + n.uid, n.uid);
      else byUid.set(n.uid, n);
    });
    if (issues.length) return { ok: false, issues, warnings: [] };
    const main = draft.main || [];
    const n = main.length;
    const pitBranch = !!(draft.pit && draft.pit.kind === 'branch');
    const pitNodes = pitBranch ? (draft.pit.nodes || []) : [];
    const shortcut = draft.shortcut || null;
    const shortcutNodes = shortcut ? (shortcut.nodes || []) : [];
    const decor = draft.decor || [];
    const ref = (uid, message) => { if (uid == null || !byUid.has(uid)) add('E_REF', message, uid); };
    main.forEach((uid) => ref(uid, 'main ссылается на несуществующий uid'));
    ref(draft.startUid, 'startUid отсутствует');
    ref(draft.checkpointUid, 'checkpointUid отсутствует');
    (draft.grid || []).forEach((uid) => ref(uid, 'grid ссылается на несуществующий uid'));
    pitNodes.forEach((uid) => ref(uid, 'пит-ветка ссылается на несуществующий uid'));
    if (pitBranch) { ref(draft.pit.entry, 'pit.entry отсутствует'); ref(draft.pit.exit, 'pit.exit отсутствует'); }
    if (draft.pit && draft.pit.kind === 'tile') ref(draft.pit.tile, 'pit.tile отсутствует');
    if (shortcut) {
      ref(shortcut.entry, 'shortcut.entry отсутствует');
      ref(shortcut.exit, 'shortcut.exit отсутствует');
      shortcutNodes.forEach((uid) => ref(uid, 'срез ссылается на несуществующий uid'));
    }
    decor.forEach((uid) => ref(uid, 'decor ссылается на несуществующий uid'));
    if (issues.length) return { ok: false, issues, warnings: [] };

    if (n < 24 || n > 36) add('E_LENGTH', 'длина круга вне 24..36');
    if (main[0] !== draft.startUid) add('E_START_INDEX', 'startUid должен быть main[0]');
    const starts = nodes.filter((x) => x.type === 'start');
    if (starts.length !== 1) add('E_START_COUNT', 'стартовых тайлов: ' + starts.length);
    if ((byUid.get(draft.startUid) || {}).type !== 'start') add('E_START_COUNT', 'startUid должен иметь type start');
    const cps = nodes.filter((x) => x.type === 'checkpoint');
    if (cps.length !== 1) add('E_CHECKPOINT', 'КП должен быть ровно один');
    if (cps.length === 1 && cps[0].uid !== draft.checkpointUid) add('E_CHECKPOINT', 'checkpointUid не совпадает с узлом КП');
    if (pitBranch && shortcut) add('E_BRANCH_CONFLICT', 'пит-ветка и срез не могут существовать одновременно');

    const grid = draft.grid || [];
    if (grid.length !== 4 || new Set(grid).size !== 2) add('E_GRID', 'grid должен занимать 2 тайла');
    if (n >= 2) {
      const derived = [main[n - 1], main[n - 1], main[n - 2], main[n - 2]];
      if (grid.length !== 4 || grid.some((uid, i) => uid !== derived[i])) add('E_GRID', 'grid должен быть производным от main');
    }

    // Роли веток.
    const mainSet = new Set(main);
    pitNodes.forEach((uid) => {
      const node = byUid.get(uid);
      if (!node) return;
      if (mainSet.has(uid)) add('E_BRANCH', 'узел пит-ветки не может быть на main', uid);
      if (node.type !== 'pit') add('E_PIT', 'тайл пит-ветки должен быть типа pit', uid);
    });
    if (pitBranch) {
      if (!mainSet.has(draft.pit.entry)) add('E_PIT', 'pit.entry не на main', draft.pit.entry);
      if (!mainSet.has(draft.pit.exit)) add('E_PIT', 'pit.exit не на main', draft.pit.exit);
    }
    if (draft.pit && draft.pit.kind === 'tile') {
      if (!mainSet.has(draft.pit.tile)) add('E_PIT', 'pit.tile не на main', draft.pit.tile);
      else {
        const node = byUid.get(draft.pit.tile);
        if (!node || node.type !== 'pit') add('E_PIT', 'pit.tile должен иметь type pit', draft.pit.tile);
      }
    }
    shortcutNodes.forEach((uid) => {
      if (mainSet.has(uid)) add('E_BRANCH', 'узел среза не может быть на main', uid);
    });
    if (shortcut) {
      if (!mainSet.has(shortcut.entry)) add('E_SHORTCUT', 'shortcut.entry не на main', shortcut.entry);
      if (!mainSet.has(shortcut.exit)) add('E_SHORTCUT', 'shortcut.exit не на main', shortcut.exit);
      if (!shortcutNodes.some((uid) => { const node = byUid.get(uid); return node && isHazardType(node.type); })) {
        add('E_SHORTCUT_RISK', 'на срезе должна остаться хотя бы одна опасность');
      }
    }

    // Координаты.
    const roadUids = main.concat(pitNodes, shortcutNodes);
    const roadCoords = new Map();
    roadUids.forEach((uid) => {
      const node = byUid.get(uid);
      if (!node) return;
      if (!isInt(node.q) || !isInt(node.r)) add('E_AXIAL', 'дорога вне осевой сетки', uid);
      else {
        const key = node.q + ',' + node.r;
        if (roadCoords.has(key)) add('E_DUPLICATE_COORD', 'две дороги в одной клетке', uid);
        else roadCoords.set(key, uid);
      }
    });
    const decorSet = new Set();
    decor.forEach((uid) => {
      const node = byUid.get(uid);
      if (!node) return;
      if (!['building', 'ruin'].includes(node.type)) add('E_DECOR', 'декор должен быть building/ruin', uid);
      if (roadCoords.has(node.q + ',' + node.r) || mainSet.has(uid)) add('E_DECOR', 'декор на дороге', uid);
      if (decorSet.has(uid)) add('E_DUP_ID', 'повторяющийся декор', uid);
      decorSet.add(uid);
    });
    decor.forEach((uid) => {
      const node = byUid.get(uid);
      if (!node) return;
      const key = node.q + ',' + node.r;
      roadUids.forEach((rid) => {
        const rn = byUid.get(rid);
        if (rn && key === rn.q + ',' + rn.r) add('E_DUPLICATE_COORD', 'декор на дороге', uid);
      });
    });

    // Осевая смежность.
    for (let i = 0; i < n; i++) {
      if (!axialAdjacent(byUid.get(main[i]), byUid.get(main[(i + 1) % n]))) add('E_AXIAL', 'соседние тайлы круга не соприкасаются', main[i]);
    }
    const checkBranch = (entry, list, exit) => {
      let prev = entry;
      for (const uid of list) {
        if (!axialAdjacent(byUid.get(prev), byUid.get(uid))) add('E_AXIAL', 'ветка разорвана', uid);
        prev = uid;
      }
      if (list.length && !axialAdjacent(byUid.get(prev), byUid.get(exit))) add('E_AXIAL', 'ветка не доходит до exit', prev);
    };
    if (pitBranch) checkBranch(draft.pit.entry, pitNodes, draft.pit.exit);
    if (shortcut) checkBranch(shortcut.entry, shortcutNodes, shortcut.exit);

    // Полная проверка через спеку.
    let spec = null;
    try { spec = toSpec(draft); } catch (e) {
      add('E_DRAFT', 'не удалось собрать TrackSpec: ' + String(e && e.message || e));
    }
    if (spec) {
      const structural = validateStructural(spec);
      structural.issues.forEach((i) => {
        if (i.code === 'E_CP_BUFFER') issues.push(issue('W_CP_BUFFER', i.message, i.nodeId));
        else issues.push(i);
      });
      const stageA = CnA.validateTrackSpec(spec);
      if (!stageA.ok) issues.push(...stageA.issues);
    }
    return {
      ok: !hasError(issues),
      issues,
      warnings: issues.filter((i) => String(i.code).startsWith('W_')),
    };
  }

  function mainIndexOf(draft, uid) { return (draft.main || []).indexOf(uid); }

  function connectedUids(draft, uid) {
    const out = [];
    const n = draft.main.length;
    const mi = mainIndexOf(draft, uid);
    const pitBranch = draft.pit && draft.pit.kind === 'branch';
    const pitNodes = pitBranch ? draft.pit.nodes : [];
    const shortcutNodes = draft.shortcut ? draft.shortcut.nodes : [];
    if (mi >= 0) {
      out.push(draft.main[(mi - 1 + n) % n], draft.main[(mi + 1) % n]);
      if (pitBranch && pitNodes.length) {
        if (draft.pit.entry === uid) out.push(pitNodes[0]);
        if (draft.pit.exit === uid) out.push(pitNodes[pitNodes.length - 1]);
      }
      if (draft.shortcut && shortcutNodes.length) {
        if (draft.shortcut.entry === uid) out.push(shortcutNodes[0]);
        if (draft.shortcut.exit === uid) out.push(shortcutNodes[shortcutNodes.length - 1]);
      }
    } else {
      const chain = (entry, list, exit) => {
        const idx = list.indexOf(uid);
        if (idx < 0) return false;
        out.push(idx === 0 ? entry : list[idx - 1]);
        out.push(idx === list.length - 1 ? exit : list[idx + 1]);
        return true;
      };
      if (pitBranch && chain(draft.pit.entry, pitNodes, draft.pit.exit)) { /* ok */ }
      else if (draft.shortcut && chain(draft.shortcut.entry, shortcutNodes, draft.shortcut.exit)) { /* ok */ }
    }
    return [...new Set(out.filter(Boolean))];
  }

  function TrackDraftSession(res, opts) {
    opts = opts || {};
    this.draft = res.draft;
    this.readOnly = !!res.readOnly;
    this.reason = res.reason || null;
    this.originalSpec = res.originalSpec || null;
    this.warnings = (res.warnings || []).slice();
    this.issues = [];
    this.past = [];
    this.future = [];
    this.revision = 0;
    this.uidSeq = this.draft ? (this.draft.uidSeq || this.draft.nodes.length) : 0;
    this.selectionUid = null;
    this.focusUid = null;
    this.baselineFingerprint = this.draft ? JSON.stringify(toSpec(this.draft)) : null;
    this.unsavedNew = !this.draft || (this.draft.source.kind !== 'saved' && !this.draft.source.trackId);
    const self = this;
    Object.defineProperty(this, 'dirty', {
      enumerable: true,
      get() { return !!self.draft && JSON.stringify(toSpec(self.draft)) !== self.baselineFingerprint; },
    });
  }

  TrackDraftSession.prototype.nextUid = function () {
    const uid = 'd' + this.uidSeq;
    this.uidSeq += 1;
    return uid;
  };

  TrackDraftSession.prototype.snapshot = function () {
    return {
      draft: clone(this.draft),
      selectionUid: this.selectionUid,
      focusUid: this.focusUid,
      revision: this.revision,
    };
  };

  TrackDraftSession.prototype.pushHistory = function () {
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  };

  TrackDraftSession.prototype.restore = function (snap) {
    this.draft = snap.draft;
    this.selectionUid = snap.selectionUid;
    this.focusUid = snap.focusUid;
    this.revision = snap.revision;
    this.uidSeq = Math.max(this.uidSeq, this.draft.nodes.length);
  };

  TrackDraftSession.prototype.undo = function () {
    if (this.readOnly) return { ok: false, issues: [issue('E_READONLY', 'Трасса только для чтения.')] };
    if (!this.past.length) return { ok: false, issues: [issue('E_UNDO_EMPTY', 'Нечего отменять.')] };
    this.future.push(this.snapshot());
    this.restore(this.past.pop());
    return { ok: true, issues: [] };
  };

  TrackDraftSession.prototype.redo = function () {
    if (this.readOnly) return { ok: false, issues: [issue('E_READONLY', 'Трасса только для чтения.')] };
    if (!this.future.length) return { ok: false, issues: [issue('E_REDO_EMPTY', 'Нечего повторять.')] };
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.restore(this.future.pop());
    return { ok: true, issues: [] };
  };

  TrackDraftSession.prototype.commit = function (candidate, opts) {
    const check = validateDraft(candidate);
    if (hasError(check.issues)) return { ok: false, issues: check.issues };
    this.pushHistory();
    this.draft = candidate;
    this.revision += 1;
    if (opts && opts.selectionUid !== undefined) {
      this.selectionUid = opts.selectionUid;
      this.focusUid = opts.selectionUid;
    }
    const warnings = (opts && opts.warnings ? opts.warnings : []).concat(check.warnings || []);
    return { ok: true, issues: [], warnings, selectionUid: this.selectionUid };
  };

  TrackDraftSession.prototype.select = function (uid) {
    if (uid != null && !this.draft.nodes.some((n) => n.uid === uid)) {
      return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    }
    this.selectionUid = uid || null;
    this.focusUid = uid || null;
    return { ok: true, issues: [], selectionUid: this.selectionUid };
  };

  TrackDraftSession.prototype.apply = function (op) {
    op = op || {};
    if (op.op === 'select') return this.select(op.uid);
    if (this.readOnly) return { ok: false, issues: [issue('E_READONLY', 'Трасса только для чтения.')] };
    switch (op.op) {
      case 'paint': return this.paint(op.uid, op.type);
      case 'insertBetween': return this.insertBetween(op.from, op.to);
      case 'remove': return this.remove(op.uid);
      case 'move': return this.move(op.uid, op.q, op.r);
      case 'setStart': return this.setStart(op.uid);
      case 'setCheckpoint': return this.setCheckpoint(op.uid);
      case 'setPitTile': return this.setPitTile(op.uid, op);
      case 'setPitBranch': return this.setPitBranch(op.entry, op.exit, op);
      case 'setShortcut': return this.setShortcut(op.entry, op.exit, op);
      case 'clearPit': return this.clearPit(op);
      case 'clearShortcut': return this.clearShortcut(op);
      case 'setLock': return this.setLock(op.uid, op.flags);
      case 'setFeatureLock': return this.setFeatureLock(op.feature, op.locked);
      default: return { ok: false, issues: [issue('E_OP', 'Неизвестная операция: ' + op.op)] };
    }
  };

  TrackDraftSession.prototype.paint = function (uid, type) {
    const node = this.draft.nodes.find((n) => n.uid === uid);
    if (!node) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    if (uid === this.draft.startUid || uid === this.draft.checkpointUid ||
      (this.draft.pit && this.draft.pit.kind === 'tile' && this.draft.pit.tile === uid)) {
      return { ok: false, issues: [issue('E_PAINT_FEATURE', 'Старт, КП и пит меняются инструментами.')] };
    }
    if ((this.draft.pit && this.draft.pit.kind === 'branch' && this.draft.pit.nodes.includes(uid)) ||
      (this.draft.decor || []).includes(uid)) {
      return { ok: false, issues: [issue('E_TILE_ROLE', 'Этот тип доступен только основной петле.')] };
    }
    if (!PAINT_TYPES.includes(type)) {
      return { ok: false, issues: [issue(['start', 'checkpoint', 'pit'].includes(type) ? 'E_PAINT_FEATURE' : 'E_TILE_ROLE',
        'Этот тип недоступен кисти.')] };
    }
    const lock = this.draft.locks && this.draft.locks.nodes[uid];
    if (lock && lock.type) return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
    if (isHazardType(type) && !isHazardType(node.type)) {
      const mainHazards = this.draft.main.filter((mainUid) => {
        const mn = this.draft.nodes.find((x) => x.uid === mainUid);
        return mn && isHazardType(mn.type);
      }).length;
      if (mainHazards >= MAX_HAZARDS) {
        return { ok: false, issues: [issue('E_HAZARD_MAX', 'Нельзя ставить больше ' + MAX_HAZARDS + ' опасностей на круг.')] };
      }
    }
    const onShortcut = !!(this.draft.shortcut && this.draft.shortcut.nodes.includes(uid));
    if (onShortcut && (type === 'tunnel' || type === 'bridge')) {
      return { ok: false, issues: [issue('E_TILE_ROLE', 'Этот тип доступен только основной петле.')] };
    }
    const hardIds = new Set([...(this.draft.grid || [])]);
    zoneBufferUids(this.draft.main, this.draft.startUid, [], 3, 0).forEach((id) => hardIds.add(id));
    const cpZone = zoneBufferUids(this.draft.main, this.draft.startUid, [this.draft.checkpointUid], 0, 2);
    if ((isHazardType(type) || type === 'ramp') && hardIds.has(uid)) {
      return { ok: false, issues: [issue(isHazardType(type) ? 'E_HAZARD_ZONE' : 'E_RAMP_ZONE',
        isHazardType(type) ? 'Опасность нельзя ставить на старт или решётку.' : 'Трамплин нельзя ставить на старт или решётку.')] };
    }
    const paintWarnings = [];
    if ((isHazardType(type) || type === 'ramp') && cpZone.has(uid) && !hardIds.has(uid)) {
      paintWarnings.push(issue('W_CP_BUFFER', 'Опасность/трамплин в буфере КП ±2 (предупреждение; допускается).', uid));
    }
    if (onShortcut && isHazardType(node.type) && !isHazardType(type)) {
      const others = this.draft.shortcut.nodes.some((x) => {
        if (x === uid) return false;
        const other = this.draft.nodes.find((nd) => nd.uid === x);
        return other && isHazardType(other.type);
      });
      if (!others) return { ok: false, issues: [issue('E_SHORTCUT_RISK', 'На срезе должна остаться хотя бы одна опасность.')] };
    }
    const mi = mainIndexOf(this.draft, uid);
    if (mi >= 0 && isHazardType(type)) {
      const types = this.draft.main.map((u) => {
        if (u === uid) return type;
        const nd = this.draft.nodes.find((x) => x.uid === u);
        return nd ? nd.type : 'straight';
      });
      let run = 0;
      for (let i = 0; i < types.length * 2; i++) {
        run = isHazardType(types[i % types.length]) ? run + 1 : 0;
        if (run > 2) return { ok: false, issues: [issue('E_HAZARD_RUN', 'Нельзя ставить третью опасность подряд.')] };
      }
    }
    if (node.type === type) return { ok: true, issues: [], warnings: paintWarnings, noop: true, selectionUid: uid };
    const candidate = clone(this.draft);
    candidate.nodes.find((x) => x.uid === uid).type = type;
    return this.commit(candidate, { selectionUid: uid, warnings: paintWarnings });
  };

  TrackDraftSession.prototype.insertBetween = function (from, to) {
    const d = this.draft;
    if (!d.nodes.some((x) => x.uid === from) || !d.nodes.some((x) => x.uid === to)) {
      return { ok: false, issues: [issue('E_INSERT_EDGE', 'Между этими тайлами нет ребра.')] };
    }
    if (from === to) return { ok: false, issues: [issue('E_INSERT_EDGE', 'Между этими тайлами нет ребра.')] };
    const n = d.main.length;
    const mi = mainIndexOf(d, from);
    const mj = mainIndexOf(d, to);
    let kind = null;
    let insertAt = -1;
    if (mi >= 0 && mj >= 0 && (mi + 1) % n === mj) {
      kind = 'main';
      insertAt = mi + 1;
      if (n >= 36) return { ok: false, issues: [issue('E_LENGTH_MAX', 'Круг уже максимальной длины (36).')] };
    } else if (d.pit && d.pit.kind === 'branch') {
      const seq = [d.pit.entry].concat(d.pit.nodes, [d.pit.exit]);
      const k = seq.indexOf(from);
      if (k >= 0 && k < seq.length - 1 && seq[k + 1] === to) { kind = 'pit'; insertAt = k; }
    }
    if (!kind && d.shortcut) {
      const seq = [d.shortcut.entry].concat(d.shortcut.nodes, [d.shortcut.exit]);
      const k = seq.indexOf(from);
      if (k >= 0 && k < seq.length - 1 && seq[k + 1] === to) { kind = 'shortcut'; insertAt = k; }
    }
    if (!kind) return { ok: false, issues: [issue('E_INSERT_EDGE', 'Между этими тайлами нет ребра.')] };
    const featureLocks = (d.locks && d.locks.features) || {};
    if (kind === 'main' && insertAt >= n - 1 && featureLocks.grid) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Решётка заблокирована.')] };
    }
    if (kind === 'pit' && featureLocks.pit) return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Пит заблокирован.')] };
    if (kind === 'shortcut' && featureLocks.shortcut) return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Срез заблокирован.')] };
    if (kind === 'shortcut') {
      const a = mainIndexOf(d, d.shortcut.entry);
      const b = mainIndexOf(d, d.shortcut.exit);
      const branchLen = d.shortcut.nodes.length + 1;
      if ((b - a) - (branchLen + 1) < 1) {
        return { ok: false, issues: [issue('E_SHORTCUT_SAVING', 'Срез должен экономить 1–2 тайла.')] };
      }
    }
    const fnode = d.nodes.find((x) => x.uid === from);
    const tnode = d.nodes.find((x) => x.uid === to);
    const occupied = new Set(d.nodes.map((x) => x.q + ',' + x.r));
    const cell = freeCommonCell(fnode, tnode, occupied);
    if (!cell) return { ok: false, issues: [issue('E_INSERT_NO_CELL', 'Нет свободной соседней клетки для нового тайла.')] };
    const candidate = clone(d);
    const uid = this.nextUid();
    candidate.nodes.push({ uid, q: cell.q, r: cell.r, type: kind === 'pit' ? 'pit' : 'straight' });
    if (kind === 'main') {
      candidate.main.splice(insertAt, 0, uid);
      candidate.grid = derivedGrid(candidate.main);
    }
    else if (kind === 'pit') candidate.pit.nodes.splice(insertAt, 0, uid);
    else candidate.shortcut.nodes.splice(insertAt, 0, uid);
    return this.commit(candidate, { selectionUid: uid });
  };

  function freeCommonCell(fromNode, toNode, occupied) {
    if (!fromNode || !toNode) return null;
    const cells = axialNeighbors(fromNode.q, fromNode.r)
      .filter((c) => axialAdjacent(c, toNode))
      .filter((c) => !occupied.has(c.q + ',' + c.r))
      .filter((c) => !(c.q === fromNode.q && c.r === fromNode.r) && !(c.q === toNode.q && c.r === toNode.r));
    return cells[0] || null;
  }

  TrackDraftSession.prototype.remove = function (uid) {
    const d = this.draft;
    const node = d.nodes.find((x) => x.uid === uid);
    if (!node) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    const feature = new Set([d.startUid, d.checkpointUid, ...(d.grid || []),
      d.pit && d.pit.tile, d.pit && d.pit.entry, d.pit && d.pit.exit,
      d.shortcut && d.shortcut.entry, d.shortcut && d.shortcut.exit]);
    const featureName = featureOfUid(d, uid);
    if (featureName && featureLocked(d, featureName)) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    if (feature.has(uid)) return { ok: false, issues: [issue('E_REMOVE_FEATURE', 'Старт, КП, решётка и концы веток не удаляются — используйте инструмент.')] };
    const lock = d.locks && d.locks.nodes[uid];
    if (lock && lock.remove) return { ok: false, issues: [issue('E_LOCKED_REMOVE', 'Тайл защищён от удаления.')] };
    const candidate = clone(d);
    const inDecor = (candidate.decor || []).includes(uid);
    const mi = mainIndexOf(d, uid);
    if (inDecor) {
      candidate.nodes = candidate.nodes.filter((x) => x.uid !== uid);
      candidate.decor = candidate.decor.filter((x) => x !== uid);
      return this.commit(candidate, {});
    }
    if (mi >= 0) {
      if (d.main.length <= 24) return { ok: false, issues: [issue('E_LENGTH_MIN', 'Круг уже минимальной длины (24).')] };
      const prev = d.nodes.find((x) => x.uid === d.main[(mi - 1 + d.main.length) % d.main.length]);
      const next = d.nodes.find((x) => x.uid === d.main[(mi + 1) % d.main.length]);
      if (!axialAdjacent(prev, next)) {
        return { ok: false, issues: [issue('E_REMOVE_GEOMETRY', 'После удаления соседние тайлы не соприкасаются — сначала сдвиньте соседа.')] };
      }
      candidate.main.splice(mi, 1);
      candidate.grid = derivedGrid(candidate.main);
    } else {
      const chains = [];
      if (candidate.pit && candidate.pit.kind === 'branch') {
        chains.push({ list: candidate.pit.nodes, entry: candidate.pit.entry, exit: candidate.pit.exit });
      }
      if (candidate.shortcut) {
        chains.push({ list: candidate.shortcut.nodes, entry: candidate.shortcut.entry, exit: candidate.shortcut.exit });
      }
      let done = false;
      for (const ch of chains) {
        const idx = ch.list.indexOf(uid);
        if (idx < 0) continue;
        const prev = idx === 0 ? ch.entry : ch.list[idx - 1];
        const next = idx === ch.list.length - 1 ? ch.exit : ch.list[idx + 1];
        const pn = d.nodes.find((x) => x.uid === prev);
        const nn = d.nodes.find((x) => x.uid === next);
        if (!axialAdjacent(pn, nn)) {
          return { ok: false, issues: [issue('E_REMOVE_GEOMETRY', 'После удаления соседние тайлы не соприкасаются — сначала сдвиньте соседа.')] };
        }
        ch.list.splice(idx, 1);
        done = true;
        break;
      }
      if (!done) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    }
    candidate.nodes = candidate.nodes.filter((x) => x.uid !== uid);
    return this.commit(candidate, {});
  };

  TrackDraftSession.prototype.move = function (uid, q, r) {
    const d = this.draft;
    const node = d.nodes.find((x) => x.uid === uid);
    if (!node) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    const lock = d.locks && d.locks.nodes[uid];
    if (lock && lock.pos) return { ok: false, issues: [issue('E_LOCKED_POS', 'Позиция тайла закреплена.')] };
    const featureName = featureOfUid(d, uid);
    if (featureName && featureLocked(d, featureName)) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    if (!isInt(q) || !isInt(r)) return { ok: false, issues: [issue('E_COORD', 'Неверная координата клетки.')] };
    if (node.q === q && node.r === r) return { ok: true, issues: [], noop: true };
    const at = d.nodes.find((x) => x.uid !== uid && x.q === q && x.r === r);
    let displaced = null;
    if (at) {
      if ((d.decor || []).includes(at.uid)) displaced = at;
      else return { ok: false, issues: [issue('E_MOVE_OCCUPIED', 'Клетка уже занята тайлом.')] };
    }
    const target = { q, r };
    for (const neighborUid of connectedUids(d, uid)) {
      const neighbor = d.nodes.find((x) => x.uid === neighborUid);
      if (neighbor && !axialAdjacent(target, neighbor)) {
        return { ok: false, issues: [issue('E_MOVE_ADJACENCY', 'Тайл должен остаться соседним со всеми соседями по дороге.')] };
      }
    }
    const candidate = clone(d);
    const cnode = candidate.nodes.find((x) => x.uid === uid);
    if (displaced) {
      candidate.nodes = candidate.nodes.filter((x) => x.uid !== displaced.uid);
      candidate.decor = (candidate.decor || []).filter((x) => x !== displaced.uid);
    }
    cnode.q = q; cnode.r = r;
    return this.commit(candidate, {
      selectionUid: uid,
      warnings: displaced ? [issue('W_DECOR_CLEARED', 'Декор в клетке вытеснен дорогой.')] : [],
    });
  };

  function findFreeRoute(draft, entryUid, exitUid, accept, excludeUids) {
    const byUid = new Map((draft.nodes || []).map((n) => [n.uid, n]));
    const entry = byUid.get(entryUid);
    const exit = byUid.get(exitUid);
    if (!entry || !exit) return null;
    const excluded = excludeUids || new Set();
    const blocked = new Set(draft.nodes.filter((n) => !excluded.has(n.uid)).map((n) => n.q + ',' + n.r));
    const path = [];
    let found = null;
    let steps = 0;
    const dfs = (cell, visited) => {
      if (found) return;
      if (++steps > 50000) return;
      path.push(cell);
      if (axialAdjacent(cell, exit) && accept(path)) {
        found = path.map((c) => ({ q: c.q, r: c.r }));
        path.pop();
        return;
      }
      if (path.length >= (accept.maxDepth || 12)) { path.pop(); return; }
      for (const nb of axialNeighbors(cell.q, cell.r)) {
        if (found) break;
        const key = nb.q + ',' + nb.r;
        if (blocked.has(key) || visited.has(key)) continue;
        if (nb.q === exit.q && nb.r === exit.r) continue;
        visited.add(key);
        dfs(nb, visited);
        visited.delete(key);
      }
      path.pop();
    };
    for (const nb of axialNeighbors(entry.q, entry.r)) {
      const key = nb.q + ',' + nb.r;
      if (blocked.has(key)) continue;
      if (nb.q === exit.q && nb.r === exit.r) continue;
      dfs(nb, new Set([key]));
      if (found) break;
    }
    return found;
  }

  function branchEndpointUids(draft) {
    const s = new Set();
    if (draft.pit && draft.pit.kind === 'branch') { s.add(draft.pit.entry); s.add(draft.pit.exit); }
    if (draft.pit && draft.pit.kind === 'tile') s.add(draft.pit.tile);
    if (draft.shortcut) { s.add(draft.shortcut.entry); s.add(draft.shortcut.exit); }
    return s;
  }

  function featureOfUid(draft, uid) {
    if (uid === draft.startUid) return 'start';
    if (uid === draft.checkpointUid) return 'checkpoint';
    if ((draft.grid || []).includes(uid)) return 'grid';
    if (draft.pit) {
      if (draft.pit.kind === 'tile' && draft.pit.tile === uid) return 'pit';
      if (draft.pit.kind === 'branch' &&
        (uid === draft.pit.entry || uid === draft.pit.exit || draft.pit.nodes.includes(uid))) return 'pit';
    }
    if (draft.shortcut &&
      (uid === draft.shortcut.entry || uid === draft.shortcut.exit || draft.shortcut.nodes.includes(uid))) return 'shortcut';
    return null;
  }

  function featureLocked(draft, name) {
    return !!(draft.locks && draft.locks.features && draft.locks.features[name]);
  }

  function nodeLock(draft, uid, flag) {
    return !!(draft.locks && draft.locks.nodes && draft.locks.nodes[uid] && draft.locks.nodes[uid][flag]);
  }

  TrackDraftSession.prototype.setStart = function (uid) {
    const d = this.draft;
    const node = d.nodes.find((x) => x.uid === uid);
    if (!node) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    if (uid === d.startUid) return { ok: true, issues: [], noop: true };
    if (featureLocked(d, 'start') || featureLocked(d, 'grid')) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Старт или решётка заблокированы.')] };
    }
    const n = d.main.length;
    if (!d.main.includes(uid)) return { ok: false, issues: [issue('E_START_ROLE', 'Старт ставится только на основной круг.')] };
    if (uid === d.checkpointUid) return { ok: false, issues: [issue('E_START_CP', 'Старт не может стоять на КП.')] };
    if (branchEndpointUids(d).has(uid)) return { ok: false, issues: [issue('E_START_ROLE', 'Старт не может стоять на конце ветки/пите.')] };
    if (isHazardType(node.type) || node.type === 'ramp' || node.type === 'pit') {
      return { ok: false, issues: [issue('E_START_ZONE', 'Старт нельзя ставить на опасность/трамплин/пит.')] };
    }
    const locks = d.locks && d.locks.nodes;
    if ((locks[d.startUid] && locks[d.startUid].type) || (locks[uid] && locks[uid].type)) {
      return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
    }
    const idx = mainIndexOf(d, uid);
    const newMain = d.main.slice(idx).concat(d.main.slice(0, idx));
    const issues = [];
    const warnings = [];
    zoneBufferUids(newMain, uid, [], 3, 0).forEach((zid) => {
      const zn = d.nodes.find((x) => x.uid === zid);
      if (zn && (isHazardType(zn.type) || zn.type === 'ramp')) {
        issues.push(issue('E_START_ZONE', 'Стартовая зона не может содержать опасность/трамплин.'));
      }
    });
    const newCpIdx = newMain.indexOf(d.checkpointUid);
    if (newCpIdx >= 0) {
      for (let dd = -2; dd <= 2; dd++) {
        const zid = newMain[(newCpIdx + dd + newMain.length) % newMain.length];
        const zn = d.nodes.find((x) => x.uid === zid);
        if (zn && (isHazardType(zn.type) || zn.type === 'ramp')) {
          warnings.push(issue('W_CP_BUFFER', 'Опасность/трамплин в буфере КП ±2 (предупреждение, генератор это допускает).', zid));
        }
      }
    }
    const cp = newMain.indexOf(d.checkpointUid);
    if (cp / n < 0.25 || cp / n > 0.65) {
      issues.push(issue('E_START_CP_RANGE', 'КП выйдет за пределы 25..65% круга.'));
    }
    const indexOf = (u) => newMain.indexOf(u);
    if (d.shortcut && indexOf(d.shortcut.entry) >= indexOf(d.shortcut.exit)) {
      issues.push(issue('E_SHORTCUT_WRAP', 'Срез замкнётся через старт/финиш.'));
    }
    if (d.pit && d.pit.kind === 'branch' && indexOf(d.pit.entry) >= indexOf(d.pit.exit)) {
      issues.push(issue('E_PIT_WRAP', 'Пит-ветка замкнётся через старт/финиш.'));
    }
    const newGrid = [newMain[n - 1], newMain[n - 1], newMain[n - 2], newMain[n - 2]];
    const entries = new Set();
    if (d.pit && d.pit.kind === 'branch') entries.add(d.pit.entry);
    if (d.shortcut) entries.add(d.shortcut.entry);
    for (const g of new Set(newGrid)) {
      const gridNode = d.nodes.find((x) => x.uid === g);
      if (gridNode && (isHazardType(gridNode.type) || gridNode.type === 'ramp')) {
        issues.push(issue('E_START_ZONE', 'Стартовая зона не может содержать опасность/трамплин.'));
      }
      if (entries.has(g) || (gridNode && gridNode.type === 'fork')) {
        issues.push(issue('E_GRID_ENTRY', 'Решётка попадёт на вход/развилку ветки.'));
      } else if (!gridNode || !NORMAL_GRID_TYPES.includes(gridNode.type) ||
        g === d.checkpointUid || isHazardType(gridNode.type) || gridNode.type === 'ramp' ||
        (d.pit && d.pit.kind === 'tile' && d.pit.tile === g)) {
        issues.push(issue('E_GRID', 'Решётка должна стоять на чистых прямых/поворотах.'));
      }
    }
    if (hasError(issues)) return { ok: false, issues };
    const candidate = clone(d);
    candidate.main = newMain;
    candidate.startUid = uid;
    candidate.grid = newGrid;
    candidate.nodes.find((x) => x.uid === d.startUid).type = 'straight';
    candidate.nodes.find((x) => x.uid === uid).type = 'start';
    return this.commit(candidate, { selectionUid: uid, warnings });
  };

  TrackDraftSession.prototype.setCheckpoint = function (uid) {
    const d = this.draft;
    const node = d.nodes.find((x) => x.uid === uid);
    if (!node) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    if (uid === d.checkpointUid) return { ok: true, issues: [], noop: true };
    if (featureLocked(d, 'checkpoint')) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'КП заблокирован.')] };
    }
    if (!d.main.includes(uid) || uid === d.startUid) {
      return { ok: false, issues: [issue('E_CHECKPOINT_ROLE', 'КП ставится на основной круг, не на старт.')] };
    }
    if ((d.grid || []).includes(uid)) return { ok: false, issues: [issue('E_CHECKPOINT_GRID', 'КП не может стоять на решётке.')] };
    if (branchEndpointUids(d).has(uid)) return { ok: false, issues: [issue('E_CHECKPOINT_ROLE', 'КП не может стоять на конце ветки/пите.')] };
    if (isHazardType(node.type) || node.type === 'ramp') {
      return { ok: false, issues: [issue('E_CHECKPOINT_ZONE', 'КП нельзя ставить на опасность/трамплин.')] };
    }
    const n = d.main.length;
    const idx = mainIndexOf(d, uid);
    if (idx / n < 0.25 || idx / n > 0.65) {
      return { ok: false, issues: [issue('E_CHECKPOINT_RANGE', 'КП должен быть в пределах 25..65% круга.')] };
    }
    const locks = d.locks && d.locks.nodes;
    if ((locks[d.checkpointUid] && locks[d.checkpointUid].type) || (locks[uid] && locks[uid].type)) {
      return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
    }
    const candidate = clone(d);
    candidate.nodes.find((x) => x.uid === d.checkpointUid).type = 'straight';
    candidate.nodes.find((x) => x.uid === uid).type = 'checkpoint';
    candidate.checkpointUid = uid;
    return this.commit(candidate, { selectionUid: uid });
  };

  TrackDraftSession.prototype.setPitTile = function (uid, opts) {
    opts = opts || {};
    const d = this.draft;
    if (d.locks && d.locks.features && d.locks.features.pit) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    const node = d.nodes.find((x) => x.uid === uid);
    if (!node) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    if (!d.main.includes(uid) || uid === d.startUid || uid === d.checkpointUid || (d.grid || []).includes(uid) ||
      branchEndpointUids(d).has(uid)) {
      return { ok: false, issues: [issue('E_PIT_ROLE', 'Пит-тайл ставится только на свободный тайл круга.')] };
    }
    const hasPit = !!d.pit;
    if (hasPit && d.pit.kind === 'tile' && d.pit.tile === uid) return { ok: true, issues: [], noop: true };
    if (hasPit && !opts.force) return { ok: false, requiresConfirm: true, issues: [] };
    if ((hasPit && d.pit.kind === 'tile' && nodeLock(d, d.pit.tile, 'type')) || nodeLock(d, uid, 'type')) {
      return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
    }
    if (hasPit && d.pit.kind === 'branch') {
      for (const oldUid of d.pit.nodes) {
        if (nodeLock(d, oldUid, 'type')) return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
        if (nodeLock(d, oldUid, 'remove')) return { ok: false, issues: [issue('E_LOCKED_REMOVE', 'Тайл защищён от удаления.')] };
      }
    }
    const candidate = clone(d);
    const oldBranch = d.pit && d.pit.kind === 'branch' ? d.pit.nodes : [];
    if (oldBranch.length) candidate.nodes = candidate.nodes.filter((x) => !oldBranch.includes(x.uid));
    if (d.pit && d.pit.kind === 'tile') {
      const old = candidate.nodes.find((x) => x.uid === d.pit.tile);
      if (old) old.type = 'straight';
    }
    candidate.nodes.find((x) => x.uid === uid).type = 'pit';
    candidate.pit = { kind: 'tile', tile: uid };
    return this.commit(candidate, { selectionUid: uid });
  };

  TrackDraftSession.prototype.clearPit = function () {
    const d = this.draft;
    if (d.locks && d.locks.features && d.locks.features.pit) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    if (!d.pit) return { ok: true, issues: [], noop: true };
    if (d.pit.kind === 'tile' && nodeLock(d, d.pit.tile, 'type')) {
      return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
    }
    if (d.pit.kind === 'branch') {
      for (const uid of d.pit.nodes) {
        if (nodeLock(d, uid, 'type')) return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
        if (nodeLock(d, uid, 'remove')) return { ok: false, issues: [issue('E_LOCKED_REMOVE', 'Тайл защищён от удаления.')] };
      }
    }
    const candidate = clone(d);
    if (d.pit.kind === 'branch') {
      candidate.nodes = candidate.nodes.filter((x) => !d.pit.nodes.includes(x.uid));
    } else {
      const old = candidate.nodes.find((x) => x.uid === d.pit.tile);
      if (old) old.type = 'straight';
    }
    candidate.pit = null;
    return this.commit(candidate, {});
  };

  TrackDraftSession.prototype.setPitBranch = function (entry, exit, opts) {
    opts = opts || {};
    const d = this.draft;
    if (d.locks && d.locks.features && d.locks.features.pit) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    if (d.shortcut) return { ok: false, issues: [issue('E_BRANCH_CONFLICT', 'Пит-ветка и срез не могут существовать одновременно.')] };
    const entryNode = d.nodes.find((x) => x.uid === entry);
    const exitNode = d.nodes.find((x) => x.uid === exit);
    if (!entryNode || !exitNode) return { ok: false, issues: [issue('E_PIT_ROLE', 'Тайл не найден.')] };
    if (!d.main.includes(entry) || !d.main.includes(exit)) {
      return { ok: false, issues: [issue('E_PIT_ROLE', 'Концы пита должны быть на основном круге.')] };
    }
    if (entry === exit) return { ok: false, issues: [issue('E_PIT_ROLE', 'Вход и выход пита должны различаться.')] };
    if (entry === d.startUid || exit === d.startUid || entry === d.checkpointUid || exit === d.checkpointUid) {
      return { ok: false, issues: [issue('E_PIT_ROLE', 'Пит не может стоять на старте или КП.')] };
    }
    if ((d.grid || []).includes(entry)) return { ok: false, issues: [issue('E_GRID_ENTRY', 'Вход пита не может стоять на решётке.')] };
    if ((d.grid || []).includes(exit) && !(exit === d.main[d.main.length - 1] || exit === d.main[d.main.length - 2])) {
      return { ok: false, issues: [issue('E_GRID_ENTRY', 'Выход пита на решётке разрешён только на main[n-1]/main[n-2].')] };
    }
    const n = d.main.length;
    const a = mainIndexOf(d, entry);
    const b = mainIndexOf(d, exit);
    if (a >= b) return { ok: false, issues: [issue('E_PIT_WRAP', 'Пит-ветка замыкается через старт/финиш.')] };
    const dist = b - a;
    if (dist < 2 || dist > 5) return { ok: false, issues: [issue('E_PIT_DISTANCE', 'Вход/выход пита слишком далеко (2..5).')] };
    const cpIdx = mainIndexOf(d, d.checkpointUid);
    if (cpIdx > a && cpIdx < b) return { ok: false, issues: [issue('E_PIT_CP_BYPASS', 'Пит обходит контрольный пункт.')] };
    const hasPit = !!d.pit;
    if (hasPit && !opts.force) return { ok: false, requiresConfirm: true, issues: [] };
    if (d.pit && d.pit.kind === 'tile' && nodeLock(d, d.pit.tile, 'type')) {
      return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
    }
    if (d.pit && d.pit.kind === 'branch') {
      for (const oldUid of d.pit.nodes) {
        if (nodeLock(d, oldUid, 'type')) return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
        if (nodeLock(d, oldUid, 'remove')) return { ok: false, issues: [issue('E_LOCKED_REMOVE', 'Тайл защищён от удаления.')] };
      }
    }
    const oldBranch = d.pit && d.pit.kind === 'branch' ? new Set(d.pit.nodes) : new Set();
    const route = findFreeRoute(d, entry, exit, (cells) => cells.length >= 2 && cells.length + 1 > dist, oldBranch);
    if (!route) return { ok: false, issues: [issue('E_PIT_NO_PATH', 'Не удалось проложить пит-ветку по свободным клеткам.')] };
    const candidate = clone(d);
    if (oldBranch.size) candidate.nodes = candidate.nodes.filter((x) => !oldBranch.has(x.uid));
    if (d.pit && d.pit.kind === 'tile') {
      const old = candidate.nodes.find((x) => x.uid === d.pit.tile);
      if (old) old.type = 'straight';
    }
    const uids = [];
    route.forEach((cell) => {
      const uid = this.nextUid();
      uids.push(uid);
      candidate.nodes.push({ uid, q: cell.q, r: cell.r, type: 'pit' });
    });
    candidate.pit = { kind: 'branch', entry, exit, nodes: uids };
    return this.commit(candidate, { selectionUid: uids[0] });
  };

  TrackDraftSession.prototype.clearShortcut = function () {
    const d = this.draft;
    if (d.locks && d.locks.features && d.locks.features.shortcut) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    if (!d.shortcut) return { ok: true, issues: [], noop: true };
    for (const uid of d.shortcut.nodes) {
      if (nodeLock(d, uid, 'type')) return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
      if (nodeLock(d, uid, 'remove')) return { ok: false, issues: [issue('E_LOCKED_REMOVE', 'Тайл защищён от удаления.')] };
    }
    const candidate = clone(d);
    candidate.nodes = candidate.nodes.filter((x) => !d.shortcut.nodes.includes(x.uid));
    candidate.shortcut = null;
    return this.commit(candidate, {});
  };

  TrackDraftSession.prototype.setShortcut = function (entry, exit, opts) {
    opts = opts || {};
    const d = this.draft;
    if (d.locks && d.locks.features && d.locks.features.shortcut) {
      return { ok: false, issues: [issue('E_LOCKED_FEATURE', 'Объект заблокирован.')] };
    }
    if (d.pit && d.pit.kind === 'branch') {
      return { ok: false, issues: [issue('E_BRANCH_CONFLICT', 'Пит-ветка и срез не могут существовать одновременно.')] };
    }
    const entryNode = d.nodes.find((x) => x.uid === entry);
    const exitNode = d.nodes.find((x) => x.uid === exit);
    if (!entryNode || !exitNode) return { ok: false, issues: [issue('E_SHORTCUT_CONFLICT', 'Тайл не найден.')] };
    if (!d.main.includes(entry) || !d.main.includes(exit) || entry === exit) {
      return { ok: false, issues: [issue('E_SHORTCUT_CONFLICT', 'Концы среза должны быть разными тайлами круга.')] };
    }
    if (entry === d.startUid || exit === d.startUid || entry === d.checkpointUid || exit === d.checkpointUid ||
      (d.grid || []).includes(entry) || (d.grid || []).includes(exit)) {
      return { ok: false, issues: [issue('E_SHORTCUT_CONFLICT', 'Срез не может начинаться/заканчиваться на старте, КП или решётке.')] };
    }
    const n = d.main.length;
    const a = mainIndexOf(d, entry);
    const b = mainIndexOf(d, exit);
    if (a >= b) return { ok: false, issues: [issue('E_SHORTCUT_WRAP', 'Срез замыкается через старт/финиш.')] };
    if (a <= 3 || b >= n - 3) return { ok: false, issues: [issue('E_SHORTCUT_NEAR_START', 'Срез слишком близко к старту/финишу.')] };
    const dist = b - a;
    const allowed = [dist - 2, dist - 3].filter((x) => x >= 1);
    if (!allowed.length) return { ok: false, issues: [issue('E_SHORTCUT_SAVING', 'Срез должен экономить 1–2 тайла.')] };
    const maxLen = Math.max.apply(null, allowed);
    const hasShortcut = !!d.shortcut;
    if (hasShortcut && !opts.force) return { ok: false, requiresConfirm: true, issues: [] };
    if (d.shortcut) {
      for (const oldUid of d.shortcut.nodes) {
        if (nodeLock(d, oldUid, 'type')) return { ok: false, issues: [issue('E_LOCKED_TYPE', 'Тип тайла заблокирован.')] };
        if (nodeLock(d, oldUid, 'remove')) return { ok: false, issues: [issue('E_LOCKED_REMOVE', 'Тайл защищён от удаления.')] };
      }
    }
    const oldBranch = d.shortcut ? new Set(d.shortcut.nodes) : new Set();
    const route = findFreeRoute(d, entry, exit, (cells) => allowed.includes(cells.length), oldBranch);
    if (!route) return { ok: false, issues: [issue('E_SHORTCUT_NO_PATH', 'Не удалось проложить срез по свободным клеткам.')] };
    const candidate = clone(d);
    if (oldBranch.size) candidate.nodes = candidate.nodes.filter((x) => !oldBranch.has(x.uid));
    const uids = [];
    route.forEach((cell, i) => {
      const uid = this.nextUid();
      uids.push(uid);
      candidate.nodes.push({ uid, q: cell.q, r: cell.r, type: i === route.length - 1 ? 'debris' : 'straight' });
    });
    candidate.shortcut = { entry, exit, nodes: uids, type: 'debris' };
    const warnings = [];
    const cpIdx = mainIndexOf(d, d.checkpointUid);
    if (cpIdx > a && cpIdx < b) warnings.push(issue('W_SHORTCUT_CP_BYPASS', 'КП пропущен; движок не требует КП для финиша'));
    return this.commit(candidate, { selectionUid: uids[0], warnings });
  };

  TrackDraftSession.prototype.setLock = function (uid, flags) {
    const d = this.draft;
    if (!d.nodes.some((x) => x.uid === uid)) return { ok: false, issues: [issue('E_NO_NODE', 'Тайл не найден.')] };
    const candidate = clone(d);
    candidate.locks = candidate.locks || { nodes: {}, features: {} };
    candidate.locks.nodes[uid] = Object.assign({}, candidate.locks.nodes[uid], flags || {});
    return this.commit(candidate, {});
  };

  TrackDraftSession.prototype.setFeatureLock = function (feature, locked) {
    const candidate = clone(this.draft);
    candidate.locks = candidate.locks || { nodes: {}, features: {} };
    candidate.locks.features = candidate.locks.features || {};
    candidate.locks.features[feature] = !!locked;
    return this.commit(candidate, {});
  };

  TrackDraftSession.prototype.toSpec = function () { return toSpec(this.draft); };

  TrackDraftSession.prototype.report = function () {
    if (this.readOnly) {
      return { ok: true, readOnly: true, issues: [], warnings: this.warnings || [], dirty: false };
    }
    const check = validateDraft(this.draft);
    let stats = null;
    if (check.ok) stats = statsFor(toSpec(this.draft));
    return {
      ok: check.ok,
      readOnly: false,
      issues: check.issues.filter((i) => String(i.code).startsWith('E_')),
      warnings: check.warnings || [],
      stats,
      dirty: this.dirty,
      unsavedNew: this.unsavedNew,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    };
  };

  /* --- B4: hazard budget DP ------------------------------------------ */

  function maxHazardsCycle(n, allowedAt, maxRun) {
    if (!n) return 0;
    let best = 0;
    for (let endRun = 0; endRun <= maxRun; endRun++) {
      let valid = true;
      for (let k = 1; k <= endRun; k++) {
        if (!allowedAt((n - k + n) % n)) { valid = false; break; }
      }
      if (!valid) continue;
      let dp = new Array(maxRun + 1).fill(-1);
      dp[endRun] = 0;
      for (let i = 0; i < n; i++) {
        const ndp = new Array(maxRun + 1).fill(-1);
        for (let run = 0; run <= maxRun; run++) {
          if (dp[run] < 0) continue;
          if (dp[run] > ndp[0]) ndp[0] = dp[run];
          if (allowedAt(i) && run < maxRun && dp[run] + 1 > ndp[run + 1]) ndp[run + 1] = dp[run] + 1;
        }
        dp = ndp;
      }
      if (dp[endRun] > best) best = dp[endRun];
    }
    return best;
  }

  function maxPaintHazards(n, protectedIds) {
    const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || []);
    return Math.min(MAX_HAZARDS, maxHazardsCycle(n, (i) => !protectedSet.has(i), 2));
  }

  function maxGeneratedHazards(spec) {
    if (!spec || !Array.isArray(spec.main)) return 0;
    const main = spec.main;
    const byId = new Map((spec.nodes || []).map((n) => [n.id, n]));
    const protectedIds = new Set([spec.startNode, ...(spec.grid || []), ...(spec.checkpoints || [])]);
    (spec.pit && spec.pit.nodes || []).forEach((id) => protectedIds.add(id));
    (spec.shortcut && spec.shortcut.nodes || []).forEach((id) => protectedIds.add(id));
    (spec.pit && spec.pit.entry != null ? [spec.pit.entry, spec.pit.exit] : []).forEach((id) => protectedIds.add(id));
    (spec.shortcut ? [spec.shortcut.entry, spec.shortcut.exit] : []).forEach((id) => protectedIds.add(id));
    if (spec.pit && spec.pit.tile != null) protectedIds.add(spec.pit.tile);
    const protectAround = (id, radius) => {
      const idx = main.indexOf(id);
      if (idx < 0) return;
      for (let d = -radius; d <= radius; d++) protectedIds.add(main[(idx + d + main.length) % main.length]);
    };
    protectAround(spec.startNode, 3);
    (spec.checkpoints || []).forEach((id) => protectAround(id, 2));
    return Math.min(MAX_HAZARDS, maxHazardsCycle(main.length, (i) => {
      const node = byId.get(main[i]);
      if (!node || protectedIds.has(main[i])) return false;
      return node.type === 'straight' || node.type === 'turn' || isHazardType(node.type);
    }, 1));
  }

  function hazardBudgetReport(spec, requestedMin, requestedMax) {
    const min = Math.max(0, Math.min(MAX_HAZARDS, Math.floor(Number(requestedMin) || 0)));
    const max = Math.min(MAX_HAZARDS, Math.max(min, Math.floor(Number(requestedMax) || min)));
    const stats = statsFor(spec);
    const actual = stats ? stats.hazards : 0;
    const achievable = Math.min(MAX_HAZARDS, Math.max(actual, maxGeneratedHazards(spec)));
    return {
      requestedMin: min,
      requestedMax: Math.min(MAX_HAZARDS, max),
      actual,
      achievable,
      sliderMax: achievable,
      maxHazards: MAX_HAZARDS,
      ok: actual >= min,
    };
  }

  TrackDraftSession.prototype.reset = function (opts) {
    opts = opts || {};
    if (this.readOnly) return { ok: false, issues: [issue('E_READONLY', 'Трасса только для чтения.')] };
    if (!opts.force) return { ok: false, requiresConfirm: true, issues: [] };
    const src = this.draft && this.draft.source;
    if (!src || !src.sourceSpec) return { ok: false, issues: [issue('E_RESET', 'Нет исходной трассы для сброса.')] };
    const fresh = draftFromCanonical(src.sourceSpec, {
      kind: src.kind,
      trackId: src.trackId,
      migrated: (src.migrated || []).length > 0,
      originalSpec: src.originalSpec,
    });
    this.draft = fresh;
    this.uidSeq = fresh.nodes.length;
    this.selectionUid = null;
    this.focusUid = null;
    this.past = [];
    this.future = [];
    this.revision += 1;
    return { ok: true, issues: [] };
  };

  TrackDraftSession.prototype.markSaved = function (trackId) {
    if (!this.draft) return;
    this.draft.source.trackId = trackId || this.draft.source.trackId;
    this.draft.source.kind = 'saved';
    this.unsavedNew = false;
    this.baselineFingerprint = JSON.stringify(toSpec(this.draft));
  };

  function createSession(spec, opts) {
    const res = fromSpec(spec, opts);
    if (!res.ok) return res;
    if (!res.draft && res.readOnly) {
      return { ok: true, readOnly: true, reason: res.reason, issues: [], session: null };
    }
    return {
      ok: true,
      readOnly: !!res.readOnly,
      reason: res.reason || null,
      warnings: res.warnings || [],
      session: new TrackDraftSession(res, opts),
    };
  }

  CnA.TrackEditor = {
    ARCHETYPES: CnA.TRACK_ARCHETYPES,
    STORE_KEY,
    MAX_TRACKS,
    HAZARD_TYPES,
    normalizeOptions,
    generate,
    report,
    previewSvg,
    envelope,
    createStore,
    cleanName,
    customId,
  };

  CnA.TrackDraft = {
    DRAFT_VERSION: 1,
    HISTORY_LIMIT,
    AXIAL_DIRS,
    LEGACY_HORSESHOE_MAIN,
    PAINT_TYPES,
    SHORTCUT_TYPES,
    MAIN_TYPES,
    MAX_HAZARDS,
    FEATURE_NAMES,
    canonicalizeRepresentation,
    migrateKnownHorseshoe,
    validateStructural,
    validateDraft,
    prepareSpec,
    fromSpec,
    toSpec,
    draftFromCanonical,
    detectReadOnly,
    createSession,
    TrackDraftSession,
    maxPaintHazards,
    maxGeneratedHazards,
    hazardBudgetReport,
    axialAdjacent,
    axialNeighbors,
    hexXY,
    isInt,
    isHazardType,
    hasError,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
