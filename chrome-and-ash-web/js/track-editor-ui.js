/* ХРОМ И ПЕПЕЛ — DOM-контроллер конструктора трасс. */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});
  const E = CnA.TrackEditor;
  if (!E) return;

  let store = null;
  let current = null;
  let editingId = null;
  let dirty = false;
  let bound = false;
  let initialized = false;

  function $(id) { return document.getElementById(id); }
  function val(id) { const el = $(id); return el ? el.value : ''; }
  function num(id, fallback) { const n = Number(val(id)); return Number.isFinite(n) ? n : fallback; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function toast(text, kind) { if (CnA.UI && CnA.UI.showToast) CnA.UI.showToast(text, kind || 'event', 2200); }
  function hazardCount(spec) {
    const byId = new Map((spec.nodes || []).map((n) => [n.id, n]));
    return (spec.main || []).filter((id) => {
      const n = byId.get(id);
      return n && CnA.HAZARD_TILES.includes(n.type);
    }).length;
  }
  function setDirty(v) { dirty = !!v; }

  function ensureStore() {
    if (store) return;
    try { store = E.createStore(window.localStorage); }
    catch (e) { store = E.createStore(null); }
  }

  function fillArchetypes() {
    const sel = $('constructor-archetype');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(E.ARCHETYPES).forEach((id) => {
      const a = E.ARCHETYPES[id];
      const o = document.createElement('option');
      o.value = id;
      o.textContent = a.name + ' · ' + a.defaultSize + ' тайлов';
      sel.appendChild(o);
    });
  }

  function optionsFromControls() {
    return {
      name: val('constructor-name') || 'Моя трасса',
      archetype: val('constructor-archetype') || 'horseshoe',
      seed: num('constructor-seed', 1),
      hazardMin: num('constructor-hazard-min', 2),
      hazardMax: num('constructor-hazard-max', 4),
    };
  }

  function setBudget(o) {
    const min = $('constructor-hazard-min');
    const max = $('constructor-hazard-max');
    if (!min || !max) return;
    min.value = String(Math.max(0, Math.min(6, o.hazardMin)));
    max.value = String(Math.max(0, Math.min(6, o.hazardMax)));
    if (Number(min.value) > Number(max.value)) max.value = min.value;
    updateBudgetLabels();
  }

  function updateBudgetLabels() {
    const min = $('constructor-hazard-min'), max = $('constructor-hazard-max');
    const minV = $('constructor-hazard-min-val'), maxV = $('constructor-hazard-max-val');
    if (minV) minV.textContent = min ? min.value : '0';
    if (maxV) maxV.textContent = max ? max.value : '0';
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  function renderStats(spec, stats) {
    const box = $('constructor-stats');
    if (!box) return;
    box.innerHTML = '';
    const items = [
      ['ТАЙЛОВ', stats ? stats.length : '—'],
      ['ОПАСНОСТЕЙ', stats ? stats.hazards : '—'],
      ['КП', stats && stats.checkpointId != null ? '#' + stats.checkpointId : '—'],
      ['ПИТ', stats && stats.hasPit ? 'ДА' : 'НЕТ'],
      ['СРЕЗ', stats && stats.hasShortcut ? 'ДА' : 'НЕТ'],
    ];
    items.forEach(([label, value]) => {
      const d = document.createElement('div');
      d.className = 'constructor-stat';
      d.textContent = label;
      const b = document.createElement('b');
      b.textContent = String(value);
      d.appendChild(b);
      box.appendChild(d);
    });
  }

  function renderIssues(issues) {
    const box = $('constructor-issues');
    if (!box) return;
    box.innerHTML = '';
    if (!issues || !issues.length) {
      const ok = document.createElement('div');
      ok.className = 'constructor-ok';
      ok.textContent = 'Трасса валидна';
      box.appendChild(ok);
      return;
    }
    issues.forEach((issue) => {
      const d = document.createElement('div');
      d.className = 'constructor-issue';
      d.textContent = issue.code + ': ' + (issue.message || 'ошибка');
      box.appendChild(d);
    });
  }

  function renderSaved() {
    const box = $('constructor-saved');
    if (!box) return;
    box.innerHTML = '';
    ensureStore();
    const list = store.list();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'saved-empty';
      empty.textContent = 'Пока нет сохранённых трасс.';
      box.appendChild(empty);
      return;
    }
    list.forEach((env) => {
      const row = document.createElement('div');
      row.className = 'saved-track';
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'st-load';
      load.textContent = env.name + ' · ' + (env.spec && env.spec.size ? env.spec.size + ' т.' : '');
      load.title = 'Загрузить';
      load.addEventListener('click', () => loadEnvelope(env));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'st-del';
      del.textContent = '×';
      del.title = 'Удалить';
      del.addEventListener('click', () => {
        if (!window.confirm('Удалить «' + env.name + '»?')) return;
        const r = store.remove(env.id);
        if (!r.ok) { renderIssues(r.issues); return; }
        if (editingId === env.id) editingId = null;
        renderSaved();
      });
      row.appendChild(load);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function render() {
    const preview = $('constructor-preview');
    if (!preview) return;
    if (!current) {
      preview.innerHTML = E.previewSvg(null);
      renderStats(null, null);
      renderIssues([]);
      setDisabled('constructor-save', true);
      setDisabled('constructor-test', true);
      return;
    }
    preview.innerHTML = E.previewSvg(current.spec);
    renderStats(current.spec, current.stats);
    renderIssues(current.issues);
    setDisabled('constructor-save', !current.ok);
    setDisabled('constructor-test', !current.ok);
    setDisabled('constructor-export', !current.spec);
  }

  function readSpecMeta(spec) {
    return {
      archetype: spec.archetype || 'horseshoe',
      seed: spec.seed,
      hazardMin: hazardCount(spec),
      hazardMax: hazardCount(spec),
    };
  }

  function loadEnvelope(env) {
    if (!env || !env.spec) return;
    const r = E.report(env.spec);
    current = { spec: clone(env.spec), ok: r.ok, issues: r.issues, stats: r.stats };
    editingId = env.id || null;
    const name = $('constructor-name'); if (name) name.value = env.name || env.spec.name || 'Моя трасса';
    const arch = $('constructor-archetype'); if (arch) arch.value = readSpecMeta(env.spec).archetype;
    const seed = $('constructor-seed'); if (seed) seed.value = String(env.spec.seed == null ? 1 : env.spec.seed);
    setBudget(readSpecMeta(env.spec));
    setDirty(false);
    render();
  }

  function generate() {
    const o = optionsFromControls();
    const r = E.generate(o);
    current = { spec: r.spec, ok: r.ok, issues: r.issues, stats: r.stats };
    if (r.spec) {
      current.spec.name = o.name;
      current.spec.label = o.name;
      if (!editingId || !store || !store.get(editingId)) editingId = null;
    }
    const seed = $('constructor-seed');
    if (seed && r.spec) seed.value = String(r.spec.seed == null ? o.seed : r.spec.seed);
    setDirty(true);
    render();
  }

  function save() {
    if (!current || !current.ok) return;
    ensureStore();
    const env = E.envelope(current.spec, val('constructor-name'), editingId || undefined);
    const r = store.save(env);
    if (!r.ok) { renderIssues(r.issues); toast('Не удалось сохранить.', 'damage'); return; }
    editingId = r.track.id;
    current.spec = clone(r.track.spec);
    setDirty(false);
    renderSaved();
    toast('Трасса сохранена.', 'event');
  }

  function exportTrack() {
    if (!current || !current.spec) return;
    ensureStore();
    const env = E.envelope(current.spec, val('constructor-name'), editingId || undefined);
    const text = store.exportJson(env);
    if (!text) { toast('Нечего экспортировать.', 'damage'); return; }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chrome-and-ash-track-' + (val('constructor-name') || 'track').replace(/[^\w\-а-яё]+/gi, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Экспорт готов.', 'event');
  }

  function importTrack(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      ensureStore();
      const r = store.importJson(String(reader.result || ''));
      if (!r.ok) { renderIssues(r.issues); toast('Импорт отклонён.', 'damage'); return; }
      const saved = store.save(r.track);
      if (!saved.ok) { renderIssues(saved.issues); return; }
      loadEnvelope(saved.track);
      renderSaved();
      toast('Трасса импортирована.', 'event');
    };
    reader.onerror = () => toast('Не удалось прочитать файл.', 'damage');
    reader.readAsText(file);
  }

  function testDrive() {
    if (!current || !current.ok) return;
    if (dirty && !window.confirm('Трасса не сохранена. Запустить тест-драйв?')) return;
    CnA.UI.startCustomTrack(current.spec);
  }

  function back() {
    if (dirty && !window.confirm('Есть несохранённые изменения. Выйти в гараж?')) return;
    if (CnA.UI) CnA.UI.showScreen('lobby');
  }

  function bind() {
    if (bound) return;
    bound = true;
    const arch = $('constructor-archetype');
    if (arch) arch.addEventListener('change', () => {
      const a = E.ARCHETYPES[arch.value];
      if (a) {
        setBudget({ hazardMin: a.hazardBudget[0], hazardMax: a.hazardBudget[1] });
        generate();
      }
    });
    const min = $('constructor-hazard-min');
    const max = $('constructor-hazard-max');
    if (min) min.addEventListener('input', () => {
      if (max && Number(min.value) > Number(max.value)) max.value = min.value;
      updateBudgetLabels();
    });
    if (max) max.addEventListener('input', () => {
      if (min && Number(max.value) < Number(min.value)) min.value = max.value;
      updateBudgetLabels();
    });
    const generateBtn = $('constructor-generate'); if (generateBtn) generateBtn.addEventListener('click', generate);
    const randomBtn = $('constructor-random-seed'); if (randomBtn) randomBtn.addEventListener('click', () => {
      const seed = $('constructor-seed'); if (seed) seed.value = String(Math.floor(Math.random() * 1000000000));
      generate();
    });
    const name = $('constructor-name'); if (name) name.addEventListener('input', () => {
      if (current && current.spec) current.spec.name = name.value;
      setDirty(true);
    });
    const saveBtn = $('constructor-save'); if (saveBtn) saveBtn.addEventListener('click', save);
    const exportBtn = $('constructor-export'); if (exportBtn) exportBtn.addEventListener('click', exportTrack);
    const importBtn = $('constructor-import'); const file = $('constructor-import-file');
    if (importBtn && file) {
      importBtn.addEventListener('click', () => file.click());
      file.addEventListener('change', () => { importTrack(file.files && file.files[0]); file.value = ''; });
    }
    const testBtn = $('constructor-test'); if (testBtn) testBtn.addEventListener('click', testDrive);
    const backBtn = $('constructor-back'); if (backBtn) backBtn.addEventListener('click', back);
  }

  function open() {
    ensureStore();
    if (CnA.UI) CnA.UI.showScreen('constructor');
    fillArchetypes();
    bind();
    if (!initialized) {
      initialized = true;
      const sel = $('constructor-archetype'); if (sel) sel.value = 'horseshoe';
      const name = $('constructor-name'); if (name) name.value = 'Моя трасса';
      const seed = $('constructor-seed'); if (seed) seed.value = String(Math.floor(Math.random() * 1000000000));
      const a = E.ARCHETYPES.horseshoe;
      setBudget({ hazardMin: a.hazardBudget[0], hazardMax: a.hazardBudget[1] });
    }
    if (!current) generate();
    else render();
    renderSaved();
  }

  CnA.TrackEditorUI = { open, close: back, generate, get current() { return current; } };
})(typeof window !== 'undefined' ? window : globalThis);
