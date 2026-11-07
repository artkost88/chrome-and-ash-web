/* ХРОМ И ПЕПЕЛ — DOM-контроллер конструктора трасс (Stage B).
   Модель живёт в TrackEditor/TrackDraft; здесь только экран, canvas и команды. */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});
  const E = CnA.TrackEditor;
  const TD = CnA.TrackDraft;
  if (!E || !TD) return;

  let store = null;
  let session = null;
  let editingId = null;
  let bound = false;
  let initialized = false;
  let tool = 'select';
  let paintType = 'straight';
  let pendingFeature = null;
  let pendingEntry = null;
  let view = null;
  let isPanning = false;
  let isDragging = false;
  let dragUid = null;
  let dragStart = null;
  let panStart = null;
  let spaceHeld = false;
  let stroke = null;

  function $(id) { return document.getElementById(id); }
  function val(id) { const el = $(id); return el ? el.value : ''; }
  function num(id, fallback) { const n = Number(val(id)); return Number.isFinite(n) ? n : fallback; }
  function toast(text, kind) { if (CnA.UI && CnA.UI.showToast) CnA.UI.showToast(String(text), kind || 'event', 2200); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function screenActive() {
    const el = $('screen-constructor');
    return !!(el && el.classList.contains('active'));
  }
  function nodeOf(uid) { return session && session.draft ? session.draft.nodes.find((n) => n.uid === uid) : null; }

  function makeReadOnlyShell(spec, reason, warnings) {
    const original = clone(spec);
    const rep = E.report(original);
    return {
      readOnly: true,
      reason: reason || 'readonly',
      originalSpec: original,
      draft: null,
      selectionUid: null,
      dirty: false,
      unsavedNew: false,
      warnings: warnings || [],
      report() {
        return { ok: true, readOnly: true, issues: [], warnings: this.warnings, stats: rep.stats, dirty: false };
      },
      toSpec() { return clone(original); },
      select() { return { ok: false, issues: [{ code: 'E_READONLY', message: 'Только чтение.' }] }; },
      undo() { return { ok: false, issues: [{ code: 'E_UNDO_EMPTY', message: 'Нечего отменять.' }] }; },
      redo() { return { ok: false, issues: [{ code: 'E_REDO_EMPTY', message: 'Нечего повторять.' }] }; },
      reset() { return { ok: false, issues: [{ code: 'E_READONLY', message: 'Только чтение.' }] }; },
      setLock() { return { ok: false, issues: [{ code: 'E_READONLY', message: 'Только чтение.' }] }; },
      markSaved() {},
    };
  }
  function canvasEl() { return $('constructor-canvas'); }

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
  function setStatus(text, isError) {
    const el = $('constructor-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.className = 'constructor-status' + (isError ? ' error' : '');
  }
  function live(text) {
    const el = $('constructor-live');
    if (el) el.textContent = String(text || '');
  }
  function dedupeWarnings(list) {
    const seen = new Map();
    (list || []).forEach((w) => {
      const key = w.code + '|' + (w.message || '');
      if (!seen.has(key)) seen.set(key, Object.assign({}, w, { count: 0, nodeIds: [] }));
      const item = seen.get(key);
      item.count += 1;
      if (w.nodeId != null) item.nodeIds.push(w.nodeId);
    });
    return [...seen.values()];
  }
  function warnText(warnings) {
    const grouped = new Map();
    dedupeWarnings(warnings).forEach((w) => {
      const key = w.code + '|' + (w.message || '');
      if (!grouped.has(key)) grouped.set(key, { code: w.code, message: w.message || '', count: 0 });
      grouped.get(key).count += 1;
    });
    return [...grouped.values()].map((g) => g.code + ': ' + g.message + (g.count > 1 ? ' ×' + g.count : '')).join(' · ');
  }

  function renderStats() {
    const box = $('constructor-stats');
    if (!box) return;
    box.innerHTML = '';
    const rep = session ? session.report() : null;
    let stats = rep && rep.stats;
    if (!stats && session && session.readOnly && session.originalSpec) {
      const ro = E.report(session.originalSpec);
      stats = ro.stats;
    }
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

  function renderIssues() {
    const box = $('constructor-issues');
    if (!box) return;
    box.innerHTML = '';
    const rep = session ? session.report() : null;
    const errors = rep ? (rep.issues || []) : [];
    const warnings = dedupeWarnings(rep ? (rep.warnings || []) : []);
    if (!errors.length && !warnings.length) {
      const ok = document.createElement('div');
      ok.className = 'constructor-ok';
      ok.textContent = session && session.readOnly ? 'Только чтение: геометрия не редактируется' : 'Трасса валидна';
      box.appendChild(ok);
      return;
    }
    warnings.forEach((w) => {
      const d = document.createElement('div');
      d.className = 'constructor-warning';
      d.textContent = w.code + ': ' + (w.message || '') + (w.count > 1 ? ' ×' + w.count : '');
      box.appendChild(d);
    });
    errors.forEach((issue) => {
      const d = document.createElement('div');
      d.className = 'constructor-error';
      d.textContent = issue.code + ': ' + (issue.message || 'ошибка');
      if (issue.nodeId) d.title = 'nodeId ' + issue.nodeId;
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
        if (!r.ok) { setStatus((r.issues && r.issues[0] && r.issues[0].message) || 'Не удалось удалить.', true); return; }
        if (editingId === env.id) editingId = null;
        renderSaved();
      });
      row.appendChild(load);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function renderInspector() {
    const title = $('constructor-node-title');
    const meta = $('constructor-node-meta');
    if (!title || !meta) return;
    if (session && !session.draft) {
      title.textContent = 'Только чтение';
      meta.textContent = 'Исходная геометрия сохранена: ' + (session.reason || 'несовместимый формат') +
        '. Экспорт, тест-драйв и копия доступны.';
      ['constructor-insert', 'constructor-delete', 'constructor-make-start', 'constructor-make-cp',
        'constructor-pit-tile', 'constructor-clear-pit', 'constructor-pit-branch', 'constructor-shortcut',
        'constructor-clear-shortcut', 'constructor-undo', 'constructor-redo', 'constructor-reset',
        'constructor-save', 'constructor-lock-pos', 'constructor-lock-type', 'constructor-lock-remove',
        'constructor-flock-start', 'constructor-flock-checkpoint', 'constructor-flock-grid',
        'constructor-flock-pit', 'constructor-flock-shortcut'].forEach((id) => setDisabled(id, true));
      document.querySelectorAll('#constructor-palette .palette-btn, #constructor-toolbar .tool-btn').forEach((b) => { b.disabled = true; });
      return;
    }
    const uid = session ? session.selectionUid : null;
    const node = uid ? nodeOf(uid) : null;
    if (!node) {
      title.textContent = 'Ничего не выбрано';
      meta.textContent = session && session.readOnly ? 'Только чтение: ' + (session.reason || '') : 'Кликните по тайлу на полотне.';
    } else {
      const tile = CnA.TILES[node.type] || { label: node.type };
      const role = node.uid === session.draft.startUid ? 'СТАРТ'
        : node.uid === session.draft.checkpointUid ? 'КП'
          : session.draft.grid.includes(node.uid) ? 'РЕШЁТКА'
            : session.draft.pit && session.draft.pit.tile === node.uid ? 'ПИТ-ТАЙЛ'
              : session.draft.pit && session.draft.pit.kind === 'branch' && session.draft.pit.nodes.includes(node.uid) ? 'ПИТ-ВЕТКА'
                : session.draft.shortcut && session.draft.shortcut.nodes.includes(node.uid) ? 'СРЕЗ' : '—';
      title.textContent = (tile.label || node.type) + ' · ' + node.uid;
      meta.textContent = 'q: ' + node.q + ', r: ' + node.r + ' · роль: ' + role +
        (session.draft.decor.includes(node.uid) ? ' · декор' : '');
    }
    const locks = (session && node && session.draft.locks && session.draft.locks.nodes[uid]) || {};
    ['pos', 'type', 'remove'].forEach((f) => {
      const el = $('constructor-lock-' + f);
      if (el) el.checked = !!locks[f];
    });
    const fl = (session && session.draft.locks && session.draft.locks.features) || {};
    ['start', 'checkpoint', 'grid', 'pit', 'shortcut'].forEach((f) => {
      const el = $('constructor-flock-' + f);
      if (el) el.checked = !!fl[f];
    });
    const ro = !session || session.readOnly;
    ['constructor-insert', 'constructor-delete', 'constructor-make-start', 'constructor-make-cp',
      'constructor-pit-tile', 'constructor-clear-pit', 'constructor-pit-branch', 'constructor-shortcut',
      'constructor-clear-shortcut', 'constructor-undo', 'constructor-redo', 'constructor-reset',
      'constructor-save'].forEach((id) => setDisabled(id, !!ro));
    setDisabled('constructor-insert', ro || !node);
    setDisabled('constructor-delete', ro || !node);
    setDisabled('constructor-make-start', ro || !node);
    setDisabled('constructor-make-cp', ro || !node);
    setDisabled('constructor-pit-tile', ro || !node || !session.draft.main.includes(uid));
    setDisabled('constructor-pit-branch', ro || !node);
    setDisabled('constructor-shortcut', ro || !node);
    setDisabled('constructor-clear-pit', ro || !session.draft.pit);
    setDisabled('constructor-clear-shortcut', ro || !session.draft.shortcut);
    ['pos', 'type', 'remove'].forEach((f) => setDisabled('constructor-lock-' + f, !!ro));
    ['start', 'checkpoint', 'grid', 'pit', 'shortcut'].forEach((f) => setDisabled('constructor-flock-' + f, !!ro));
    document.querySelectorAll('#constructor-palette .palette-btn, #constructor-toolbar .tool-btn').forEach((b) => { b.disabled = !!ro; });
  }

  function fitView() {
    if (!session) return;
    const el = canvasEl();
    const width = (el && el.clientWidth) || 900;
    const height = (el && el.clientHeight) || 520;
    const b = TD.editorBounds(session.draft, session.draft.hexSize || 34);
    const scale = Math.max(0.35, Math.min(3, Math.min(width / b.w, height / b.h) * 0.94));
    view = {
      width,
      height,
      scale,
      tx: width / 2 - (b.x + b.w / 2) * scale,
      ty: height / 2 - (b.y + b.h / 2) * scale,
    };
  }

  function zoomBy(factor, mx, my) {
    if (!session) return;
    if (!view) fitView();
    const el = canvasEl();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = mx == null ? rect.width / 2 : mx;
    const py = my == null ? rect.height / 2 : my;
    const worldX = (px - view.tx) / view.scale;
    const worldY = (py - view.ty) / view.scale;
    view.scale = Math.max(0.4, Math.min(3.2, view.scale * factor));
    view.tx = px - worldX * view.scale;
    view.ty = py - worldY * view.scale;
    renderCanvas();
  }

  function renderCanvas() {
    const el = canvasEl();
    if (!el) return;
    if (!session) { el.innerHTML = E.previewSvg(null); return; }
    if (session.readOnly) {
      el.innerHTML = E.previewSvg(currentSpecForExport());
      const label = $('constructor-zoom-label');
      if (label) label.textContent = '—';
      return;
    }
    if (!view) fitView();
    const w = el.clientWidth || 900;
    const h = el.clientHeight || 520;
    if (view.width !== w || view.height !== h) {
      const relX = w / (view.width || w);
      const relY = h / (view.height || h);
      view.scale *= Math.min(relX, relY);
      view.tx *= relX;
      view.ty *= relY;
      view.width = w;
      view.height = h;
    }
    el.innerHTML = TD.renderEditorSvg(session.draft, view, { selectedUid: session.selectionUid });
    const label = $('constructor-zoom-label');
    if (label) label.textContent = Math.round(view.scale * 100) + '%';
    const svg = el.querySelector('svg');
    if (svg) svg.setAttribute('aria-describedby', 'constructor-status');
  }

  function renderDirty() {
    const el = $('constructor-dirty');
    if (!el) return;
    const dirty = !!(session && (session.dirty || (session.unsavedNew && !editingId)));
    el.hidden = !dirty;
    el.textContent = session && session.readOnly ? 'только чтение' : '● не сохранено';
  }

  function renderAll() {
    renderCanvas();
    renderStats();
    renderIssues();
    renderInspector();
    renderDirty();
  }

  function loadSession(spec, opts) {
    const created = TD.createSession(spec, opts || {});
    if (!created.ok) {
      setStatus((created.issues && created.issues[0] && created.issues[0].message) || 'Трасса отклонена.', true);
      toast('Трасса отклонена валидатором.', 'damage');
      return false;
    }
    session = created.session;
    if (!session && created.readOnly) {
      session = makeReadOnlyShell(created.originalSpec || spec, created.reason, created.warnings);
    }
    editingId = (opts && opts.trackId) || null;
    view = null;
    pendingFeature = null;
    pendingEntry = null;
    if (session) {
      if (session.draft) session.select(session.draft.startUid);
      renderAll();
      const rep = session.report();
      setStatus(session.readOnly
        ? 'Только чтение: ' + (session.reason || 'несовместимая геометрия') + '. Экспорт и тест-драйв доступны.'
        : (rep.ok ? 'Трасса готова к правке.' : 'Есть ошибки — исправьте их перед сохранением.'),
      !session.readOnly && !rep.ok);
      if (created.warnings && created.warnings.length) live(warnText(created.warnings));
    }
    return true;
  }

  function generate() {
    if (session && !session.readOnly && (session.dirty || session.unsavedNew) &&
      !window.confirm('Несохранённые правки будут потеряны. Сгенерировать заново?')) return;
    const o = optionsFromControls();
    const r = E.generate(o);
    if (!r.spec) {
      setStatus('Генерация не удалась: ' + ((r.issues && r.issues[0] && r.issues[0].message) || 'ошибка'), true);
      toast('Не удалось сгенерировать трассу.', 'damage');
      return;
    }
    const seedEl = $('constructor-seed');
    if (seedEl) seedEl.value = String(o.seed);
    if (!loadSession(r.spec, { kind: 'generated' })) return;
    if (session && session.draft) session.draft.name = o.name;
    renderAll();
    const budget = r.budget;
    let msg = 'Сгенерировано: ' + (r.stats ? r.stats.length : '?') + ' тайлов, опасностей ' + (budget ? budget.actual : '?') + '.';
    if (budget && budget.actual < budget.requestedMin) msg += ' Минимум ' + budget.requestedMin + ' недостижим (макс. ' + budget.achievable + ').';
    setStatus(msg, false);
    live(msg);
  }

  function acceptResult(res, label) {
    renderAll();
    if (res.warnings && res.warnings.length) {
      setStatus((label || 'Готово') + ' · ' + warnText(res.warnings), false);
      live(warnText(res.warnings));
    } else {
      setStatus(label || 'Готово', false);
      live(label || 'Готово');
    }
    return res;
  }

  function tryOp(op, label) {
    if (!session) return null;
    const res = session.apply(op);
    if (res.ok) return acceptResult(res, label);
    setStatus(((res.issues && res.issues[0] && (res.issues[0].code + ': ' + res.issues[0].message)) || 'Операция отклонена.'), true);
    live('Отказ: ' + ((res.issues && res.issues[0] && res.issues[0].message) || 'операция отклонена'));
    toast((res.issues && res.issues[0] && res.issues[0].message) || 'Операция отклонена.', 'damage');
    return res;
  }

  function confirmThen(op, label) {
    const res = session.apply(op);
    if (res.ok) return acceptResult(res, label);
    if (res.requiresConfirm) {
      if (!window.confirm('Заменить существующий объект?')) return null;
      return tryOp(Object.assign({}, op, { force: true }), label);
    }
    return tryOp(op, label);
  }

  function selectedUid() { return session ? session.selectionUid : null; }

  function doInsert() {
    if (!session || !selectedUid()) return;
    const d = session.draft;
    const uid = selectedUid();
    const mi = d.main.indexOf(uid);
    if (mi >= 0) {
      tryOp({ op: 'insertBetween', from: uid, to: d.main[(mi + 1) % d.main.length] }, 'Вставлено');
      return;
    }
    const chains = [];
    if (d.pit && d.pit.kind === 'branch') chains.push(d.pit);
    if (d.shortcut) chains.push(d.shortcut);
    for (const ch of chains) {
      const idx = ch.nodes.indexOf(uid);
      if (idx >= 0) {
        const to = idx === ch.nodes.length - 1 ? ch.exit : ch.nodes[idx + 1];
        tryOp({ op: 'insertBetween', from: uid, to }, 'Вставлено');
        return;
      }
    }
    setStatus('Нечего вставлять после выбранного тайла.', true);
  }

  function doDelete() { if (session && selectedUid()) tryOp({ op: 'remove', uid: selectedUid() }, 'Удалено'); }
  function doMakeStart() { if (session && selectedUid()) tryOp({ op: 'setStart', uid: selectedUid() }, 'Старт перенесён'); }
  function doMakeCp() { if (session && selectedUid()) tryOp({ op: 'setCheckpoint', uid: selectedUid() }, 'КП перенесён'); }
  function doPitTile() { if (session && selectedUid()) confirmThen({ op: 'setPitTile', uid: selectedUid() }, 'Пит-тайл поставлен'); }
  function doClearPit() { if (session && window.confirm('Убрать пит?')) tryOp({ op: 'clearPit', force: true }, 'Пит убран'); }
  function doClearShortcut() { if (session && window.confirm('Убрать срез?')) tryOp({ op: 'clearShortcut', force: true }, 'Срез убран'); }

  function activateFeature(kind, btn) {
    if (!session || session.readOnly) return;
    pendingFeature = kind;
    pendingEntry = null;
    tool = 'select';
    document.querySelectorAll('#constructor-palette .palette-btn').forEach((b) => b.classList.toggle('active', btn && b === btn));
    updatePaletteAria();
    document.querySelectorAll('#constructor-toolbar .tool-btn').forEach((b) => b.classList.remove('active'));
    setStatus(kind === 'pit-branch' ? 'Пит-ветка: клик вход, затем выход.' : 'Срез: клик вход, затем выход.', false);
  }

  function handleFeatureClick(uid) {
    if (!session || !pendingFeature) return;
    if (pendingFeature === 'pit-tile') {
      pendingFeature = null;
      tryOp({ op: 'setPitTile', uid, force: true }, 'Пит-тайл поставлен');
      return;
    }
    if (!pendingEntry) {
      pendingEntry = uid;
      setStatus('Выберите выход ветки (entry → exit).', false);
      live('Выбран вход ветки');
      return;
    }
    if (pendingEntry === uid) { setStatus('Вход и выход должны различаться.', true); return; }
    const entry = pendingEntry;
    pendingEntry = null;
    const feature = pendingFeature;
    pendingFeature = null;
    if (feature === 'pit-branch') confirmThen({ op: 'setPitBranch', entry, exit: uid }, 'Пит-ветка проложена');
    else if (feature === 'shortcut') confirmThen({ op: 'setShortcut', entry, exit: uid }, 'Срез проложен');
  }

  function setTool(next) {
    if (!session || session.readOnly) return;
    tool = next === 'paint' || next === 'move' ? next : 'select';
    pendingFeature = null;
    pendingEntry = null;
    document.querySelectorAll('#constructor-toolbar .tool-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
      b.setAttribute('aria-pressed', b.dataset.tool === tool ? 'true' : 'false');
    });
    setStatus(tool === 'paint' ? 'Кисть: ' + paintType + '. Клик по тайлу.' : tool === 'move' ? 'Сдвиг: перетащите тайл на соседнюю клетку.' : 'Выбор: клик по тайлу, Ctrl+Z — отмена.', false);
  }

  function updatePaletteAria() {
    document.querySelectorAll('#constructor-palette .palette-btn').forEach((b) => {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', b.classList.contains('active') ? 'true' : 'false');
    });
  }

  function setPaintType(type, btn) {
    paintType = type;
    document.querySelectorAll('#constructor-palette .palette-btn').forEach((b) => b.classList.toggle('active', b === btn));
    updatePaletteAria();
    if (session && !session.readOnly) setTool('paint');
    setStatus('Кисть: ' + type, false);
  }

  function screenToWorld(clientX, clientY) {
    const el = canvasEl();
    if (!el || !view) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: (clientX - rect.left - view.tx) / view.scale, y: (clientY - rect.top - view.ty) / view.scale };
  }
  function worldToCell(x, y) {
    const size = (session && session.draft.hexSize) || 34;
    const rf = y / (size * 1.5);
    const qf = x / (size * Math.sqrt(3)) - rf / 2;
    let rx = Math.round(qf), ry = Math.round(rf), rz = Math.round(-qf - rf);
    const dx = Math.abs(rx - qf), dy = Math.abs(ry - rf), dz = Math.abs(rz - (-qf - rf));
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: ry };
  }

  function focusSelectedNode() {
    if (!session || !session.selectionUid) return;
    const el = document.querySelector('#constructor-canvas [data-uid="' + session.selectionUid + '"]');
    if (el) el.focus({ preventScroll: true });
  }

  function selectNeighbor(key) {
    if (!session || !session.selectionUid) return;
    const cur = nodeOf(session.selectionUid);
    if (!cur) return;
    const size = session.draft.hexSize || 34;
    const p0 = TD.hexXY(cur.q, cur.r, size);
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    if (!dir) return;
    let best = null, bestScore = Infinity;
    session.draft.nodes.forEach((n) => {
      if (n.uid === cur.uid || !TD.isInt(n.q) || !TD.isInt(n.r)) return;
      const p = TD.hexXY(n.q, n.r, size);
      const dx = p.x - p0.x, dy = p.y - p0.y;
      const dot = dx * dir[0] + dy * dir[1];
      if (dot <= 0) return;
      const score = Math.hypot(dx, dy);
      if (score < bestScore) { bestScore = score; best = n.uid; }
    });
    if (best) {
      session.select(best);
      renderAll();
      focusSelectedNode();
      live('Выбран тайл ' + best);
    }
  }

  function addStrokeChange(uid) {
    if (!stroke || stroke.uids.has(uid)) return;
    const node = nodeOf(uid);
    if (!node || node.type === paintType) return;
    stroke.uids.add(uid);
    stroke.changes.push({ uid, type: paintType });
  }

  function onCanvasDown(event) {
    if (!session) return;
    const handle = event.target.closest && event.target.closest('[data-insert-from]');
    if (handle && !session.readOnly) {
      event.preventDefault();
      tryOp({ op: 'insertBetween', from: handle.getAttribute('data-insert-from'), to: handle.getAttribute('data-insert-to') }, 'Вставлено');
      focusSelectedNode();
      return;
    }
    const nodeEl = event.target.closest && event.target.closest('[data-uid]');
    const uid = nodeEl ? nodeEl.getAttribute('data-uid') : null;
    if (event.button === 1 || spaceHeld) {
      isPanning = true;
      panStart = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
      event.preventDefault();
      return;
    }
    if (!uid) {
      if (tool === 'select' && event.button === 0) { session.select(null); renderAll(); }
      return;
    }
    if (pendingFeature) { handleFeatureClick(uid); return; }
    if (tool === 'paint') {
      stroke = { changes: [], uids: new Set() };
      addStrokeChange(uid);
      try { event.target.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      setStatus('Кисть: ' + paintType + ' · отпустите кнопку, чтобы применить', false);
      event.preventDefault();
      return;
    }
    if (tool === 'move') {
      dragUid = uid;
      dragStart = { x: event.clientX, y: event.clientY };
      isDragging = false;
      event.preventDefault();
      return;
    }
    session.select(uid);
    renderAll();
    focusSelectedNode();
    live('Выбран тайл ' + uid);
  }

  function onCanvasMove(event) {
    if (isPanning && panStart) {
      view.tx = panStart.tx + (event.clientX - panStart.x);
      view.ty = panStart.ty + (event.clientY - panStart.y);
      renderCanvas();
      return;
    }
    if (stroke) {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const nodeEl = el && el.closest && el.closest('[data-uid]');
      if (nodeEl) {
        addStrokeChange(nodeEl.getAttribute('data-uid'));
        setStatus('Кисть: ' + paintType + ' · ' + stroke.changes.length + ' тайл(ов)', false);
      }
      return;
    }
    if (dragUid) {
      if (Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y) > 4) isDragging = true;
      const w = screenToWorld(event.clientX, event.clientY);
      const cell = worldToCell(w.x, w.y);
      const target = session.draft.nodes.find((n) => n.q === cell.q && n.r === cell.r);
      setStatus('Сдвиг: q ' + cell.q + ', r ' + cell.r + (target ? ' (занято)' : ''), false);
    }
  }

  function onCanvasUp(event) {
    if (isPanning) { isPanning = false; panStart = null; return; }
    if (stroke) {
      const changes = stroke.changes;
      stroke = null;
      if (changes.length) {
        const res = session.apply({ op: 'paintStroke', changes });
        if (res.ok) acceptResult(res, 'Кисть применена (' + changes.length + ')');
        else {
          setStatus(((res.issues && res.issues[0] && (res.issues[0].code + ': ' + res.issues[0].message)) || 'Кисть отменена.'), true);
          toast('Кисть отменена: ' + ((res.issues && res.issues[0] && res.issues[0].message) || 'ошибка'), 'damage');
        }
        focusSelectedNode();
      }
      return;
    }
    if (dragUid && isDragging) {
      const w = screenToWorld(event.clientX, event.clientY);
      const cell = worldToCell(w.x, w.y);
      const uid = dragUid;
      dragUid = null;
      isDragging = false;
      tryOp({ op: 'move', uid, q: cell.q, r: cell.r }, 'Тайл сдвинут');
      focusSelectedNode();
      return;
    }
    dragUid = null;
    isDragging = false;
    focusSelectedNode();
  }

  function onKeyDown(e) {
    if (!screenActive()) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || (e.target && e.target.isContentEditable)) return;
    const activeNode = document.activeElement && document.activeElement.closest && document.activeElement.closest('.ed-node');
    if (activeNode && e.key.indexOf('Arrow') === 0) {
      e.preventDefault();
      selectNeighbor(e.key);
      return;
    }
    if (e.key === ' ') { e.preventDefault(); spaceHeld = true; return; }
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); save(false); return; }
      if (e.key === 'Enter') { e.preventDefault(); testDrive(); return; }
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'v') setTool('select');
    else if (key === 'b') setTool('paint');
    else if (key === 'm') setTool('move');
    else if (/^[1-8]$/.test(key)) {
      const types = ['straight', 'turn', 'sand', 'debris', 'event', 'ramp', 'tunnel', 'bridge'];
      const type = types[Number(key) - 1];
      setPaintType(type, document.querySelector('#constructor-palette [data-tile="' + type + '"]'));
    } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(); }
    else if (key === 's') doMakeStart();
    else if (key === 'c') doMakeCp();
    else if (key === 'p') activateFeature('pit-branch', null);
    else if (key === 'x') activateFeature('shortcut', null);
    else if (key === 'escape') { setTool('select'); if (session) session.select(null); renderAll(); }
    else if (e.key === 'Enter' || e.key === 'Insert') { e.preventDefault(); doInsert(); }
    else if (e.key.indexOf('Arrow') === 0 && session && selectedUid()) {
      e.preventDefault();
      const node = nodeOf(selectedUid());
      const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      const d = dirs[e.key];
      if (d) tryOp({ op: 'move', uid: selectedUid(), q: node.q + d[0], r: node.r + d[1] }, 'Тайл сдвинут');
    }
  }
  function onKeyUp(e) { if (e.key === ' ') spaceHeld = false; }

  function undo() {
    if (!session) return;
    const r = session.undo();
    if (r.ok) { renderAll(); focusSelectedNode(); setStatus('Отменено.', false); live('Отменено'); }
    else setStatus((r.issues && r.issues[0] && r.issues[0].message) || 'Нечего отменять.', true);
  }
  function redo() {
    if (!session) return;
    const r = session.redo();
    if (r.ok) { renderAll(); focusSelectedNode(); setStatus('Повторено.', false); live('Повторено'); }
    else setStatus((r.issues && r.issues[0] && r.issues[0].message) || 'Нечего повторять.', true);
  }
  function resetDraft() {
    if (!session) return;
    if (!window.confirm('Сбросить ручные правки к исходной трассе?')) return;
    const r = session.reset({ force: true });
    if (r.ok) { view = null; renderAll(); setStatus('Правки сброшены.', false); }
  }

  function currentSpecForExport() {
    if (!session) return null;
    if (session.readOnly) return clone(session.originalSpec || (session.draft && session.draft.source && session.draft.source.originalSpec));
    return session.toSpec();
  }

  function save(copy) {
    if (!session) return;
    if (session.readOnly) {
      if (!copy) { setStatus('Только чтение: доступна только «КОПИЯ».', true); return; }
      ensureStore();
      const spec = currentSpecForExport();
      const r = store.save(E.envelope(spec, val('constructor-name') || spec.name || 'Моя трасса'));
      if (!r.ok) { setStatus('Копия отклонена валидатором.', true); return; }
      renderSaved();
      setStatus('Сохранено копией (только чтение).', false);
      return;
    }
    const rep = session.report();
    if (!rep.ok) { renderIssues(); setStatus('Есть ошибки — сохранение заблокировано.', true); return; }
    ensureStore();
    const env = E.envelope(session.toSpec(), val('constructor-name') || session.draft.name, copy ? undefined : (editingId || undefined));
    const r = store.save(env);
    if (!r.ok) {
      setStatus((r.issues && r.issues[0] && (r.issues[0].code + ': ' + r.issues[0].message)) || 'Не удалось сохранить.', true);
      toast('Не удалось сохранить.', 'damage');
      return;
    }
    editingId = r.track.id;
    session.markSaved(editingId);
    renderAll();
    renderSaved();
    setStatus(copy ? 'Сохранено копией.' : 'Трасса сохранена.', false);
    live('Трасса сохранена');
  }

  function exportTrack() {
    const spec = currentSpecForExport();
    if (!spec) { setStatus('Нечего экспортировать.', true); return; }
    ensureStore();
    const env = E.envelope(spec, val('constructor-name') || spec.name || 'track', editingId || undefined);
    const text = store.exportJson(env);
    if (!text) { setStatus('Экспорт отклонён валидатором.', true); return; }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chrome-and-ash-track-' + String(val('constructor-name') || 'track').replace(/[^\w\-а-яё]+/gi, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Экспорт готов.', false);
  }

  function chooseImportConflict(name) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'constructor-modal';
      const card = document.createElement('div');
      card.className = 'constructor-modal-card';
      const h = document.createElement('h3');
      h.textContent = 'Трасса с таким id уже есть';
      const p = document.createElement('p');
      p.textContent = '«' + name + '» уже сохранена. Заменить, импортировать копией или отменить?';
      const row = document.createElement('div');
      row.className = 'inspector-row';
      const mk = (label, value, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip-btn' + (cls ? ' ' + cls : '');
        b.textContent = label;
        b.addEventListener('click', () => { overlay.remove(); resolve(value); });
        row.appendChild(b);
        return b;
      };
      mk('ЗАМЕНИТЬ', 'replace', 'danger');
      const copyBtn = mk('ИМПОРТ КОПИЕЙ', 'copy', 'primary');
      mk('ОТМЕНА', 'cancel');
      card.appendChild(h); card.appendChild(p); card.appendChild(row);
      overlay.appendChild(card);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve('cancel'); } });
      document.body.appendChild(overlay);
      copyBtn.focus();
    });
  }

  function importTrack(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      ensureStore();
      const r = store.importJson(String(reader.result || ''));
      if (!r.ok) {
        setStatus('Импорт отклонён: ' + ((r.issues && r.issues[0] && r.issues[0].message) || ''), true);
        toast('Импорт отклонён.', 'damage');
        return;
      }
      let track = r.track;
      const existing = track && track.id ? store.get(track.id) : null;
      if (existing) {
        const choice = await chooseImportConflict(existing.name);
        if (choice === 'cancel') { setStatus('Импорт отменён.', false); return; }
        if (choice === 'copy') {
          track = Object.assign({}, track, {
            id: E.customId(),
            name: E.cleanName((track.name || 'Трасса') + ' (копия)'),
          });
        }
      }
      const saved = store.save(track);
      if (!saved.ok) { setStatus('Импорт отклонён валидатором.', true); return; }
      loadEnvelope(saved.track);
      renderSaved();
      toast('Трасса импортирована.', 'event');
    };
    reader.onerror = () => toast('Не удалось прочитать файл.', 'damage');
    reader.readAsText(file);
  }

  function loadEnvelope(env) {
    if (!env || !env.spec) return;
    if (session && (session.dirty || session.unsavedNew) && !window.confirm('Несохранённые изменения будут потеряны. Продолжить?')) return;
    loadSession(env.spec, { kind: 'saved', trackId: env.id });
    const name = $('constructor-name');
    if (name) name.value = env.name || env.spec.name || 'Моя трасса';
    const arch = $('constructor-archetype');
    if (arch && env.spec.archetype) arch.value = env.spec.archetype;
    const seed = $('constructor-seed');
    if (seed) seed.value = String(env.spec.seed == null ? 1 : env.spec.seed);
    renderAll();
  }

  function testDrive() {
    if (!session) return;
    if (session.readOnly) {
      const spec = currentSpecForExport();
      if (spec) CnA.UI.startCustomTrack(spec);
      return;
    }
    const rep = session.report();
    if (!rep.ok) { renderIssues(); setStatus('Трасса не проходит валидацию.', true); return; }
    if (session.dirty && !window.confirm('Трасса не сохранена. Запустить тест-драйв?')) return;
    CnA.UI.startCustomTrack(session.toSpec());
  }

  function back() {
    if (session && (session.dirty || session.unsavedNew) && !session.readOnly) {
      if (!window.confirm('Есть несохранённые изменения. Выйти в гараж?')) return;
    }
    if (CnA.UI) CnA.UI.showScreen('lobby');
  }

  function bind() {
    if (bound) return;
    bound = true;
    updatePaletteAria();
    const arch = $('constructor-archetype');
    if (arch) arch.addEventListener('change', () => {
      const a = E.ARCHETYPES[arch.value];
      if (a) { setBudget({ hazardMin: a.hazardBudget[0], hazardMax: a.hazardBudget[1] }); generate(); }
    });
    const min = $('constructor-hazard-min'), max = $('constructor-hazard-max');
    if (min) min.addEventListener('input', () => { if (max && Number(min.value) > Number(max.value)) max.value = min.value; updateBudgetLabels(); });
    if (max) max.addEventListener('input', () => { if (min && Number(max.value) < Number(min.value)) min.value = max.value; updateBudgetLabels(); });
    const genBtn = $('constructor-generate'); if (genBtn) genBtn.addEventListener('click', generate);
    const randomBtn = $('constructor-random-seed'); if (randomBtn) randomBtn.addEventListener('click', () => {
      const seed = $('constructor-seed'); if (seed) seed.value = String(Math.floor(Math.random() * 1000000000));
      generate();
    });
    const name = $('constructor-name'); if (name) name.addEventListener('input', () => {
      if (session) { session.draft.name = E.cleanName(name.value); renderDirty(); }
    });
    const bindings = {
      'constructor-save': () => save(false),
      'constructor-save-copy': () => save(true),
      'constructor-export': exportTrack,
      'constructor-test': testDrive,
      'constructor-back': back,
      'constructor-undo': undo,
      'constructor-redo': redo,
      'constructor-reset': resetDraft,
      'constructor-zoom-in': () => zoomBy(1.18),
      'constructor-zoom-out': () => zoomBy(1 / 1.18),
      'constructor-zoom-fit': () => { fitView(); renderCanvas(); },
      'constructor-insert': doInsert,
      'constructor-delete': doDelete,
      'constructor-make-start': doMakeStart,
      'constructor-make-cp': doMakeCp,
      'constructor-pit-tile': doPitTile,
      'constructor-clear-pit': doClearPit,
      'constructor-pit-branch': () => activateFeature('pit-branch', null),
      'constructor-shortcut': () => activateFeature('shortcut', null),
      'constructor-clear-shortcut': doClearShortcut,
    };
    Object.keys(bindings).forEach((id) => { const el = $(id); if (el) el.addEventListener('click', bindings[id]); });
    const importBtn = $('constructor-import'), file = $('constructor-import-file');
    if (importBtn && file) {
      importBtn.addEventListener('click', () => file.click());
      file.addEventListener('change', () => { importTrack(file.files && file.files[0]); file.value = ''; });
    }
    document.querySelectorAll('#constructor-toolbar .tool-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    document.querySelectorAll('#constructor-palette .palette-btn').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.tile) setPaintType(b.dataset.tile, b);
      else if (b.dataset.tool) activateFeature(b.dataset.tool, b);
    }));
    ['pos', 'type', 'remove'].forEach((f) => {
      const el = $('constructor-lock-' + f); if (!el) return;
      el.addEventListener('change', () => {
        if (!session || !selectedUid()) return;
        const flags = {};
        flags[f] = el.checked;
        const r = session.apply({ op: 'setLock', uid: selectedUid(), flags });
        if (r.ok) { renderAll(); setStatus('Замок обновлён.', false); }
      });
    });
    ['start', 'checkpoint', 'grid', 'pit', 'shortcut'].forEach((f) => {
      const el = $('constructor-flock-' + f); if (!el) return;
      el.addEventListener('change', () => {
        if (!session || session.readOnly) return;
        const r = session.apply({ op: 'setFeatureLock', feature: f, locked: el.checked });
        if (r.ok) { renderAll(); setStatus('Замок объекта обновлён.', false); }
        else { el.checked = !el.checked; setStatus((r.issues && r.issues[0] && r.issues[0].message) || 'Замок недоступен.', true); }
      });
    });
    const canvas = canvasEl();
    if (canvas) {
      canvas.addEventListener('pointerdown', onCanvasDown);
      canvas.addEventListener('pointermove', onCanvasMove);
      canvas.addEventListener('pointerup', onCanvasUp);
      canvas.addEventListener('pointercancel', onCanvasUp);
      canvas.addEventListener('wheel', (e) => {
        if (!session) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
      }, { passive: false });
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('beforeunload', (e) => {
      if (session && (session.dirty || session.unsavedNew) && !session.readOnly) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function open() {
    ensureStore();
    bind();
    if (CnA.UI) CnA.UI.showScreen('constructor');
    fillArchetypes();
    if (!initialized) {
      initialized = true;
      const sel = $('constructor-archetype'); if (sel) sel.value = 'horseshoe';
      const name = $('constructor-name'); if (name) name.value = 'Моя трасса';
      const seed = $('constructor-seed'); if (seed) seed.value = String(Math.floor(Math.random() * 1000000000));
      const a = E.ARCHETYPES.horseshoe;
      setBudget({ hazardMin: a.hazardBudget[0], hazardMax: a.hazardBudget[1] });
    }
    if (!session) generate();
    renderSaved();
    if (session) renderAll();
  }

  CnA.TrackEditorUI = {
    open,
    close: back,
    generate,
    get session() { return session; },
    get current() {
      if (!session) return null;
      const rep = session.report();
      return { spec: currentSpecForExport(), ok: rep.ok, issues: rep.issues, stats: rep.stats, readOnly: session.readOnly };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
