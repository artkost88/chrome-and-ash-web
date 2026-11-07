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
    let hazardMin = clampInt(input.hazardMin, 0, 6, defaults[0]);
    let hazardMax = clampInt(input.hazardMax, 0, 6, defaults[1]);
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
    return { spec, ok: r.ok, issues: r.issues, stats: r.stats, options: o };
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
    const r = report(spec);
    if (!r.ok) return { ok: false, issues: r.issues };
    return {
      ok: true,
      track: {
        schemaVersion: 1,
        id: String(raw.id || fallbackId || customId()).slice(0, 80),
        name: cleanName(raw.name || spec.name),
        createdAt: raw.createdAt || nowIso(),
        updatedAt: raw.updatedAt || nowIso(),
        spec: clone(spec),
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
  const NORMAL_GRID_TYPES = ['straight', 'turn'];
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
    out.decor = decorIds.map(remap);
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
    (input.decor || []).forEach((d) => { if (typeof d !== 'object') ref(d, 'decor ссылается на несуществующий тайл'); });
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
    const shortcut = input.shortcut || null;
    const pitNodes = pitBranch ? input.pit.nodes : [];
    const shortcutNodes = shortcut ? (shortcut.nodes || []) : [];
    const decorIds = (input.decor || []).filter((d) => typeof d !== 'object');
    const roadIds = new Set(main);
    pitNodes.forEach((id) => roadIds.add(id));
    shortcutNodes.forEach((id) => roadIds.add(id));

    if (input.size != null && input.size !== main.length) add('E_SIZE', 'size не совпадает с длиной main');
    if (main.length < 24 || main.length > 36) add('E_LENGTH', 'длина круга вне 24..36');

    main.forEach((id) => {
      const n = byId.get(id);
      if (n && !MAIN_TYPES.includes(n.type)) add('E_TYPE', 'недопустимый тип тайла: ' + n.type, id);
    });

    const starts = nodes.filter((n) => n.type === 'start');
    if (starts.length !== 1) add('E_START_COUNT', 'стартовых тайлов: ' + starts.length);
    if (!mainSet.has(input.startNode)) add('E_START_INDEX', 'startNode не на main');
    else if (main[0] !== input.startNode) add('E_START_INDEX', 'startNode должен быть main[0]');

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
    let run = 0;
    for (let i = 0; i < main.length * 2; i++) {
      const node = byId.get(main[i % main.length]);
      run = node && isHazardType(node.type) ? run + 1 : 0;
      if (run > 2) { add('E_HAZARD_RUN', 'больше двух опасных подряд', node && node.id); break; }
    }
    main.forEach((id) => {
      const node = byId.get(id);
      if (!node) return;
      if (isHazardType(node.type) && protectedIds.has(id)) add('E_HAZARD_ZONE', 'опасность на старте/решётке/КП', id);
      if (node.type === 'ramp' && protectedIds.has(id)) add('E_RAMP_ZONE', 'трамплин на старте/решётке/КП', id);
    });

    const cps = (input.checkpoints || []).filter((id) => id !== input.startNode);
    if (cps.length !== 1) add('E_CHECKPOINT', 'должен быть ровно один не-стартовый КП');
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

    return { ok: !hasError(issues), issues };
  }

  /* --- B1: read-only detection / validate-first pipeline ------------- */

  function detectReadOnly(canonical) {
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

    if (Array.isArray(spec.decor) && spec.decor.some((d) => typeof d === 'object')) {
      return { ok: true, readOnly: true, reason: 'decor', issues: [], warnings: [], originalSpec: clone(spec), canonical: null };
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
    if (!structural.ok) {
      return { ok: false, readOnly: false, issues: structural.issues, warnings };
    }
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
      source: {
        kind: opts.kind || 'generated',
        trackId: opts.trackId || null,
        archetype: spec.archetype,
        seed: spec.seed,
        specId: spec.id,
        label: Object.prototype.hasOwnProperty.call(spec, 'label') ? spec.label : undefined,
        sourceSpec: clone(spec),
        originalSpec: opts.originalSpec ? clone(opts.originalSpec) : clone(spec),
        migrated: opts.migrated ? ['horseshoe-bump-v1'] : [],
      },
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
    MAIN_TYPES,
    FEATURE_NAMES,
    canonicalizeRepresentation,
    migrateKnownHorseshoe,
    validateStructural,
    prepareSpec,
    fromSpec,
    toSpec,
    draftFromCanonical,
    detectReadOnly,
    axialAdjacent,
    axialNeighbors,
    hexXY,
    isInt,
    isHazardType,
    hasError,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
