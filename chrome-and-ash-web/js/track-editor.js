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
      return { ok: false, issues: [{ code: 'E_SCHEMA', message: 'нет TrackSpec schemaVersion 1' }], stats: null };
    }
    try {
      const check = CnA.validateTrackSpec(spec);
      const issues = (check && check.issues) || [];
      return { ok: !!check.ok, issues, stats: statsFor(spec) };
    } catch (e) {
      return { ok: false, issues: [{ code: 'E_COMPILE', message: String(e && e.message || e) }], stats: null };
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
      return '<g data-node="' + n.id + '" data-type="' + esc(n.type) + '" data-start="' + (isStart ? '1' : '0') + '" class="pv-node' + (inner ? ' inner' : '') + '">' +
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
})(typeof globalThis !== 'undefined' ? globalThis : window);
