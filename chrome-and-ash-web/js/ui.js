/* ХРОМ И ПЕПЕЛ — веб-клиент одиночной игры (фаза 1).
   Управляет экранами (вход/регистрация, ежедневный сид, игра, результаты, рейтинг),
   гоняет движок CnA (человек против 3 ИИ) и ходит в REST API через window.API.
   Визуал — по docs/05-art-brief-sunset-readability.md. */
(function (root) {
  'use strict';
  const CnA = root.CnA;
  const API = root.API;
  const CnA_WS = root.CnA_WS;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Палитра «Закат в Пустоши» — заливка/чернила тайлов (docs/05 §1). */
  const SUNSET_FILL = {
    start: '#c8a04e', straight: '#5b5142', turn: '#5b5142', fork: '#5b5142',
    sand: '#a34a24', debris: '#5b5142', ramp: '#c8a04e', tunnel: '#0b0f12',
    bridge: '#4a4038', event: '#5b5142', pit: '#3a332c', checkpoint: '#d8d8d2',
    building: '#4a4038', ruin: '#241f1a',
  };
  const SUNSET_INK = {
    start: '#241f1a', straight: '#f5f0e8', turn: '#f5f0e8', fork: '#c8a04e',
    sand: '#f5f0e8', debris: '#f5f0e8', ramp: '#241f1a', tunnel: '#f5f0e8',
    bridge: '#f5f0e8', event: '#ff7a1e', pit: '#d8d8d2', checkpoint: '#241f1a',
    building: '#c8a04e', ruin: '#c8a04e',
  };
  const CARD_ICON = {
    mg: '✹', twin: '⁂', rocket: '➤', harpoon: '↩', mine: '✸', oil: '◉',
    flamer: '▲', smoke: '☁', nitro: '⚡', brake: '■', ramplate: '◣', repair: '✚',
    jammer: '✖', canister: '▣', drone: '✚', boost: '»', ramboost: '⇶', shield: '◈',
    emp: 'ϟ', net: '#', sabotage: '☠', tow: '↩',
  };
  const UP_SHORT = {
    engine2: 'ДВ2', engine3: 'ДВ3', turbo: 'ТУР', armor: 'БРН', reactive: 'РЕА',
    plow: 'ПЛД', suspension: 'ПОД', tracks: 'ГУС', balance: 'БАЛ', turret: 'ТУР',
    barrel: 'СТВ', autoloader: 'АВТ', spikes: 'ШИП', cage: 'КЛТ', magnet: 'МАГ',
  };
  /* Сгенерированные мини-модели машин (assets/factions/<id>/mini.png). */
  const MINI = { chrome: false, rust: false, carnival: false, swarm: false };
  /* Только горизонтальные отражения: у кого нос в картинке смотрит вправо. */
  const FRONT_RIGHT = { chrome: false, rust: false, carnival: true, swarm: false };
  function carAngle(c) {
    const track = UI.game && UI.game.race && UI.game.race.track;
    if (!track || !track.nodes[c.node]) return 0;
    const n = track.nodes[c.node];
    if (!n.next || !n.next.length) return 0;
    const nx = track.nodes[n.next[0]];
    if (!nx) return 0;
    return Math.atan2(nx.y - n.y, nx.x - n.x) * 180 / Math.PI;
  }
  function loadMinis() {
    CnA.FACTIONS.forEach((f) => {
      const img = new Image();
      img.onload = () => { MINI[f.id] = true; if (UI.game) renderBoard(); };
      img.onerror = () => { MINI[f.id] = false; };
      img.src = assetUrl('faction', f.id, 'mini');
    });
  }
  /* Иллюстрации карт арсенала: список сгенерированных id. */
  const CARD_ART_IDS = ['mg', 'twin', 'harpoon', 'mine', 'oil', 'flamer', 'smoke', 'nitro', 'brake', 'ramplate', 'repair', 'jammer', 'canister', 'drone', 'boost', 'ramboost', 'shield', 'emp', 'net', 'sabotage', 'tow', 'rocket'];
  const CARD_ART = {};
  function loadCardArt() {
    CARD_ART_IDS.forEach((id) => {
      const img = new Image();
      img.onload = () => {
        CARD_ART[id] = true;
        if (UI.game && UI.screen === 'game') {
          if (PVP.projection) renderPvpHand();
          else renderHand();
        }
      };
      img.onerror = () => { CARD_ART[id] = false; };
      img.src = assetUrl('card', id);
    });
  }

  const SCREENS = {
    auth: 'screen-auth', lobby: 'screen-lobby', faction: 'screen-faction', game: 'screen-game',
    results: 'screen-results', leaderboard: 'screen-leaderboard', pvpLobby: 'screen-pvp-lobby',
  };

  const UI = {
    screen: 'auth',
    account: null,
    stats: null,
    activeRun: null,
    activeSave: null,
    daily: null,
    leaderboardMode: 'daily',
    game: null,
    runId: null,
    saveId: null,
    revision: 0,
    mode: 'daily',
    quickFaction: 'rust',
    newRaceMode: 'race',
    helpOpen: false,
    helpFrom: 'lobby',
    onboardingStep: 0,
    authMode: 'login',
    busy: false,
    stage: 'idle',
    loopGen: 0,
    humanResolve: null,
    turnEnding: false,
    highlightTargets: [],
    highlightRouteNodes: [],
    modalClose: null,
    resultsShownFor: null,
    finalized: false,
    dirty: false,
    autosaveTimer: null,
    logCollapsed: false,
    camMode: 'follow',   // 'follow' | 'overview'
    camZoom: 3.6,        // вертикальный масштаб окна слежения
    showHp: false,       // постоянные HP-цифры (по умолчанию только по наведению)
    view: { x: 0, y: 0, w: 1000, h: 784 },
    camAnim: null,
    miniKey: null,
  };
  root.__CnA_WEB__ = UI;

  /* Справочник по фракциям для экрана выбора и вкладки «Фракции». */
  const FACTION_INFO = {
    chrome: {
      role: 'Дикий огонь · риск',
      strengths: 'Два раза за гонку следующий выстрел не даёт отдачи. 5 слотов под улучшения.',
      weakness: '18 корпусов — один из самых хрупких. Wildfire помогает темпу, но не броне.',
      tip: 'Трать Wildfire на ключевой выстрел, а не на первый попавшийся.',
    },
    rust: {
      role: 'Танк · ремонт',
      strengths: '22 корпуса. Пит-стоп на ход короче, а раз за гонку можно починить d4 корпуса на ходу.',
      weakness: 'Всего 4 слота и медленный разгон.',
      tip: 'Держись ближе к пит-лейну: ремонт — твоё главное оружие.',
    },
    carnival: {
      role: 'Ловушки · контроль',
      strengths: 'Первую ловушку в ход ставит бесплатно, не тратя фазу огня. Раз за гонку возвращает мину в руку.',
      weakness: '22 корпуса и мало прямого урона.',
      tip: 'Ставь ловушки на пути лидера — пусть сам в них въедет.',
    },
    swarm: {
      role: 'Дальний бой',
      strengths: 'Дальность всего оружия +1. Урон по лидеру гонки +2.',
      weakness: '18 корпусов — в ближнем бою не выживает.',
      tip: 'Держи дистанцию и бей по лидеру.',
    },
  };

  const LS_ONBOARD = 'cna.onboarding.v1';
  const LS_HINTS = 'cna.hints.v1';
  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  /* ------------------------------------------------------------------ */
  /* Утилиты                                                            */
  /* ------------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function faction(id) { return CnA.faction(id); }
  /* Путь к ассету относительно корня статики (index.html). Файл может отсутствовать —
     фолбэк-контракт: <img onerror> → глиф/SVG, CSS background → градиент. */
  function assetUrl(kind, id, part) {
    if (kind === 'bg') return 'assets/bg/' + id + '.png';
    if (kind === 'faction') return 'assets/factions/' + id + '/' + (part || 'portrait') + '.png';
    if (kind === 'card') return 'assets/cards/arsenal/' + id + '.png';
    return '';
  }
  function humanCar() { return UI.game ? UI.game.cars.find((c) => c.human) || null : null; }
  function currentCar() { return UI.game && UI.game.race ? CnA.currentCar(UI.game) : null; }
  function isHumanTurn() { const c = currentCar(); return !!c && c.human && !UI.busy; }

  function showScreen(name) {
    UI.screen = name;
    $$('.screen').forEach((s) => s.classList.remove('active'));
    const el = $('#' + SCREENS[name]);
    if (el) el.classList.add('active');
    window.scrollTo(0, 0);
  }

  function modal(html, setup) {
    return new Promise((resolve) => {
      const rootEl = $('#modal-root');
      rootEl.innerHTML =
        '<div class="modal-backdrop" data-backdrop></div>' +
        '<div class="modal"><button class="modal-close" data-close aria-label="Закрыть">×</button>' + html + '</div>';
      rootEl.classList.add('open');
      let done = false;
      const close = (val) => {
        if (done) return;
        done = true;
        rootEl.classList.remove('open');
        rootEl.innerHTML = '';
        UI.modalClose = null;
        resolve(val);
      };
      UI.modalClose = close;
      rootEl.querySelector('[data-backdrop]').addEventListener('click', () => close(null));
      rootEl.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
      if (setup) setup(rootEl, close);
    });
  }

  function showToast(text, kind, ms) {
    const zone = $('#toast-zone');
    if (!zone) return;
    const div = document.createElement('div');
    div.className = 'toast ' + (kind || '');
    div.innerHTML = text;
    zone.appendChild(div);
    while (zone.children.length > 3) zone.removeChild(zone.firstChild);
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, ms || 2000);
  }

  /* ------------------------------------------------------------------ */
  /* Сериализация SaveState (docs/06-web-api.md §5.1)                    */
  /* ------------------------------------------------------------------ */
  function toSaveState(game) {
    const { rng, quiet, ...engine } = game;
    return {
      schemaVersion: 1,
      engineVersion: CnA.VERSION,
      seed: game.seed,
      mode: game.mode,
      raceIndex: game.raceIndex,
      stage: game.stage,
      nextUid: CnA.getUidCounter(),
      savedAt: new Date().toISOString(),
      engine,
    };
  }
  function fromSaveState(s) {
    const game = s.engine;
    game.rng = CnA.mulberry32(s.seed + s.raceIndex * 1013 + 7);
    CnA.setUidCounter(s.nextUid);
    return game;
  }

  /* ------------------------------------------------------------------ */
  /* Результат для финализации                                          */
  /* ------------------------------------------------------------------ */
  function buildResult() {
    const game = UI.game;
    const human = game.cars.find((c) => c.human) || game.cars[0];
    const rows = game.results ? game.results.rows : [];
    const row = rows.find((r) => r.carId === human.id) || null;
    const standings = (game.results && game.results.standings)
      ? game.results.standings.map((s) => ({
          place: s.place, faction: s.factionId, name: s.name, cp: s.cp,
          damage: s.damage, kills: s.kills, scrap: s.scrap,
          human: !!(game.cars.find((c) => c.id === s.carId) || {}).human,
        }))
      : CnA.computeStandings(game).map((s) => ({
          place: s.place, faction: s.factionId, name: s.name, cp: s.cp,
          damage: s.damage, kills: s.kills, scrap: s.scrap,
          human: !!(game.cars.find((c) => c.id === s.carId) || {}).human,
        }));
    return {
      score: human.cp,
      detail: {
        pos: row ? row.pos : 1,
        finished: row ? !!row.finished : true,
        damage: row ? row.damage : (human.raceDamage || 0),
        kills: row ? row.kills : (human.raceKills || 0),
        scrap: human.scrap,
      },
      standings,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Сохранение / автосохранение                                        */
  /* ------------------------------------------------------------------ */
  function setSaveStatus(state, text) {
    const el = $('#save-status');
    if (!el) return;
    el.className = 'save-status ' + state;
    el.textContent = text || { pending: '…', saving: 'сохранение…', saved: 'сохранено', error: 'ошибка' }[state] || '';
  }

  async function doSave(opts) {
    opts = opts || {};
    if (!UI.saveId || !UI.game) return null;
    setSaveStatus('saving');
    const state = toSaveState(UI.game);
    const payload = { revision: UI.revision, state, status: opts.finalize ? 'finished' : 'active' };
    if (opts.finalize) payload.result = buildResult();

    const put = async (p) => {
      try {
        return await API.putSave(UI.saveId, p);
      } catch (e) {
        if (e.code === 'stale_revision') {
          const latest = await API.getSave(UI.saveId);
          UI.revision = latest.save.revision;
          p.revision = UI.revision;
          return await API.putSave(UI.saveId, p);
        }
        throw e;
      }
    };

    try {
      const res = await put(payload);
      UI.revision = res.revision != null ? res.revision : UI.revision;
      UI.dirty = false;
      setSaveStatus('saved');
      return res;
    } catch (e) {
      setSaveStatus('error');
      return null;
    }
  }

  function scheduleAutosave() {
    UI.dirty = true;
    setSaveStatus('pending');
    if (UI.autosaveTimer) clearTimeout(UI.autosaveTimer);
    UI.autosaveTimer = setTimeout(() => { UI.autosaveTimer = null; doSave(); }, 1200);
  }

  function flushAutosave() {
    if (UI.autosaveTimer) { clearTimeout(UI.autosaveTimer); UI.autosaveTimer = null; }
    if (UI.dirty && UI.saveId && UI.game) doSave();
  }

  /* ------------------------------------------------------------------ */
  /* Старт / продолжение заезда                                         */
  /* ------------------------------------------------------------------ */
  function cancelLoop() {
    UI.loopGen++;
    if (UI.humanResolve) { const r = UI.humanResolve; UI.humanResolve = null; r(); }
    UI.busy = false;
  }

  async function startNewRun(runMode, factionId, opts) {
    opts = opts || {};
    cancelLoop();
    const seed = opts.seed !== undefined ? (Number(opts.seed) >>> 0) : (Math.floor(Math.random() * 4294967295));
    const trackKind = opts.trackKind === 'ring' ? 'ring' : 'mosaic';
    const trackSize = opts.trackSize || (trackKind === 'mosaic' ? 36 : 28);
    const laps = opts.laps === 2 ? 2 : 1;

    const game = CnA.createGame({ mode: 'race', humanFaction: factionId, seed, laps, trackKind, trackSize });
    if (runMode === 'daily') game.mode = 'daily';

    const payload = { mode: runMode, faction: factionId, trackKind, trackSize, laps, seed };
    if (runMode === 'daily' && UI.daily) payload.dailyDate = UI.daily.date;

    let run, save;
    try {
      const created = await API.startRun(payload);
      run = created.run; save = created.save;
    } catch (e) {
      showToast('Не удалось начать заезд: ' + esc(e.message), 'damage', 3200);
      return;
    }

    UI.runId = run.id;
    UI.saveId = save.id;
    UI.revision = save.revision || 0;
    UI.mode = runMode;
    UI.game = game;
    UI.finalized = false;
    UI.resultsShownFor = null;
    UI.dirty = false;

    showScreen('game');
    renderAll();
    await doSave();
    await maybeShowRaceHint();
    raceLoop();
  }

  async function startDaily() {
    if (!UI.daily) { loadDaily(); return; }
    const c = UI.daily.challenge;
    await startNewRun('daily', c.faction, { seed: c.seed, trackKind: c.trackKind, trackSize: c.trackSize, laps: c.laps });
  }

  async function startRace() {
    await startNewRun('race', UI.quickFaction, { trackKind: 'mosaic', trackSize: 36, laps: 1 });
  }

  async function continueRun() {
    cancelLoop();
    if (!UI.activeSave) return;
    let data;
    try {
      data = await API.getSave(UI.activeSave.id);
    } catch (e) {
      showToast('Не удалось загрузить партию: ' + esc(e.message), 'damage', 3200);
      return;
    }
    if (!data || !data.save || data.save.state == null) {
      showToast('Сохранение пусто (первое сохранение не прошло) — начни новый заезд.', 'damage', 3600);
      backToLobby();
      return;
    }
    const game = fromSaveState(data.save.state);
    UI.game = game;
    UI.runId = data.save.runId;
    UI.saveId = data.save.id;
    UI.revision = data.save.revision;
    UI.mode = game.mode === 'daily' ? 'daily' : 'race';
    UI.finalized = false;
    UI.resultsShownFor = null;
    UI.dirty = false;
    showScreen('game');
    renderAll();
    if (UI.game.race && UI.game.race.over) showResults();
    else raceLoop();
  }

  function abandonRun() {
    if (!UI.saveId) return backToLobby();
    const id = UI.saveId;
    cancelLoop();
    UI.game = null;
    backToLobby();
    API.deleteSave(id).catch(() => {});
  }

  function backToLobby() {
    cancelLoop();
    UI.game = null;
    UI.runId = null;
    UI.saveId = null;
    UI.revision = 0;
    UI.finalized = false;
    renderLobby();
    showScreen('lobby');
  }

  /* ------------------------------------------------------------------ */
  /* Главный цикл                                                       */
  /* ------------------------------------------------------------------ */
  async function raceLoop() {
    const gen = UI.loopGen;
    while (gen === UI.loopGen && UI.game && UI.game.race && !UI.game.race.over) {
      if (UI.helpOpen) { await sleep(200); continue; }
      const started = CnA.beginTurn(UI.game);
      renderAll();
      if (started.skip) {
        const why = started.reason === 'pit' ? 'пит-стоп' :
          started.reason === 'destroyed' ? 'ремонт после уничтожения' :
          started.reason === 'burned' ? 'пожар' : 'пропуск';
        showToast(esc(started.car ? started.car.name : 'Гонщик') + ' пропускает ход (' + why + ').', 'event', 1400);
        await sleep(600);
        if (gen !== UI.loopGen) return;
        if (UI.game.race.over) break;
        CnA.endTurn(UI.game);
        renderAll();
        scheduleAutosave();
        continue;
      }
      if (started.car.human) {
        UI.stage = UI.game.race.phase;
        renderAll();
        await new Promise((res) => { UI.humanResolve = res; });
        if (gen !== UI.loopGen) return;
        if (UI.game.race.over) break;
      } else {
        UI.stage = 'ai';
        renderAll();
        await aiTurn(started.car);
        if (gen !== UI.loopGen) return;
        if (UI.game.race.over) break;
      }
    }
    if (UI.game && UI.game.race && UI.game.race.over) showResults();
  }

  function finishTurn() {
    if (!UI.game || !UI.game.race || UI.turnEnding) return;
    UI.turnEnding = true;
    const end = CnA.endTurn(UI.game);
    UI.busy = false;
    UI.stage = UI.game.race.phase;
    renderAll();
    scheduleAutosave();
    const res = UI.humanResolve;
    UI.humanResolve = null;
    if (res) res();
    UI.turnEnding = false;
    if (end.raceOver) showResults();
  }

  /* ------------------------------------------------------------------ */
  /* Ход человека                                                       */
  /* ------------------------------------------------------------------ */
  function humanReady() {
    const car = currentCar();
    return car && car.human && !UI.busy && UI.game && !UI.game.race.over;
  }

  async function rollAndMaybeReroll(car) {
    const res = CnA.rollMove(UI.game, car);
    if (!res.ok || res.destroyed || car.flags.rerollUsed || UI.game.race.turn.brake) return res;
    showDice(res.roll, res.total, res.mods, res.nitroRoll);
    renderAll();
    const choice = await modal(
      '<h3>ПЕРЕБРОС d4</h3><p>Выпало <b>' + res.roll + '</b> → движение <b>' + res.total + '</b>. ' +
      'Можно один раз за гонку перебросить кубик.</p>' +
      '<div class="target-list">' +
      '<button class="target-btn" data-keep><b>Оставить ' + res.roll + '</b><span>движение ' + res.total + '</span></button>' +
      '<button class="target-btn" data-reroll><b>Перебросить d4</b><span>один раз за гонку</span></button>' +
      '</div>',
      (rootEl, close) => {
        rootEl.querySelector('[data-keep]').addEventListener('click', () => close(false));
        rootEl.querySelector('[data-reroll]').addEventListener('click', () => close(true));
      });
    if (!choice) return res;
    const rr = CnA.rerollMove(UI.game, car);
    if (!rr.ok) {
      showToast(esc(rr.reason || 'Нельзя перебросить'), 'damage');
      return res;
    }
    return Object.assign({}, res, rr, { mods: [] });
  }

  async function onRoll() {
    if (!humanReady() || UI.game.race.phase !== 'prep') return;
    const car = currentCar();
    UI.busy = true;
    UI.stage = 'move';
    const res = await rollAndMaybeReroll(car);
    if (!res) { UI.busy = false; renderAll(); return; }
    if (!res.ok) {
      UI.busy = false;
      showToast(esc(res.reason || 'Нельзя двигаться'), 'damage');
      renderAll();
      return;
    }
    showDice(res.roll, res.total, res.mods, res.nitroRoll);
    renderAll();
    await sleep(400);
    if (res.destroyed) {
      showToast('Перегрев уничтожил машину.', 'kill');
      await afterHumanMovement(car);
      return;
    }
    let guard = 0;
    while (guard++ < 14) {
      const opts = CnA.movementOptions(UI.game, car);
      if (!opts.length) break;
      let opt = opts[0];
      if (opts.length > 1) {
        const chosen = await chooseRoute(opts, car);
        if (chosen) opt = chosen;
        else break;
      }
      const step = CnA.stepMovement(UI.game, car, opt.node, opt.jump);
      UI.stage = 'move';
      renderAll();
      if (step.events) handleStepEvents(step, car);
      await sleep(240);
      if (!step.ok || step.stop) break;
    }
    await afterHumanMovement(car);
  }

  async function afterHumanMovement(car) {
    const fin = CnA.finishMovement(UI.game, car);
    if (fin && fin.event) showEvent(fin.event);
    renderAll();
    if (UI.game.race.over) { UI.busy = false; showResults(); return; }
    if (car.destroyed || car.finished) {
      UI.busy = false;
      UI.stage = 'done';
      renderAll();
      await sleep(450);
      finishTurn();
      return;
    }
    UI.busy = false;
    UI.stage = 'fire';
    renderAll();
  }

  function handleStepEvents(step, car) {
    (step.events || []).forEach((e) => {});
    if (step.ram) showToast('ТАРАН: ' + esc(step.ram.text || 'машины столкнулись'), 'damage', 2300);
    if (step.destroyed) showToast('Машина уничтожена. Возврат на контрольный пункт.', 'kill', 2200);
    if (step.finished) showToast('🏁 ' + esc(car.name) + ' финиширует!', 'lap', 2600);
  }

  async function chooseRoute(opts, car) {
    const curNode = UI.game.race.track.nodes[car.node];
    const rows = opts.map((o, i) => {
      const node = UI.game.race.track.nodes[o.node];
      const type = CnA.TILES[node.type] ? CnA.TILES[node.type].label : node.type;
      let label = 'Объезд';
      if (o.jump) label = 'Прыжок с трамплина';
      else if (node.pitLane) label = 'Пит-лейн';
      else if (curNode && curNode.pitEntry) label = 'Трасса';
      else if (node.inner) label = 'Короткий срез';
      return '<button class="target-btn" data-route="' + i + '">' +
        '<b>' + esc(label) + ' → ' + esc(type) + '</b>' +
        '<span>тайл ' + node.id + (o.jump ? ' · перелёт через ' + o.via : '') + '</span></button>';
    }).join('');
    const isPitChoice = !!(curNode && curNode.pitEntry);
    const res = await modal(
      '<h3>' + (isPitChoice ? 'ПИТ-ЛЕЙН' : 'РАЗВИЛКА') + '</h3><p>Осталось <b>' +
      (UI.game.race.turn ? UI.game.race.turn.remaining : 0) + '</b> движения. Выбери маршрут.</p>' +
      '<div class="target-list">' + rows + '</div>',
      (rootEl, close) => {
        $$('[data-route]', rootEl).forEach((b) => b.addEventListener('click', () => close(opts[Number(b.dataset.route)])));
      });
    return res || null;
  }

  function onPrepCard(uid) {
    if (!humanReady() || UI.game.race.phase !== 'prep') return;
    const car = currentCar();
    const r = CnA.playPrep(UI.game, car, uid);
    if (!r.ok) { showToast(esc(r.reason), 'damage'); return; }
    showToast(esc(r.text), 'event', 1800);
    renderAll();
  }

  async function onPit() {
    if (!humanReady()) return;
    const car = currentCar();
    const r = CnA.startPit(UI.game, car);
    if (!r.ok) { showToast(esc(r.reason), 'damage'); return; }
    showToast('Пит-стоп: +' + r.heal + ' корпуса.', 'event', 2200);
    UI.busy = true;
    renderAll();
    await sleep(700);
    finishTurn();
  }

  function onRustRepair() {
    if (!humanReady()) return;
    const r = CnA.useRustRepair(UI.game, currentCar());
    if (!r.ok) { showToast(esc(r.reason), 'damage'); return; }
    showToast('«Латаем на ходу»: +' + r.heal + ' корпуса.', 'event');
    renderAll();
  }

  function onWildfire() {
    if (!humanReady()) return;
    const r = CnA.armWildfire(UI.game, currentCar());
    if (!r.ok) { showToast(esc(r.reason), 'damage'); return; }
    showToast(r.armed ? '«Дикий огонь»: следующий выстрел без отдачи.' : '«Дикий огонь» отменён.', 'event', 1800);
    renderAll();
  }

  function onReroll() {
    if (!humanReady() || UI.game.race.phase !== 'move') return;
    const car = currentCar();
    const r = CnA.rerollMove(UI.game, car);
    if (!r.ok) { showToast(esc(r.reason || 'Нельзя перебросить'), 'damage'); return; }
    showDice(r.roll, r.total, [], 0);
    renderAll();
  }

  function onReturnMine() {
    if (!humanReady()) return;
    const r = CnA.returnMine(UI.game, currentCar());
    if (!r.ok) { showToast(esc(r.reason), 'damage'); return; }
    showToast('Мина возвращена в руку.', 'event');
    renderAll();
  }

  function onTurbo() {
    if (!humanReady()) return;
    const r = CnA.armTurbo(UI.game, currentCar());
    if (!r.ok) { showToast(esc(r.reason), 'damage'); return; }
    showToast('Турбина взведена.', 'event');
    renderAll();
  }

  function onHandCard(uid) {
    if (!UI.game || UI.busy) return;
    const car = currentCar();
    if (!car || !car.human) return;
    const h = car.hand.find((c) => c.uid === uid);
    if (!h) return;
    const card = CnA.CARDS[h.type];
    if (card.phase === 'prep') { onPrepCard(uid); return; }
    if (card.phase === 'reaction') {
      showToast('«' + card.name + '» срабатывает автоматически.', 'event', 2200);
      return;
    }
    if (UI.game.race.phase !== 'fire') { showToast('Атака возможна только в фазе огня.', 'damage'); return; }
    if (!CnA.cardPlayable(UI.game, car, uid)) { showToast('Сейчас эту карту сыграть нельзя.', 'damage'); return; }
    if (card.kind === 'trap') { doTrap(car, h); return; }
    doAttack(car, h);
  }

  async function doAttack(car, h) {
    const card = CnA.CARDS[h.type];
    const targets = CnA.attackTargets(UI.game, car, h.type);
    if (!targets.length) { showToast('Нет целей в радиусе.', 'damage'); return; }
    UI.highlightTargets = targets.map((t) => t.carId);
    renderBoard();

    if (h.type === 'twin') {
      const t1 = await chooseTarget(card, targets, car, 'Спаренный пулемёт · цель 1');
      if (t1 == null) { UI.highlightTargets = []; renderBoard(); return; }
      const rest = targets.filter((t) => t.carId !== t1);
      const t2 = await chooseTarget(card, rest, car, 'Спаренный пулемёт · цель 2');
      if (t2 == null) { UI.highlightTargets = []; renderBoard(); return; }
      UI.highlightTargets = [];
      const res = CnA.playTwin(UI.game, car, h.uid, [t1, t2]);
      if (!res.ok) showToast(esc(res.reason || 'Не удалось'), 'damage');
      else showToast('Спаренный пулемёт: две очереди.', 'attack', 1800);
      renderAll();
      return;
    }

    const targetId = await chooseTarget(card, targets, car);
    UI.highlightTargets = [];
    renderBoard();
    if (targetId == null) { renderAll(); return; }
    const target = CnA.carById(UI.game, targetId);
    const res = CnA.playAttack(UI.game, car, h.uid, targetId);
    if (!res.ok) { showToast(esc(res.reason || 'Атака не удалась'), 'damage'); renderAll(); return; }
    if (res.jammed) showToast('Глушилка! Атака отменена.', 'event');
    else {
      showToast(esc(card.name) + ' → ' + esc(target.name) + ': ' + res.damage + ' урона.', 'attack', 1800);
      if (res.destroyed) showToast(esc(target.name) + ' уничтожена!', 'kill', 2400);
    }
    renderAll();
    if (UI.game.race.over) showResults();
  }

  async function doTrap(car, h) {
    const card = CnA.CARDS[h.type];
    const opts = CnA.trapOptions(UI.game, car, h.uid);
    if (!opts.length) { showToast('Нет места для ловушки.', 'damage'); return; }
    const rows = opts.map((o) => {
      const node = UI.game.race.track.nodes[o.node];
      const t = CnA.TILES[node.type] ? CnA.TILES[node.type].label : node.type;
      return '<button class="target-btn" data-node="' + o.node + '">' +
        '<b>' + (o.own ? 'Свой тайл' : 'Тайл позади') + ' · ' + esc(t) + '</b>' +
        '<span>тайл ' + node.id + '</span></button>';
    }).join('');
    const nodeId = await modal(
      '<h3>' + esc(card.name) + '</h3><p>' + esc(card.text) + '</p>' +
      '<div class="target-list">' + rows + '</div>',
      (rootEl, close) => {
        $$('[data-node]', rootEl).forEach((b) => b.addEventListener('click', () => close(Number(b.dataset.node))));
      });
    if (nodeId == null) return;
    const res = CnA.placeTrap(UI.game, car, h.uid, nodeId);
    if (!res.ok) showToast(esc(res.reason || 'Не удалось поставить'), 'damage');
    else showToast(esc(card.name) + ' на тайле ' + nodeId + (res.free ? ' — бесплатно.' : '.'), 'trap', 1800);
    renderAll();
  }

  async function chooseTarget(card, targets, car, label) {
    const rows = targets.map((t) => {
      const target = CnA.carById(UI.game, t.carId);
      const dir = t.dir === 'fwd' ? 'вперёд' : 'назад';
      const avg = card.dmg === 'd4' ? 2.5 : card.dmg === '2d4' ? 5 : card.dmg === '3d4' ? 7.5 : 0;
      const valText = card.noDamage ? 'эффект' : '≈' + (Math.round(avg * 10) / 10).toFixed(1).replace('.', ',') + ' урона';
      return '<button class="target-btn" data-target="' + t.carId + '">' +
        '<b>' + esc(target.name) + '</b>' +
        '<span>' + dir + ' · ' + t.dist + (t.dist === 1 ? ' тайл' : ' тайла') + ' · корпус ' + target.hp + '/' + target.maxHp +
        ' · <span class="tval">' + valText + '</span></span></button>';
    }).join('');
    return modal(
      '<h3>' + esc(label || card.name) + '</h3><p>Выбери цель.</p>' +
      '<div class="target-list">' + rows + '</div>' +
      '<div class="modal-actions"><button class="act-btn ghost" data-close>ОТМЕНА</button></div>',
      (rootEl, close) => {
        $$('[data-target]', rootEl).forEach((b) => b.addEventListener('click', () => close(Number(b.dataset.target))));
      });
  }

  /* ------------------------------------------------------------------ */
  /* Ход ИИ                                                             */
  /* ------------------------------------------------------------------ */
  async function aiTurn(car) {
    UI.busy = true;
    UI.stage = 'ai';
    renderAll();
    // Темп настольного прототипа: паузы ИИ ×0.55 (board pacing).
    const pause = (ms) => sleep(ms * 0.55);
    await pause(420);

    const prep = CnA.aiChoosePrep(UI.game, car);
    if (prep.type === 'pit') {
      CnA.startPit(UI.game, car);
      renderAll();
      await pause(500);
      UI.busy = false;
      finishTurn();
      return;
    }
    if (prep.type === 'card') { CnA.playPrep(UI.game, car, prep.uid); renderAll(); await pause(300); }
    else if (prep.type === 'rust') { CnA.useRustRepair(UI.game, car); renderAll(); await pause(260); }
    else if (prep.type === 'turbo') { CnA.armTurbo(UI.game, car); renderAll(); await pause(220); }
    else if (prep.type === 'returnMine') { CnA.returnMine(UI.game, car); renderAll(); await pause(220); }
    if (car.destroyed || car.finished) { UI.busy = false; finishTurn(); return; }

    const roll = CnA.rollMove(UI.game, car);
    if (!roll.ok) { UI.busy = false; finishTurn(); return; }
    showDice(roll.roll, roll.total, roll.mods, roll.nitroRoll);
    renderAll();
    await pause(420);
    if (car.destroyed) { UI.busy = false; finishTurn(); return; }

    let guard = 0;
    while (guard++ < 16) {
      const opts = CnA.movementOptions(UI.game, car);
      if (!opts.length) break;
      const opt = CnA.aiChooseStep(UI.game, car, opts);
      const step = CnA.stepMovement(UI.game, car, opt.node, opt.jump);
      renderAll();
      if (step.events) handleStepEvents(step, car);
      await pause(260);
      if (!step.ok || step.stop) break;
    }
    const fin = CnA.finishMovement(UI.game, car);
    if (fin && fin.event) showEvent(fin.event);
    renderAll();
    await pause(380);
    if (car.destroyed || car.finished) { UI.busy = false; finishTurn(); return; }

    guard = 0;
    while (guard++ < 4) {
      const action = CnA.aiChooseFire(UI.game, car);
      if (!action) break;
      let res;
      if (action.type === 'attack') res = CnA.playAttack(UI.game, car, action.uid, action.targetId);
      else if (action.type === 'twin') res = CnA.playTwin(UI.game, car, action.uid, action.targets);
      else if (action.type === 'trap') res = CnA.placeTrap(UI.game, car, action.uid, action.node);
      if (!res || !res.ok) break;
      renderAll();
      await pause(420);
      if (UI.game.race.over) break;
      if (UI.game.race.turn && UI.game.race.turn.fireUsed) break;
    }
    UI.busy = false;
    if (UI.game.race.over) { showResults(); return; }
    finishTurn();
  }

  /* ------------------------------------------------------------------ */
  /* Рендер                                                             */
  /* ------------------------------------------------------------------ */
  function renderAll() {
    if (!UI.game) return;
    renderMeta();
    renderBoard();
    renderPlayers();
    renderTurnCard();
    renderPhaseStrip();
    renderHand();
    renderLog();
  }

  /* ------------------------------------------------------------------ */
  /* Камера: слежение за активной машиной / обзор всей трассы            */
  /* ------------------------------------------------------------------ */
  function activeCamCar() {
    const game = UI.game;
    if (!game || !game.race) return null;
    return CnA.currentCar(game) || null;
  }

  function cameraTarget() {
    const full = { x: 0, y: 0, w: 1000, h: 784 };
    if (UI.camMode === 'overview') return full;
    const car = activeCamCar();
    const track = UI.game && UI.game.race && UI.game.race.track;
    if (!car || !track || !track.nodes[car.node]) return full;
    const nodes = track.nodes;
    const n = nodes[car.node];
    const z = UI.camZoom;
    /* Окно камеры подстраивается под пропорции панели доски, чтобы не было
       горизонтальных полос (preserveAspectRatio meet) и тайлы были крупнее. */
    const boardEl = $('#board');
    const br = boardEl ? boardEl.getBoundingClientRect() : null;
    const aspect = br && br.width && br.height ? br.width / br.height : 1000 / 784;
    let h = 784 / z;
    let w = h * aspect;
    if (w > 1000) { w = 1000; h = w / aspect; }
    if (h > 784) { h = 784; w = h * aspect; }
    // смещаем центр вперёд по трассе — видно, куда едешь
    let cx = n.x;
    let cy = n.y;
    const nx = n.next && n.next.length ? nodes[n.next[0]] : null;
    if (nx) { cx = n.x + (nx.x - n.x) * 0.35; cy = n.y + (nx.y - n.y) * 0.35; }
    const x = Math.max(0, Math.min(1000 - w, cx - w / 2));
    const y = Math.max(0, Math.min(784 - h, cy - h / 2));
    return { x, y, w, h };
  }

  function setViewBox(v) {
    UI.view = v;
    const svg = $('#board');
    if (svg) svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
    const mini = $('#minimap');
    if (mini) {
      const r = mini.querySelector('.mm-view');
      if (r) {
        r.setAttribute('x', v.x);
        r.setAttribute('y', v.y);
        r.setAttribute('width', v.w);
        r.setAttribute('height', v.h);
      }
    }
  }

  function updateCamera(animate) {
    const target = cameraTarget();
    if (UI.camAnim) { cancelAnimationFrame(UI.camAnim); UI.camAnim = null; }
    if (!animate) { setViewBox(target); return; }
    const from = { x: UI.view.x, y: UI.view.y, w: UI.view.w, h: UI.view.h };
    const t0 = performance.now();
    const dur = 240;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setViewBox({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        w: from.w + (target.w - from.w) * e,
        h: from.h + (target.h - from.h) * e,
      });
      if (k < 1) UI.camAnim = requestAnimationFrame(step);
      else UI.camAnim = null;
    };
    UI.camAnim = requestAnimationFrame(step);
  }

  function setCamMode(mode) {
    UI.camMode = mode;
    const btn = $('#cam-toggle');
    if (btn) btn.textContent = mode === 'follow' ? 'Следить' : 'Обзор';
    // В обзоре миникарта избыточна — прячем, чтобы не дублировать карту.
    const mini = $('#minimap');
    if (mini) mini.style.display = mode === 'overview' ? 'none' : '';
    updateCamera(true);
  }

  function toggleCamera() { setCamMode(UI.camMode === 'follow' ? 'overview' : 'follow'); }

  function setCamZoom(z) {
    UI.camZoom = Math.max(1.8, Math.min(4.5, z));
    UI.camMode = 'follow';
    const btn = $('#cam-toggle');
    if (btn) btn.textContent = 'Следить';
    const mini = $('#minimap');
    if (mini) mini.style.display = '';
    updateCamera(true);
  }

  function renderMeta() {
    const game = UI.game;
    if (!game || !game.race) return;
    const leader = CnA.raceLeader(game);
    const lf = leader ? faction(leader.factionId) : null;
    const atStart = !game.race.stats || game.race.stats.turns === 0;
    const totalPath = game.laps * game.race.track.count;
    const modeLabel = game.mode === 'daily' ? 'ЕЖЕДНЕВНЫЙ' : 'СВОБОДНЫЙ';
    $('#game-mode-label').textContent = game.mode === 'daily' ? 'ежедневный' : 'свободный';
    $('#race-meta').innerHTML =
      '<span class="pill">' + modeLabel + '</span>' +
      '<span>раунд <b>' + game.race.round + '</b></span>' +
      '<span>кругов <b>' + game.laps + '</b></span>' +
      '<span>сид <b>' + game.seed + '</b></span>';
    $('#track-label').textContent = game.race.track.label || (game.race.track.count + ' тайлов');
    $('#leader-label').innerHTML = lf
      ? 'ЛИДЕР: <b style="color:' + lf.color + '">' + esc(leader.name) + '</b> · ' +
        (atStart ? 'на старте' : Math.round(CnA.progressOf(game, leader)) + ' из ' + totalPath + ' тайлов')
      : 'ЛИДЕР: —';
  }

  function hexPoints(cx, cy, size) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k - 30);
      pts.push((cx + size * Math.cos(a)).toFixed(1) + ',' + (cy + size * Math.sin(a)).toFixed(1));
    }
    return pts.join(' ');
  }
  function starPoints(cx, cy, r) {
    const pts = [];
    for (let k = 0; k < 12; k++) {
      const rr = k % 2 === 0 ? r : r * 0.42;
      const a = -Math.PI / 2 + k * Math.PI / 6;
      pts.push((cx + rr * Math.cos(a)).toFixed(1) + ',' + (cy + rr * Math.sin(a)).toFixed(1));
    }
    return pts.join(' ');
  }
  function carOffsets(count) {
    if (count <= 1) return [[0, 0]];
    if (count === 2) return [[-14, 0], [14, 0]];
    if (count === 3) return [[-16, -10], [16, -10], [0, 14]];
    return [[-17, -15], [17, -15], [-17, 15], [17, 15]];
  }

  /* Фигурка машины: цветной корпус фракции, тёмные детали, подставка.
     HP показывается по наведению или тумблером «HP» (не постоянной табличкой). */
  function carFigure(c, f, isCur, isTarget) {
    const INK = '#241f1a';     // пустошь-чёрный — контур
    const NIGHT = '#0b0f12';   // пепел-ночь — силуэт
    const accent = f.color;    // хром / полымя / неон / латунь
    const low = c.hp / c.maxHp <= 0.35;
    let s = '';

    // Миниатюрная подставка (как у фигурки): мягкая тень, диск, цветной обод.
    s += '<ellipse cx="0" cy="8" rx="24" ry="7" fill="rgba(0,0,0,.55)"/>';
    s += '<ellipse cx="0" cy="3" rx="21" ry="8" fill="#1a1512" stroke="' + INK + '" stroke-width="2"/>';
    s += '<ellipse cx="0" cy="1" rx="17" ry="6" fill="' + accent + '" opacity=".30" stroke="' + INK + '" stroke-width="1.2"/>';
    s += '<ellipse cx="0" cy="0" rx="11" ry="3.8" fill="' + NIGHT + '" opacity=".55"/>';

    const useMini = !!MINI[f.id];
    const ang = carAngle(c);
    if (useMini) {
      // Только влево/вправо, без поворотов и вертикальных отражений.
      const wantRight = Math.cos(ang * Math.PI / 180) >= 0;
      const mirror = (wantRight === !!FRONT_RIGHT[f.id]) ? 1 : -1;
      s += '<g transform="scale(' + mirror + ',1)"><image class="car-mini" href="' + assetUrl('faction', f.id, 'mini') + '" x="-28" y="-50" width="56" height="56" preserveAspectRatio="xMidYMid meet"/></g>';
    } else {
    // корпус-силуэт
    s += '<g transform="translate(0,-10)">';
    if (f.id === 'chrome') {
      s += '<polygon points="-20,7 -14,-7 2,-12 16,-8 20,1 20,7" fill="' + accent + '" stroke="' + INK + '" stroke-width="2.6" stroke-linejoin="round"/>';
      s += '<line x1="-20" y1="-2" x2="20" y2="-4" stroke="' + NIGHT + '" stroke-width="1.6"/>';
      s += '<circle cx="-12" cy="9" r="6.5" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.4"/><circle cx="-12" cy="9" r="2.3" fill="' + accent + '"/>';
      s += '<circle cx="13" cy="9" r="6.5" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.4"/><circle cx="13" cy="9" r="2.3" fill="' + accent + '"/>';
    } else if (f.id === 'rust') {
      s += '<rect x="-17" y="-12" width="34" height="19" fill="' + accent + '" stroke="' + INK + '" stroke-width="2.6"/>';
      s += '<rect x="-14" y="-8" width="12" height="8" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="1.4"/>';
      s += '<rect x="-21" y="-16" width="4" height="6" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="1.4"/>';
      s += '<circle cx="-12" cy="9" r="7" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.4"/><circle cx="-12" cy="9" r="2.5" fill="' + accent + '"/>';
      s += '<circle cx="13" cy="9" r="7" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.4"/><circle cx="13" cy="9" r="2.5" fill="' + accent + '"/>';
    } else if (f.id === 'carnival') {
      s += '<rect x="-15" y="-20" width="30" height="27" fill="' + accent + '" stroke="' + INK + '" stroke-width="2.6"/>';
      s += '<rect x="-15" y="-20" width="30" height="4" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="1.2"/>';
      s += '<polygon points="-5,-20 5,-20 0,-30" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="1.6"/>';
      s += '<circle cx="-9" cy="9" r="6.5" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.2"/><circle cx="-9" cy="9" r="2.3" fill="' + accent + '"/>';
      s += '<circle cx="10" cy="9" r="6.5" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.2"/><circle cx="10" cy="9" r="2.3" fill="' + accent + '"/>';
    } else {
      s += '<path d="M -22,-6 L -12,-12 L 10,-11 L 20,-5 L 14,3 L -12,5 L -22,0 Z" fill="' + accent + '" stroke="' + INK + '" stroke-width="2.6" stroke-linejoin="round"/>';
      s += '<polygon points="-26,-17 -18,-14 -24,-10" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="1.4"/>';
      s += '<line x1="-22" y1="-3" x2="18" y2="-6" stroke="' + NIGHT + '" stroke-width="1.4"/>';
      s += '<circle cx="-12" cy="8" r="6.5" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2.2"/><circle cx="-12" cy="8" r="2.3" fill="' + accent + '"/>';
      s += '<circle cx="13" cy="6" r="5.5" fill="' + NIGHT + '" stroke="' + INK + '" stroke-width="2"/><circle cx="13" cy="6" r="1.8" fill="' + accent + '"/>';
    }
    // гранж-царапины
    s += '<path d="M -8,-12 L -3,-9 M 7,-7 L 13,-6 M -14,-2 L -9,0" stroke="rgba(216,216,210,.28)" stroke-width=".8" fill="none"/>';
    s += '</g>';

    // глиф фракции — крупно на корпусе
    s += '<text x="0" y="-6" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-size="19" fill="#f5f0e8" stroke="' + NIGHT + '" stroke-width="3" paint-order="stroke">' + esc(f.glyph) + '</text>';
    }

    // Стрелка направления на подставке: показывает, куда едет машина.
    {
      const rad = ang * Math.PI / 180;
      const ax = Math.cos(rad) * 22;
      const ay = Math.sin(rad) * 22 + 3;
      s += '<g transform="translate(' + ax + ',' + ay + ') rotate(' + ang + ')"><polygon points="-5,-4 4,0 -5,4" fill="#c8a04e" stroke="' + INK + '" stroke-width="1.2"/></g>';
    }

    // HP-чип: по наведению или при включённом тумблере «HP» (под фигуркой).
    s += '<g class="hp-chip' + (UI.showHp ? ' show' : '') + '" transform="translate(0,24)">';
    s += '<rect x="-15" y="-8" width="30" height="16" rx="3" fill="#0b0f12" stroke="' + (low ? '#9e1f1a' : accent) + '" stroke-width="1.8" opacity=".96"/>';
    s += '<text x="0" y="2.5" text-anchor="middle" font-family="Cascadia Mono, Consolas, monospace" font-size="10" fill="#f5f0e8">' + c.hp + '</text></g>';

    // статус-значки: иконка + цвет (не только цвет)
    const bubbles = [];
    if (c.shield > 0) bubbles.push(['◈', '#d8d8d2']);
    if (c.burn) bubbles.push(['▲', '#ff7a1e']);
    if (c.smoke) bubbles.push(['☁', '#b9b2a6']);
    if (c.emp) bubbles.push(['ϟ', '#f5f0e8']);
    if (c.pit) bubbles.push(['⚙', '#c8a04e']);
    bubbles.forEach((b, i) => {
      const bx = -24 + (i * 12);
      s += '<g transform="translate(' + bx + ',' + (useMini ? -56 : -20) + ')"><circle r="6.5" fill="' + NIGHT + '" opacity=".9"/><circle r="5.5" fill="' + b[1] + '" stroke="' + INK + '" stroke-width="1.6"/><text x="0" y="2" text-anchor="middle" font-size="8" fill="' + INK + '">' + b[0] + '</text></g>';
    });

    const ringR = useMini ? 32 : 22;
    if (isCur) s += '<circle cx="0" cy="-6" r="' + ringR + '" fill="none" stroke="#c8a04e" stroke-width="2.6" stroke-dasharray="5 3"/>';
    if (c.spawnProtect) s += '<circle cx="0" cy="-6" r="' + (ringR + 1) + '" fill="none" stroke="#d8d8d2" stroke-width="2.4" stroke-dasharray="4 3"/>';
    if (isTarget) {
      s += useMini
        ? '<circle cx="0" cy="-6" r="34" fill="none" stroke="#9e1f1a" stroke-width="3" stroke-dasharray="7 5"/>'
        : '<polygon points="0,-30 3,-20 14,-20 5,-12 8,-2 0,-8 -8,-2 -5,-12 -14,-20 -3,-20" fill="#9e1f1a" stroke="' + INK + '" stroke-width="2"/>';
    }
    if (c.finished) s += '<g transform="translate(0,' + (useMini ? -60 : -30) + ')"><line x1="0" y1="0" x2="0" y2="-12" stroke="' + INK + '" stroke-width="2"/><polygon points="0,-12 14,-8 0,-4" fill="#9e1f1a" stroke="' + INK + '" stroke-width="1.4"/></g>';

    return s;
  }

  function edgePoint(node, other, size) {
    const ang = Math.atan2(other.y - node.y, other.x - node.x);
    const ap = Math.sqrt(3) / 2 * size;
    return { x: node.x + Math.cos(ang) * ap, y: node.y + Math.sin(ang) * ap };
  }

  function roadMarkup(node, prev, next, size, pit) {
    const a = edgePoint(node, prev, size);
    const b = edgePoint(node, next, size);
    const border = size * 0.62;
    const asphalt = size * 0.47;
    const line = pit ? '#c8a04e' : '#f5f0e8';
    return '<path d="M ' + a.x + ' ' + a.y + ' Q ' + node.x + ' ' + node.y + ' ' + b.x + ' ' + b.y + '" fill="none" stroke="#241f1a" stroke-width="' + border + '" stroke-linecap="round"></path>' +
      '<path d="M ' + a.x + ' ' + a.y + ' Q ' + node.x + ' ' + node.y + ' ' + b.x + ' ' + b.y + '" fill="none" stroke="#2a2620" stroke-width="' + asphalt + '" stroke-linecap="round"></path>' +
      '<path d="M ' + a.x + ' ' + a.y + ' Q ' + node.x + ' ' + node.y + ' ' + b.x + ' ' + b.y + '" fill="none" stroke="' + line + '" stroke-width="1.5" stroke-dasharray="3 7" stroke-linecap="round"></path>';
  }

  function spurMarkup(node, other, size, pit) {
    const b = edgePoint(node, other, size);
    return '<path d="M ' + node.x + ' ' + node.y + ' L ' + b.x + ' ' + b.y + '" fill="none" stroke="' + (pit ? '#c8a04e' : '#d8d8d2') + '" stroke-width="' + (size * 0.22) + '" stroke-dasharray="5 5" stroke-linecap="round" opacity=".8"></path>';
  }

  function renderBoard() {
    const game = UI.game;
    if (!game || !game.race) return;
    const track = game.race.track;
    const nodes = track.nodes;
    const parts = [];

    parts.push('<defs>' +
      '<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#f5f0e8" opacity=".55"></path></marker>' +
      '<pattern id="checker" width="10" height="10" patternUnits="userSpaceOnUse">' +
      '<rect width="5" height="5" fill="#241f1a"/><rect x="5" y="5" width="5" height="5" fill="#241f1a"/>' +
      '<rect x="5" width="5" height="5" fill="#f5f0e8"/><rect y="5" width="5" height="5" fill="#f5f0e8"/>' +
      '</pattern>' +
      '<pattern id="hatch-danger" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<line x1="0" y1="0" x2="0" y2="7" stroke="#9e1f1a" stroke-width="2.6"/>' +
      '</pattern>' +
      '<pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse">' +
      '<circle cx="1.2" cy="1.2" r="0.8" fill="#0b0f12"/>' +
      '</pattern></defs>');

    // Светлый «стол» под трассой: группирует гексы и отделяет их от тёмного фона.
    if (track.ring && track.ring.length) {
      const ringPts = track.ring.map((i) => nodes[i].x + ',' + nodes[i].y).join(' ');
      parts.push('<polygon points="' + ringPts + '" fill="none" stroke="rgba(245,240,232,.055)" stroke-width="150" stroke-linejoin="round"></polygon>');
    }

    // связи
    track.edges.forEach((e) => {
      const a = nodes[e.from];
      const b = nodes[e.to];
      if (!a || !b) return;
      const isPit = e.pit || (nodes[e.from] && nodes[e.from].pitLane) || (nodes[e.to] && nodes[e.to].pitLane);
      parts.push('<line class="edge' + ((e.shortcut || isPit) ? ' shortcut' : '') + '" x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"></line>');
    });

    // гексы
    const TILE_EFFECT = {
      sand: { icon: '≈', text: '−1', color: '#ffb27a' },
      debris: { icon: '✕', text: '1 −1', color: '#ff8c7a' },
      event: { icon: '?', text: 'ПУСТОШЬ', color: '#ff7a1e' },
      pit: { icon: '⚙', text: 'РЕМОНТ', color: '#c8a04e' },
      ramp: { icon: '⌒', text: 'ПРЫЖОК', color: '#c8a04e' },
      tunnel: { icon: '∩', text: '−1 ДАЛЬН.', color: '#3ba7b0' },
      bridge: { icon: '═', text: 'ВОЗВРАТ', color: '#d8d8d2' },
    };
    nodes.forEach((n) => {
      const tile = CnA.TILES[n.type] || CnA.TILES.straight;
      const isHaz = CnA.HAZARD_TILES.indexOf(n.type) >= 0;
      const cls = 'hex' + (isHaz ? ' hazard' : '') + (n.checkpoint ? ' checkpoint' : '');
      const title = tile.label + ' · тайл ' + n.id + (n.checkpoint ? ' · контрольный пункт' : '') + (n.inner ? ' · срез' : '');
      parts.push('<g class="tile" data-node="' + n.id + '">');
      parts.push('<title>' + esc(title) + '</title>');
      const hs = (track.size || 34) * (n.inner ? 0.88 : 1);
      const sunsetFill = SUNSET_FILL[n.type] || tile.fill;
      parts.push('<polygon class="' + cls + '" points="' + hexPoints(n.x, n.y, hs) + '" fill="' + sunsetFill + '"></polygon>');
      parts.push('<polygon points="' + hexPoints(n.x, n.y, hs) + '" fill="url(#dots)" opacity=".12"></polygon>');
      if (isHaz) {
        parts.push('<polygon points="' + hexPoints(n.x, n.y, hs) + '" fill="url(#hatch-danger)" opacity=".68"></polygon>');
      }
      if (n.checkpoint) {
        parts.push('<polygon points="' + hexPoints(n.x, n.y, hs) + '" fill="url(#checker)" opacity=".92"></polygon>');
      }
      if (UI.highlightRouteNodes && UI.highlightRouteNodes.indexOf(n.id) >= 0) {
        parts.push('<polygon points="' + hexPoints(n.x, n.y, hs + 4) + '" fill="none" stroke="#c8a04e" stroke-width="2.6" stroke-dasharray="5 3"></polygon>');
      }

      // полотно: кривая через центр между входами
      if (!n.inner && n.road !== false && n.prev && n.prev.length && n.next && n.next.length) {
        const pn = nodes[n.prev[0]];
        const nn2 = nodes[n.next[0]];
        parts.push(roadMarkup(n, pn, nn2, track.size || 34, !!n.pitLane));
        n.next.slice(1).forEach((id) => parts.push(spurMarkup(n, nodes[id], track.size || 34, true)));
        n.prev.slice(1).forEach((id) => parts.push(spurMarkup(n, nodes[id], track.size || 34, true)));
      }

      // стрелка направления
      const nextId = n.next && n.next.length ? n.next[0] : null;
      if (nextId != null) {
        const nn = nodes[nextId];
        const dx = nn.x - n.x;
        const dy = nn.y - n.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        parts.push('<line class="dir" x1="' + (n.x + ux * 11) + '" y1="' + (n.y + uy * 11) +
          '" x2="' + (n.x + ux * 24) + '" y2="' + (n.y + uy * 24) + '" marker-end="url(#arrow)"></line>');
      }

      let label = tile.short || '';
      let fs = 9.5;
      if (n.type === 'start') { label = 'СТАРТ'; fs = 7.2; }
      else if (n.type === 'pit') { label = 'ПИТ'; fs = 8; }
      else if (n.type === 'event') { label = '?'; fs = 16; }
      else if (n.type === 'fork') { label = 'Y'; fs = 13; }
      else if (n.type === 'turn') { label = '↷'; fs = 14; }
      else if (n.type === 'ramp') { label = '⌒'; fs = 16; }
      else if (n.type === 'bridge') { label = 'МОСТ'; fs = 6.8; }
      else if (n.type === 'tunnel') { label = 'ТОННЕЛЬ'; fs = 5.6; }
      else if (n.type === 'sand') { label = 'ПЕСОК'; fs = 6.6; }
      else if (n.type === 'debris') { label = 'ОБЛОМКИ'; fs = 5.6; }
      else if (n.type === 'straight') { label = ''; }
      if (n.inner) { label = 'СРЕЗ'; fs = 6.8; }

      if (label) {
        const labelY = n.road === false ? n.y - 2 : (n.type === 'start' ? n.y - hs * 0.40 : n.y - (hs * 0.55));
        const ink = SUNSET_INK[n.type] || tile.ink;
        parts.push('<text class="hex-label" x="' + n.x + '" y="' + labelY + '" font-size="' + fs + '" fill="' + ink + '">' + esc(label) + '</text>');
      }
      // Чип эффекта: механика тайла прямо на доске, а не только в легенде.
      const eff = !n.inner ? TILE_EFFECT[n.type] : null;
      if (eff) {
        const effText = eff.icon + ' ' + eff.text;
        const ew = Math.max(18, effText.length * 3.1 + 6);
        const ey = n.y + hs * 0.42;
        parts.push('<rect x="' + (n.x - ew / 2) + '" y="' + (ey - 4.6) + '" width="' + ew + '" height="9.2" rx="2.4" fill="#0b0f12" opacity=".86" stroke="' + eff.color + '" stroke-width="1"/>');
        parts.push('<text x="' + n.x + '" y="' + (ey + 2.2) + '" text-anchor="middle" font-family="Cascadia Mono, Consolas, monospace" font-size="5.8" fill="' + eff.color + '" pointer-events="none">' + esc(effText) + '</text>');
      }
      parts.push('<text class="hex-num" x="' + n.x + '" y="' + (n.y + hs * 0.72) + '">' + n.id + '</text>');
      if (n.checkpoint && n.type !== 'checkpoint') {
        parts.push('<text class="hex-label" x="' + n.x + '" y="' + (n.y + 12) + '" font-size="6.4" fill="#f5f0e8">КП</text>');
      }
      if (n.type === 'start') {
        parts.push('<rect x="' + (n.x - 16) + '" y="' + (n.y - 32) + '" width="32" height="4" fill="url(#checker)"></rect>');
      }
      parts.push('</g>');
    });

    // жетоны
    const tokenOffsets = { mine: [-11, 11], oil: [11, 11], fire: [0, 15], wreck: [0, -11] };
    game.race.tokens.forEach((tok) => {
      const n = nodes[tok.node];
      if (!n) return;
      const off = tokenOffsets[tok.type] || [0, 0];
      const x = n.x + off[0];
      const y = n.y + off[1];
      const title = tok.type === 'mine' ? 'Мина' : tok.type === 'oil' ? 'Масло' : tok.type === 'fire' ? 'Огонь' : 'Обломки';
      parts.push('<g><title>' + title + '</title>');
      if (tok.type === 'mine') {
        parts.push('<circle cx="' + x + '" cy="' + y + '" r="10" fill="none" stroke="#9e1f1a" stroke-width="1.2" opacity=".75"></circle>');
        parts.push('<polygon class="token-mine" points="' + starPoints(x, y, 8.5) + '"></polygon>');
        parts.push('<text class="token-label" x="' + x + '" y="' + (y + 2.5) + '">✸</text>');
        parts.push('<text x="' + x + '" y="' + (y + 12) + '" text-anchor="middle" font-family="Cascadia Mono, Consolas, monospace" font-size="5" fill="#ff8c7a">2d4</text>');
      } else if (tok.type === 'oil') {
        parts.push('<ellipse class="token-oil" cx="' + x + '" cy="' + y + '" rx="9" ry="6"></ellipse>');
        parts.push('<text class="token-label" x="' + x + '" y="' + (y + 2.5) + '" font-size="8">≈</text>');
      } else if (tok.type === 'fire') {
        parts.push('<polygon class="token-fire" points="' + (x - 7) + ',' + (y + 5) + ' ' + (x + 7) + ',' + (y + 5) + ' ' + x + ',' + (y - 8) + '"></polygon>');
        parts.push('<text class="token-label" x="' + x + '" y="' + (y + 3) + '" font-size="7">▲</text>');
      } else {
        parts.push('<line class="token-wreck" x1="' + (x - 6) + '" y1="' + (y - 6) + '" x2="' + (x + 6) + '" y2="' + (y + 6) + '" stroke="#b9b2a6" stroke-width="2.5"></line>');
        parts.push('<line class="token-wreck" x1="' + (x + 6) + '" y1="' + (y - 6) + '" x2="' + (x - 6) + '" y2="' + (y + 6) + '" stroke="#b9b2a6" stroke-width="2.5"></line>');
      }
      parts.push('</g>');
    });

    // машины
    const byNode = {};
    game.cars.forEach((c) => {
      if (c.destroyed) return;
      if (!byNode[c.node]) byNode[c.node] = [];
      byNode[c.node].push(c);
    });
    Object.keys(byNode).forEach((nodeKey) => {
      const n = nodes[Number(nodeKey)];
      if (!n) return;
      const list = byNode[nodeKey];
      const offsets = carOffsets(list.length);
      list.forEach((c, idx) => {
        const off = offsets[idx % offsets.length];
        const f = faction(c.factionId);
        const cur = currentCar();
        const isCur = cur && cur.id === c.id;
        const isTarget = UI.highlightTargets.indexOf(c.id) >= 0;
        const cls = 'car' + (isCur ? ' current' : '') + (isTarget ? ' target' : '') +
          (c.finished ? ' finished' : '') + (c.spawnProtect ? ' protected' : '');
        const x = n.x + off[0];
        const y = n.y + off[1];
        // 3–4 машины на тайле — уменьшаем фигурки, чтобы влезли в 2×2.
        const shrink = list.length >= 3 ? 0.72 : 1;
        parts.push('<g class="' + cls + '" transform="translate(' + x + ',' + y + ')" data-car="' + c.id + '">');
        parts.push('<title>' + esc(c.name + ' · ' + c.hp + '/' + c.maxHp + ' корпуса · очки ' + c.cp + ' · лом ' + c.scrap) + '</title>');
        if (shrink !== 1) parts.push('<g transform="scale(' + shrink + ')">');
        parts.push(carFigure(c, f, isCur, isTarget));
        if (shrink !== 1) parts.push('</g>');
        parts.push('</g>');
      });
    });

    $('#board').innerHTML = parts.join('');
    updateCamera(true);
    renderMinimap();
  }

  /* Мини-карта в углу доски: контур трассы, машины и текущий кадр камеры. */
  function renderMinimap() {
    const mini = $('#minimap');
    if (!mini) return;
    const game = UI.game;
    if (!game || !game.race) { mini.innerHTML = ''; return; }
    const track = game.race.track;
    const nodes = track.nodes;
    const key = game.seed + ':' + (track.label || track.count);
    if (UI.miniKey !== key) {
      UI.miniKey = key;
      const ring = track.ring || [];
      const pts = ring.map((id) => nodes[id].x + ',' + nodes[id].y).join(' ');
      let s = '<polygon class="mm-track" points="' + pts + '" fill="none" stroke="#c8a04e" stroke-width="12" stroke-linejoin="round" opacity=".85"></polygon>';
      const start = nodes[0];
      if (start) s += '<circle cx="' + start.x + '" cy="' + start.y + '" r="16" fill="#f5f0e8"></circle>';
      s += '<rect class="mm-view" x="' + UI.view.x + '" y="' + UI.view.y + '" width="' + UI.view.w + '" height="' + UI.view.h + '" fill="none" stroke="#f5f0e8" stroke-width="7" stroke-dasharray="16 12"></rect>';
      s += '<g class="mm-cars"></g>';
      mini.innerHTML = s;
    }
    const carsGroup = mini.querySelector('.mm-cars');
    if (carsGroup) {
      carsGroup.innerHTML = game.cars.map((c) => {
        const n = nodes[c.node];
        if (!n || c.destroyed) return '';
        const f = faction(c.factionId);
        return '<circle cx="' + n.x + '" cy="' + n.y + '" r="18" fill="' + f.color + '" stroke="#0b0f12" stroke-width="6"></circle>';
      }).join('');
    }
    const r = mini.querySelector('.mm-view');
    if (r) {
      r.setAttribute('x', UI.view.x);
      r.setAttribute('y', UI.view.y);
      r.setAttribute('width', UI.view.w);
      r.setAttribute('height', UI.view.h);
    }
  }

  function renderPlayers() {
    const game = UI.game;
    if (!game || !game.race) return;
    const order = game.cars.slice().sort((a, b) => {
      if (a.finished && b.finished) return (a.finishPos || 9) - (b.finishPos || 9);
      if (a.finished) return -1;
      if (b.finished) return 1;
      return CnA.progressOf(game, b) - CnA.progressOf(game, a);
    });
    const pos = {};
    order.forEach((c, i) => { pos[c.id] = i + 1; });
    const cur = currentCar();
    $('#players').innerHTML = game.cars.map((c) => {
      const f = faction(c.factionId);
      const hpPct = Math.max(0, Math.min(100, c.hp / c.maxHp * 100));
      const statuses = [];
      if (c.finished) statuses.push('<span class="st">ФИНИШ</span>');
      if (c.destroyed) statuses.push('<span class="st down">ВНЕ ИГРЫ ' + Math.max(0, c.downTurns) + '</span>');
      if (c.pit) statuses.push('<span class="st pit">ПИТ ' + (c.pit.turns + 1) + '</span>');
      if (c.burn) statuses.push('<span class="st burn">ГОРИТ</span>');
      if (c.smoke) statuses.push('<span class="st smoke">ДЫМ</span>');
      if (c.shield > 0) statuses.push('<span class="st prot">БРОНЯ ' + c.shield + '</span>');
      if (c.emp) statuses.push('<span class="st burn">ЭМИ</span>');
      if (c.spawnProtect) statuses.push('<span class="st prot">ЩИТ</span>');
      if (!c.destroyed && c.hp / c.maxHp <= 0.2) statuses.push('<span class="st burn">КРИТ</span>');
      const ups = (c.upgrades || []).map((id) => '<span class="up" title="' + esc((CnA.upgrade(id) || {}).name || id) + '">' + (UP_SHORT[id] || id) + '</span>').join('');
      const cls = 'player' + (cur && cur.id === c.id ? ' active' : '') + (c.finished || c.destroyed ? ' out' : '');
      return '<div class="' + cls + '" style="--fc:' + f.color + '">' +
        '<div class="p-top"><span class="p-name"><span class="p-glyph" title="' + esc(f.name) + '">' + f.glyph + '</span>' + esc(c.name) + (c.human ? ' ★' : '') + '</span><span class="p-pos">' + pos[c.id] + '/4</span></div>' +
        '<div class="p-stats"><span>КОРПУС <b>' + c.hp + '</b>/' + c.maxHp + '</span><span>ОЧКИ <b>' + c.cp + '</b></span><span>ЛОМ <b>' + c.scrap + '</b></span></div>' +
        '<div class="hp-bar"><div class="hp-fill" style="width:' + hpPct + '%"></div><span class="hp-mark" style="left:50%"></span><span class="hp-mark" style="left:20%"></span></div>' +
        '<div class="p-status">' + statuses.join('') + '</div>' +
        (ups ? '<div class="p-upgrades">' + ups + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function phaseLabel(phase) {
    if (phase === 'prep') return 'ПОДГОТОВКА';
    if (phase === 'move') return 'ДВИЖЕНИЕ';
    if (phase === 'fire') return 'ОГОНЬ';
    if (phase === 'done') return 'КОНЕЦ ХОДА';
    return '—';
  }

  function renderTurnCard() {
    const game = UI.game;
    const card = $('#turn-card');
    if (!game || !game.race) { card.innerHTML = ''; return; }
    const c = currentCar();
    const f = c ? faction(c.factionId) : null;
    const phase = game.race.phase;
    const isHuman = c && c.human;

    if (!c || game.race.over) {
      card.style.setProperty('--fc', '#c8a04e');
      card.innerHTML = '<div class="turn-head"><div><div class="turn-who">ГОНКА ЗАВЕРШЕНА</div>' +
        '<div class="turn-sub">смотрим результаты</div></div></div>';
      return;
    }

    const status = [];
    status.push('корпус ' + c.hp + '/' + c.maxHp);
    if (c.burn) status.push('горит');
    if (c.smoke) status.push('дым');
    if (c.pit) status.push('в боксах');
    if (c.spawnProtect) status.push('щит');
    if (c.shield > 0) status.push('броня ' + c.shield);
    if (c.emp || (game.race.turn && game.race.turn.empDisabled)) status.push('ЭМИ');
    if (c.nextMovePenalty) status.push('−' + c.nextMovePenalty + ' к следующему ходу');
    const lap = Math.min(game.laps, Math.max(1, c.lapsDone + 1));

    card.style.setProperty('--fc', f.color);
    card.innerHTML =
      '<div class="turn-head">' +
      '<div><div class="turn-who" style="color:' + f.color + '">' + esc(c.name) + '</div>' +
      '<div class="turn-sub">' + (isHuman ? 'ТВОЙ ХОД' : 'ХОД СОПЕРНИКА') + ' · ' + esc(c.carName) + '</div></div>' +
      '<div class="turn-phase">' + phaseLabel(phase) + '</div>' +
      '</div>' +
      '<div class="turn-sub" style="margin-top:8px">РАУНД ' + game.race.round + ' · КРУГ ' + lap + '/' + game.laps + '</div>' +
      '<div class="turn-sub" style="margin-top:6px">' + esc(status.join(' · ')) + '</div>';
  }

  /* Нижняя полоса фаз: крупный индикатор хода + подсказка + действия. */
  function renderPhaseStrip() {
    const game = UI.game;
    const el = $('#phase-strip');
    if (!el) return;
    if (!game || !game.race) { el.innerHTML = ''; return; }
    const c = currentCar();
    const phase = game.race.phase;
    const isHuman = c && c.human;
    const turn = game.race.turn;
    const calc = turn && turn.rolled
      ? 'd4 ' + turn.roll + (turn.mods && turn.mods.length ? ' · ' + turn.mods.join(' · ') : '') + ' = ' + turn.speed
      : '';
    const finishNote = game.race.firstFinishRound != null
      ? 'ФИНИШ ЛИДЕРА · ещё раунд; DNF — 50% очков за место'
      : '';

    const chips = [['prep', 'ПОДГОТОВКА'], ['move', 'ДВИЖЕНИЕ'], ['fire', 'ОГОНЬ']].map(([p, label]) => {
      const active = phase === p;
      const done = (p === 'prep' && (phase === 'move' || phase === 'fire' || phase === 'done')) ||
                   (p === 'move' && (phase === 'fire' || phase === 'done'));
      return '<span class="phase-chip' + (active ? ' active' : done ? ' done' : '') + '">' + label + '</span>';
    }).join('');

    let hint = '';
    let actions = '';
    if (!c || game.race.over) {
      hint = 'Гонка завершена.';
    } else if (isHuman) {
      if (phase === 'prep') {
        hint = 'Сыграй карту, объяви пит-стоп — или сразу бросай d4.';
        actions += '<button id="roll-btn" class="act-btn primary">БРОСОК d4</button>';
        if (CnA.isPitNode(game, c.node) && !c.flags.pitThisRace) actions += '<button id="pit-btn" class="act-btn sky">ПИТ-СТОП</button>';
        if (c.factionId === 'rust' && !c.flags.repairUsed && c.hp < c.maxHp) actions += '<button id="rust-btn" class="act-btn">ЛАТАЕМ НА ХОДУ</button>';
        if (c.factionId === 'carnival' && !c.flags.mineReturned) actions += '<button id="mine-return-btn" class="act-btn">ВЕРНУТЬ МИНУ</button>';
        if (CnA.hasUpgrade(c, 'turbo') && !c.flags.turboUsed && !c.flags.turboArmed) actions += '<button id="turbo-btn" class="act-btn">ТУРБИНА</button>';
      } else if (phase === 'move') {
        const t = game.race.turn || { speed: 0, remaining: 0 };
        hint = 'Движение: ' + t.speed + ' · осталось ' + t.remaining + '. Машина едет ровно на итог.';
      } else if (phase === 'fire') {
        const t = game.race.turn || {};
        const anyTarget = c.hand.some((h) => {
          const card = CnA.CARDS[h.type];
          if (card.phase !== 'fire') return false;
          if (card.kind === 'trap') return CnA.trapOptions(game, c, h.uid).length > 0;
          return CnA.attackTargets(game, c, h.type).length > 0;
        });
        hint = t.fireUsed ? 'Действие огня использовано. Заверши ход.'
          : anyTarget ? 'Фаза огня: одна атака или ловушка. После выстрела — отдача: −1 к движению.'
          : 'В радиусе нет целей. Можно поставить ловушку или завершить ход.';
        if (t.wildfire) hint = 'Дикий огонь взведён: следующий выстрел без отдачи.';
        if (!t.fireUsed && c.factionId === 'chrome' && (c.flags.wildfireCharges || 0) > 0) {
          actions += '<button id="wildfire-btn" class="act-btn ' + (t.wildfire ? 'primary' : '') + '">WILDFIRE ' + c.flags.wildfireCharges + '/2</button>';
        }
        actions += '<button id="end-turn-btn" class="act-btn primary">ЗАВЕРШИТЬ ХОД</button>';
      } else {
        hint = 'Ход завершается…';
      }
    } else {
      hint = phase === 'prep' ? 'Соперник оценивает обстановку.' :
        phase === 'move' ? 'Соперник едет по трассе.' :
        phase === 'fire' ? 'Соперник выбирает, кого ударить.' : 'Соперник завершает ход.';
      actions += '<button class="act-btn ghost" disabled>ХОД СОПЕРНИКА</button>';
    }

    const lap = c ? Math.min(game.laps, Math.max(1, c.lapsDone + 1)) : 1;
    const turnLine = 'РАУНД ' + game.race.round + ' · КРУГ ' + lap + '/' + game.laps + ' · ' + (isHuman ? 'ТВОЙ ХОД' : 'ХОД СОПЕРНИКА');
    el.innerHTML =
      '<div class="phase-chips">' + chips + '</div>' +
      '<div class="phase-info"><span class="phase-turn">' + turnLine + '</span>' +
      (finishNote ? '<span class="phase-finish">' + esc(finishNote) + '</span>' : '') +
      '<span class="phase-hint">' + hint + '</span>' +
      (calc ? '<span class="phase-calc">' + esc(calc) + '</span>' : '') + '</div>' +
      '<div class="phase-actions">' + actions + '</div>';

    const rollBtn = $('#roll-btn'); if (rollBtn) rollBtn.addEventListener('click', onRoll);
    const pitBtn = $('#pit-btn'); if (pitBtn) pitBtn.addEventListener('click', onPit);
    const rustBtn = $('#rust-btn'); if (rustBtn) rustBtn.addEventListener('click', onRustRepair);
    const mineBtn = $('#mine-return-btn'); if (mineBtn) mineBtn.addEventListener('click', onReturnMine);
    const turboBtn = $('#turbo-btn'); if (turboBtn) turboBtn.addEventListener('click', onTurbo);
    const wildfireBtn = $('#wildfire-btn'); if (wildfireBtn) wildfireBtn.addEventListener('click', onWildfire);
    const endBtn = $('#end-turn-btn'); if (endBtn) endBtn.addEventListener('click', () => { if (!UI.busy) finishTurn(); });
  }

  function renderHand() {
    const game = UI.game;
    if (!game || !game.race) { $('#hand-zone').innerHTML = ''; return; }
    const c = humanCar() || currentCar();
    if (!c) { $('#hand-zone').innerHTML = ''; return; }
    const head = '<div class="hand-head"><h3>' + (c.human ? 'РУКА АРСЕНАЛА' : 'РУКА СОПЕРНИКА') + '</h3><span class="hand-count">' + c.hand.length + ' / 5</span></div>';

    if (!c.human) {
      const backUrl = assetUrl('bg', 'card-back');
      const backs = c.hand.map(() => '<div class="card card-back">' +
        '<img class="card-back-img" src="' + backUrl + '" alt="" aria-hidden="true" onerror="this.parentNode.classList.add(\'no-art\');this.remove()">' +
        '<div class="phase">СКРЫТО</div><div class="cname">?</div></div>').join('');
      $('#hand-zone').innerHTML = head + '<div class="hand">' + backs + '<div class="empty-hand">Рука соперника не показывается.</div></div>';
      return;
    }

    const cards = c.hand.map((h) => {
      const card = CnA.CARDS[h.type];
      const playable = !UI.busy && isHumanTurn() && CnA.cardPlayable(game, c, h.uid);
      const kindCls = card.kind === 'attack' ? 'attack' : card.kind === 'trap' ? 'trap' : card.kind === 'prep' ? 'prep' : 'reaction';
      const phaseText = card.phase === 'prep' ? 'ПОДГОТОВКА' : card.phase === 'fire' ? 'ОГОНЬ' : 'РЕАКЦИЯ';
      const stats = card.noDamage
        ? 'эффект' + (card.range ? ' · ' + card.range : '')
        : (card.dmg && card.dmg !== '—' ? card.dmg + (card.range ? ' · ' + card.range : '') : (card.kind === 'prep' ? 'эффект' : '—'));
      const icon = CARD_ICON[card.id] || '·';
      const art = CARD_ART[card.id]
        ? '<img class="card-illu" src="' + assetUrl('card', card.id) + '" alt="">'
        : '<div class="card-art">' + esc(icon) + '</div>';
      return '<button class="card ' + kindCls + (playable ? '' : ' disabled') + '" data-uid="' + h.uid + '" title="' + esc(card.text) + '">' +
        '<div class="phase">' + phaseText + '</div>' +
        art +
        '<div class="cname">' + esc(card.name) + '</div>' +
        '<div class="cstats">' + esc(stats) + '</div>' +
        '<div class="cshort">' + esc(card.short) + '</div>' +
        (card.phase === 'reaction' ? '<div class="badge-auto" title="Реакция: срабатывает автоматически, кликать не нужно">АВТО</div>' : '') +
        '</button>';
    }).join('');

    let hint = '';
    if (!UI.busy && game.race.phase === 'fire') {
      const anyTarget = c.hand.some((h) => {
        const card = CnA.CARDS[h.type];
        if (card.phase !== 'fire') return false;
        if (card.kind === 'trap') return CnA.trapOptions(game, c, h.uid).length > 0;
        return CnA.attackTargets(game, c, h.type).length > 0;
      });
      if (!anyTarget) hint = '<div class="empty-hand" style="min-height:0;padding:6px 4px 0">Нет целей в радиусе. Заверши ход.</div>';
    }
    $('#hand-zone').innerHTML = head + '<div class="hand">' + (cards || '<div class="empty-hand">Рука пуста. Карты добираются в конце хода.</div>') + '</div>' + hint;
    $$('#hand-zone .card[data-uid]').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.classList.contains('disabled')) {
          const card = CnA.CARDS[(c.hand.find((x) => String(x.uid) === el.dataset.uid) || {}).type];
          if (card && card.phase === 'prep') showToast('Сейчас не фаза подготовки.', 'event');
          else if (card && card.phase === 'fire') showToast('Сейчас не фаза огня или нет цели.', 'event');
          else showToast('Сейчас эту карту сыграть нельзя.', 'event');
          return;
        }
        onHandCard(Number(el.dataset.uid));
      });
    });
  }

  function renderLog() {
    const game = UI.game;
    const logEl = $('#log');
    if (!game || !logEl) return;
    const entries = game.log.slice(-90);
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 50;
    logEl.innerHTML = entries.map((e) =>
      '<div class="log-entry ' + esc(e.kind) + '"><span class="rn">R' + e.round + '</span>' + esc(e.text) + '</div>'
    ).join('');
    if (nearBottom || entries.length < 10) logEl.scrollTop = logEl.scrollHeight;
  }

  function showEvent(ev) {
    if (!ev) return;
    showToast('<b>ПУСТОШЬ · ' + esc(ev.name) + '</b><br>' + esc(ev.text), 'event', 3400);
  }

  function showDice(roll, total, mods, nitroRoll) {
    const strip = $('#dice-strip');
    if (!strip) return;
    const modText = (mods && mods.length) ? ' <span class="mods">[' + esc(mods.join(', ')) + ']</span>' : '';
    strip.innerHTML = '<div class="dice rolling">' + roll + '</div>' +
      '<div class="dice-note">бросок <b>' + roll + '</b>' + (nitroRoll ? ' + нитро <b>' + nitroRoll + '</b>' : '') +
      ' → движение <b>' + total + '</b>' + modText + '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* Результаты и финализация                                           */
  /* ------------------------------------------------------------------ */
  function setFinalizeStatus(text, state) {
    const el = $('#finalize-status');
    if (!el) return;
    el.className = 'finalize-status' + (state === 'error' ? ' error' : '');
    el.textContent = text;
  }

  async function showResults() {
    const game = UI.game;
    if (!game || !game.results) return;
    if (UI.resultsShownFor === game.results) return;
    UI.resultsShownFor = game.results;
    UI.busy = false;
    UI.stage = 'results';
    renderResults();
    showScreen('results');

    if (!UI.saveId) {
      setFinalizeStatus('Локальный заезд (без сервера). Результат не сохранён.', 'error');
      return;
    }
    if (UI.finalized) return;

    setFinalizeStatus('Сохранение результата…');
    const res = await doSave({ finalize: true });
    UI.finalized = true;
    if (res && res.notImproved) {
      setFinalizeStatus('Заезд засчитан, но не улучшил твой лучший результат за день.', 'error');
    } else if (res) {
      setFinalizeStatus('Результат сохранён. Счёт: ' + buildResult().score + ' очков.');
    } else {
      setFinalizeStatus('Не удалось сохранить результат. Повтори попытку, обновив страницу и нажав «Продолжить».', 'error');
    }
  }

  function renderResults() {
    const game = UI.game;
    const res = game.results;
    $('#results-title').textContent = game.mode === 'daily' ? 'ИТОГИ ЕЖЕДНЕВНОГО ЗАЕЗДА' : 'ИТОГИ ЗАЕЗДА';
    $('#results-sub').textContent = 'Сид ' + game.seed + ' · кругов ' + game.laps + ' · трасса ' + (game.race.track.label || game.race.track.count + ' тайлов');
    const head = '<div class="res-row head"><div class="place">#</div><div>Гонщик</div><div class="num">ОЧКИ</div><div class="num">ЛОМ</div><div class="num">УРОН</div><div class="num">ФИНИШ</div></div>';
    $('#results-table').innerHTML = head + res.rows.map((r) => {
      const f = faction(r.factionId);
      const cls = 'res-row' + (r.pos === 1 ? ' winner' : '') + (!r.finished ? ' dnf' : '');
      return '<div class="' + cls + '" style="--fc:' + f.color + '">' +
        '<div class="place">' + r.pos + '</div>' +
        '<div class="who"><b>' + esc(r.name) + '</b><span>' + esc(f.car) + (r.finished ? '' : ' · не доехал') + '</span></div>' +
        '<div class="num cp">+' + r.cpGained + '<small>очки за гонку</small></div>' +
        '<div class="num scrap">+' + r.scrapGained + '<small>лом</small></div>' +
        '<div class="num">' + r.damage + '<small>' + r.kills + ' убийств</small></div>' +
        '<div class="num">' + (r.finished ? '🏁' : '—') + '<small>корпус ' + r.hp + '</small></div>' +
        '</div>';
    }).join('');
    const note = $('#results-note');
    if (note) {
      note.textContent = res.rows.some((r) => !r.finished)
        ? 'Финишировавшие получают полные очки за место, не доехавшие — половину по прогрессу. Очки за уничтожения и лидерство сохраняются.'
        : '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Авторизация и лобби                                                */
  /* ------------------------------------------------------------------ */
  function setAuthMode(mode) {
    UI.authMode = mode;
    $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.auth === mode));
    $('#displayname-field').hidden = mode !== 'register';
    $('#auth-submit').textContent = mode === 'register' ? 'СОЗДАТЬ АККАУНТ' : 'ВОЙТИ';
    hideAuthError();
  }

  function showAuthError(msg) {
    const el = $('#auth-error');
    el.textContent = msg;
    el.hidden = false;
  }
  function hideAuthError() {
    const el = $('#auth-error');
    el.textContent = '';
    el.hidden = true;
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    hideAuthError();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const displayName = $('#auth-displayname').value.trim();
    if (!username || !password) { showAuthError('Укажи имя и пароль.'); return; }
    if (UI.authMode === 'register' && password.length < 8) { showAuthError('Пароль — минимум 8 символов.'); return; }

    const submit = $('#auth-submit');
    submit.disabled = true;
    try {
      if (UI.authMode === 'register') {
        await API.register({ username, password, displayName: displayName || username });
      } else {
        await API.login({ username, password });
      }
      await enterLobby();
    } catch (err) {
      showAuthError(err.message || 'Ошибка входа');
    } finally {
      submit.disabled = false;
    }
  }

  async function enterLobby() {
    try {
      const me = await API.me();
      UI.account = me.account;
      UI.stats = me.stats;
      UI.activeRun = me.activeRun || null;
      UI.activeSave = me.activeSave || null;
    } catch (e) {
      showScreen('auth');
      return;
    }
    showScreen('lobby');
    renderLobby();
    loadDaily();
    maybeShowOnboarding();
  }

  function renderLobby() {
    if (UI.account) {
      const name = UI.account.displayName || UI.account.username;
      $('#lobby-user').innerHTML = '<b>' + esc(name) + '</b>';
      $('#hub-user').innerHTML = '<b>' + esc(name) + '</b> · в гараже';
    }
    renderStats();
    renderHubContinue();
    renderDailyStrip();
  }

  function renderStats() {
    const s = UI.stats || {};
    const box = (label, value) => '<div class="stat-box"><b>' + esc(value == null ? '—' : value) + '</b><span>' + esc(label) + '</span></div>';
    const el = $('#stats-body');
    if (!el) return;
    el.innerHTML =
      box('заездов', s.runsTotal) +
      box('финишей', s.runsFinished) +
      box('рекорд дня', s.dailyBest);
  }

  function renderHubContinue() {
    const btn = $('#hub-continue');
    const sub = $('#hub-continue-sub');
    if (!btn || !sub) return;
    if (UI.activeSave && UI.activeRun) {
      const mode = UI.activeRun.mode === 'daily' ? 'ежедневный заезд' : 'свободный заезд';
      const f = faction(UI.activeRun.faction);
      const statusMap = { active: 'в пути', finished: 'финиш', abandoned: 'брошен', paused: 'пауза' };
      btn.disabled = false;
      sub.textContent = mode + ' · ' + f.name + ' · ' + (statusMap[UI.activeRun.status] || 'в пути');
    } else {
      btn.disabled = true;
      sub.textContent = 'нет активного заезда';
    }
  }

  function renderDailyStrip() {
    const el = $('#hub-daily');
    if (!el) return;
    if (!UI.daily || !UI.daily.challenge) { el.hidden = true; return; }
    const c = UI.daily.challenge;
    const f = faction(c.faction);
    el.hidden = false;
    el.innerHTML =
      '<div><b>СЕГОДНЯ</b> · ' + esc(UI.daily.date) + ' · <span style="color:' + f.color + '">' + esc(f.name) + '</span>' +
      (UI.daily.myBest ? ' · лучший ' + UI.daily.myBest.score : '') + '</div>' +
      '<button id="hub-daily-start" type="button">ЕЖЕДНЕВНЫЙ →</button>';
    const b = $('#hub-daily-start');
    if (b) b.addEventListener('click', () => openFactionScreen('daily'));
  }

  async function loadDaily() {
    try {
      UI.daily = await API.daily();
      renderDailyStrip();
      if (UI.screen === 'faction' && UI.newRaceMode === 'daily') renderFactionCards();
    } catch (e) {
      UI.daily = null;
      renderDailyStrip();
      if (UI.newRaceMode === 'daily') {
        UI.newRaceMode = 'race';
        if (UI.screen === 'faction') { renderFactionCards(); showToast('Ежедневный заезд недоступен — свободный заезд.', 'event', 2600); }
      }
    }
  }

  function openFactionScreen(mode) {
    UI.newRaceMode = mode === 'daily' ? 'daily' : 'race';
    renderFactionCards();
    showScreen('faction');
  }

  function renderFactionCards() {
    const grid = $('#faction-cards');
    if (!grid) return;
    const daily = UI.newRaceMode === 'daily' && UI.daily ? UI.daily.challenge : null;
    const dailyFaction = daily ? daily.faction : null;
    if (dailyFaction) UI.quickFaction = dailyFaction;

    $$('#faction-tabs .faction-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === UI.newRaceMode));
    const sub = $('#faction-sub');
    if (sub) {
      sub.textContent = daily
        ? 'Ежедневный · ' + UI.daily.date + ' · сид ' + daily.seed + ' · ' + (daily.trackKind === 'mosaic' ? 'Пыльная подкова · 36' : 'Кольцо · ' + daily.trackSize) + ' · кругов ' + daily.laps + '. Фракция фиксирована.'
        : 'Четыре характера. Один заезд. Выбирай.';
    }

    grid.innerHTML = CnA.FACTIONS.map((f) => {
      const info = FACTION_INFO[f.id] || {};
      const locked = !!dailyFaction && f.id !== dailyFaction;
      const active = f.id === UI.quickFaction && !locked;
      return '<article class="car-card' + (active ? ' active' : '') + (locked ? ' locked' : '') + '" data-faction="' + f.id + '" style="--fc:' + f.color + '" tabindex="0" role="button" aria-label="' + esc(f.name) + '">' +
        '<div class="car-art" data-glyph="' + esc(f.glyph) + '">' +
          '<img src="assets/factions/' + f.id + '/mini.png" alt="' + esc(f.car) + '" onerror="this.remove()">' +
        '</div>' +
        '<div class="car-info">' +
          '<div class="car-top"><h3>' + esc(f.name) + '</h3><span class="car-car">' + esc(f.car) + '</span></div>' +
          '<div class="car-meta"><span>КОРПУС <b>' + f.hp + '</b></span><span title="Слоты — ячейки под улучшения из мастерской; +1 слот = +1 улучшение">СЛОТЫ <b>' + f.slots + '</b></span></div>' +
          '<div class="car-tags">' + (f.tags || []).map((t) => '<span class="car-tag">' + esc(t) + '</span>').join('') + '</div>' +
          (info.role ? '<p class="car-ability car-role">' + esc(info.role) + '</p>' : '') +
          '<p class="car-ability car-desc"><b>' + esc(f.abilityName) + '</b> ' + esc(f.ability) + '</p>' +
          '<button class="car-more" type="button" data-more="' + f.id + '">ПОДРОБНЕЕ</button>' +
        '</div>' +
      '</article>';
    }).join('');

    $$('#faction-cards .car-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-more]')) return;
        selectFaction(card.dataset.faction);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFaction(card.dataset.faction); }
      });
    });
    $$('#faction-cards [data-more]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openFactionInfo(btn.dataset.more); });
    });
    renderFactionDetail();
  }

  function selectFaction(id) {
    const daily = UI.newRaceMode === 'daily' && UI.daily ? UI.daily.challenge : null;
    if (daily && daily.faction !== id) {
      showToast('Сегодня фиксирована фракция ' + esc(faction(daily.faction).name) + '.', 'event', 2200);
      return;
    }
    UI.quickFaction = id;
    $$('#faction-cards .car-card').forEach((c) => c.classList.toggle('active', c.dataset.faction === id));
    renderFactionDetail();
  }

  function renderFactionDetail() {
    const el = $('#faction-detail');
    const start = $('#faction-start');
    if (!el || !start) return;
    const f = faction(UI.quickFaction);
    const info = FACTION_INFO[f.id] || {};
    const daily = UI.newRaceMode === 'daily' && UI.daily;
    el.innerHTML = '<b>' + esc(f.name) + '</b> · ' + esc(f.car) + ' · корпус ' + f.hp + ' · слоты ' + f.slots +
      (info.tip ? '<br><span style="color:var(--muted)">' + esc(info.tip) + '</span>' : '');
    start.textContent = daily ? 'СТАРТ ДНЯ' : 'НА ТРАССУ';
  }

  function openFactionInfo(id) {
    const f = faction(id);
    const info = FACTION_INFO[f.id] || {};
    const html =
      '<div class="faction-info">' +
      '<div class="help-kicker" style="color:' + f.color + '">' + esc(f.short) + '</div>' +
      '<h3 style="margin:4px 0 2px;color:' + f.color + '">' + esc(f.name) + '</h3>' +
      '<p style="margin-bottom:10px;color:var(--muted)">' + esc(f.car) + ' · «' + esc(f.motto || '') + '»</p>' +
      '<div class="car-meta" style="margin-bottom:10px"><span>КОРПУС <b style="color:var(--chrome)">' + f.hp + '</b></span><span title="Слоты — ячейки под улучшения из мастерской; +1 слот = +1 улучшение">СЛОТЫ <b style="color:var(--chrome)">' + f.slots + '</b></span></div>' +
      '<p><b>Способность:</b> «' + esc(f.abilityName) + '» — ' + esc(f.ability) + '</p>' +
      (info.role ? '<p style="margin-top:8px;color:var(--muted)"><b>Роль:</b> ' + esc(info.role) + '</p>' : '') +
      (info.strengths ? '<p style="margin-top:6px"><b>Сильно:</b> ' + esc(info.strengths) + '</p>' : '') +
      (info.weakness ? '<p style="margin-top:6px"><b>Слабо:</b> ' + esc(info.weakness) + '</p>' : '') +
      (info.tip ? '<p style="margin-top:6px;color:var(--brass)"><b>Совет:</b> ' + esc(info.tip) + '</p>' : '') +
      '</div>';
    modal(html, null, { maxWidth: '560px' });
  }

  function openHelp(from) {
    UI.helpFrom = from || (UI.screen === 'game' ? 'game' : 'lobby');
    UI.helpOpen = UI.helpFrom === 'game';
    const overlay = $('#help-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    const replay = $('#help-replay');
    if (replay) replay.hidden = UI.helpFrom !== 'lobby';
    renderHelp('basics');
  }

  function closeHelp() {
    const overlay = $('#help-overlay');
    if (overlay) overlay.hidden = true;
    UI.helpOpen = false;
  }

  function helpFactionBlocks() {
    return CnA.FACTIONS.map((f) => {
      const info = FACTION_INFO[f.id] || {};
      return '<div style="margin-top:12px;padding:12px;border-left:3px solid ' + f.color + ';background:rgba(0,0,0,.22)">' +
        '<b style="color:' + f.color + '">' + esc(f.name) + '</b> · ' + esc(f.car) + ' · корпус ' + f.hp + ', слоты ' + f.slots +
        '<div style="margin-top:4px"><b>Способность:</b> «' + esc(f.abilityName) + '» — ' + esc(f.ability) + '</div>' +
        (info.tip ? '<div style="margin-top:4px;color:var(--muted)">' + esc(info.tip) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderHelp(tab) {
    $$('.help-tab').forEach((t) => t.classList.toggle('active', t.dataset.help === tab));
    const body = $('#help-body');
    if (!body) return;
    const content = {
      basics:
        '<h3>Цель</h3><p>Первым пересечь финишную черту, пройдя нужное число кругов. В один ход всего не сделать: на карту, манёвр и выстрел отведено по фазе.</p>' +
        '<p><b>Финиш.</b> После финиша лидера остальные доезжают ещё один раунд. Финишировавшие получают полные очки за место (10/6/3/1), не доехавшие — половину по прогрессу (5/3/1/0).</p>' +
        '<h3>Три фазы хода</h3><ol><li><b>Подготовка.</b> Одна карта до движения — или пит-стоп.</li><li><b>Движение.</b> Бросок d4 + модификаторы; машина едет на итоговую сумму.</li><li><b>Огонь.</b> Одна атака или одна ловушка.</li></ol>' +
        '<h3>Управление</h3><ul><li>Нажми карту в руке — подготовка или атака.</li><li>Кнопка «Бросок d4» начинает движение.</li><li><b>Esc</b> закрывает окно; <b>?</b> открывает этот устав.</li></ul>' +
        '<div class="help-note">Новичку: начни с «Кузнецов Ржавчины» — у них самый большой корпус и ремонт на ходу.</div>',
      phases:
        '<h3>Подготовка</h3><ul><li>Нитро, тормоз, дым, ремонт, канистра — одна карта до броска.</li><li>Пит-стоп ремонтирует машину и добирает карты; у Кузнецов он на ход короче.</li></ul>' +
        '<h3>Движение</h3><ul><li>Итог d4 + модификаторы, минимум 1, максимум 8.</li><li>Песок отнимает 1 движение, обломки наносят 1 урон и тоже −1; на «?» в конце движения добирается карта Пустоши.</li><li>На повороте при скорости 5+ — бросок d4: на 1 машину заносит.</li><li>Трамплин переносит машину через следующий тайл; при скорости 6+ посадка наносит d4 урона.</li><li>Один раз за гонку можно перебросить d4 до начала движения.</li></ul>' +
        '<h3>Огонь</h3><ul><li>Дальность считается вдоль трассы; назад стрелять можно, вперёд — только по прямой.</li><li>Ракеты и турель игнорируют линию огня.</li><li>Одна атака или одна ловушка за ход.</li><li>После атаки — отдача: −1 к следующему движению. Chrome дважды за гонку отменяет её через «Дикий огонь».</li></ul>',
      combat:
        '<h3>Урон</h3><ul><li>Ниже 50% корпуса — −1 к движению; ниже 20% — −2 и нельзя таранить.</li><li>Уничтоженная машина оставляет обломки, пропускает 2 хода и возвращается на последний КП с половиной корпуса.</li><li>После возврата — защита от огня до следующего хода.</li><li>За уничтожение — +1 очко в первом круге, +3 дальше; +5 лома. Жертва теряет карту и 3 лома.</li></ul>' +
        '<h3>Ловушки</h3><ul><li>Мина ставится на свой тайл или позади; на въезде — 2d4.</li><li>Масло — бросок d4: 1–2 — занос, ход заканчивается.</li><li>Карнавал ставит первую ловушку в ход бесплатно.</li></ul>' +
        '<div class="help-note">В дым не стреляют с дистанции 2 и больше. Глушилка отменяет первую атаку по тебе.</div>',
      cards:
        '<h3>Рука</h3><ul><li>Старт — 3 карты, лимит руки 5.</li><li>В конце хода добираешь 1 карту.</li><li>Фаза карты задаёт, когда её можно сыграть: подготовка, огонь, реакция.</li></ul>' +
        '<h3>Экономика</h3><ul><li>Лом за место: 1-е — 4, 2-е — 6, 3-е — 8, 4-е — 10 (чем хуже место, тем больше); не доехал — 3.</li><li>+1 лом за каждые 5 урона, +5 за уничтожение.</li><li>Очки за место: 10/6/3/1; DNF — 5/3/1/0 по прогрессу. За уничтожение — +1 в первом круге, +3 дальше.</li></ul>' +
        '<div class="help-note">Улучшения покупаются в мастерской между гонками чемпионата; в свободном заезде — только карты.</div>',
      factions: '<h3>Четыре характера</h3><p>Выбор машины — это выбор темпа и риска. Способность важнее лишнего слота.</p><p class="help-note">Слоты — ячейки под улучшения из мастерской: +1 слот = +1 улучшение.</p>' + helpFactionBlocks(),
      pvp:
        '<h3>PvP</h3><ul><li>Создай лобби или войди по коду из 6 знаков.</li><li>4 места; пустые занимают боты.</li><li>Таймер хода — 90 секунд (настраивается).</li><li>Карты соперников скрыты — все расчёты ведёт сервер.</li><li>При обрыве связи успеешь вернуться, иначе за тебя сходит бот.</li></ul>' +
        '<div class="help-note">PvP не влияет на ежедневный рейтинг — это отдельный зачёт.</div>',
      faq:
        '<h3>Частые вопросы</h3><ul><li><b>Не могу сыграть карту.</b> Проверь фазу: подготовка, огонь или реакция.</li><li><b>Машина не едет.</b> Возможно, пожар, ремонт или пропуск хода — смотри журнал.</li><li><b>Что значит «факт.» в журнале?</b> Это урон после брони и щитов.</li><li><b>Где продолжить?</b> «Продолжить» в гараже; прогресс сохраняется автоматически.</li><li><b>Как открыть рейтинг?</b> «Рейтинг» в гараже или после финиша.</li></ul>' +
        '<h3>Горячие клавиши</h3><p><b>Пробел</b> — бросок/подтверждение, <b>Esc</b> — закрыть окно.</p>' +
        '<div class="help-note">Хочешь заново пройти обучение — кнопка «Пройти обучение заново» ниже.</div>',
    };
    body.innerHTML = content[tab] || content.basics;
  }

  function openHubLeaderboard() {
    UI.leaderboardMode = 'daily';
    renderFullLeaderboard();
    showScreen('leaderboard');
  }

  const ONBOARD_STEPS = [
    { num: '01', title: 'Это гараж', text: 'Три входа: новый заезд, продолжение и рейтинг. Остальное — антураж и профиль.' },
    { num: '02', title: 'Выбери машину', text: 'В новом заезде — четыре машины. У каждой свой корпус, свои слоты и своя способность. «Подробнее» объясняет стиль.' },
    { num: '03', title: 'Гонка — три фазы', text: 'Подготовка (карта или пит), движение (d4 + модификаторы), огонь (атака или ловушка). Финиш — нужное число кругов.' },
  ];

  function maybeShowOnboarding() {
    if (lsGet(LS_ONBOARD)) return;
    showOnboarding();
  }

  function showOnboarding() {
    UI.onboardingStep = 0;
    renderOnboarding();
    const el = $('#onboarding');
    if (el) el.hidden = false;
  }

  function renderOnboarding() {
    const step = ONBOARD_STEPS[UI.onboardingStep] || ONBOARD_STEPS[0];
    const dots = $('#onboarding-dots');
    const body = $('#onboarding-body');
    const next = $('#onboarding-next');
    if (dots) dots.innerHTML = ONBOARD_STEPS.map((_, i) => '<span class="onboarding-dot' + (i === UI.onboardingStep ? ' active' : '') + '"></span>').join('');
    if (body) body.innerHTML = '<div class="onb-num">' + step.num + '</div><h3>' + esc(step.title) + '</h3><p>' + esc(step.text) + '</p>';
    if (next) next.textContent = UI.onboardingStep === ONBOARD_STEPS.length - 1 ? 'ПОЕХАЛИ' : 'ДАЛЕЕ';
  }

  function finishOnboarding() {
    lsSet(LS_ONBOARD, '1');
    const el = $('#onboarding');
    if (el) el.hidden = true;
    openFactionScreen('race');
  }

  function advanceOnboarding() {
    if (UI.onboardingStep < ONBOARD_STEPS.length - 1) {
      UI.onboardingStep++;
      renderOnboarding();
    } else {
      finishOnboarding();
    }
  }

  function skipOnboarding() {
    lsSet(LS_ONBOARD, '1');
    const el = $('#onboarding');
    if (el) el.hidden = true;
  }

  async function maybeShowRaceHint() {
    if (lsGet(LS_HINTS)) return;
    lsSet(LS_HINTS, '1');
    await modal(
      '<h3>ПЕРВЫЙ ЗАЕЗД</h3>' +
      '<p>Ход состоит из трёх фаз. Сыграй карту в подготовке — или сразу бросай d4 и двигайся.</p>' +
      '<ol style="margin-top:10px;padding-left:20px;display:flex;flex-direction:column;gap:5px">' +
      '<li><b>Подготовка</b> — карта до движения или пит-стоп.</li>' +
      '<li><b>Движение</b> — d4 + модификаторы; машина едет на итоговую сумму.</li>' +
      '<li><b>Огонь</b> — атака или ловушка.</li></ol>' +
      '<p style="margin-top:10px;color:var(--muted)">Кнопка <b>?</b> вверху открывает полный устав.</p>' +
      '<div class="modal-actions"><button class="act-btn primary" id="hint-go" type="button">ПОГНАЛИ</button></div>',
      (rootEl, close) => {
        const b = $('#hint-go', rootEl);
        if (b) b.addEventListener('click', () => close(true));
      },
      { maxWidth: '560px' }
    );
  }


  /* ------------------------------------------------------------------ */
  /* Лидерборд                                                          */
  /* ------------------------------------------------------------------ */
  function renderLeaderboard(containerSel, rows, myAccountId) {
    const el = $(containerSel);
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="lb-empty">Пока пусто. <button id="lb-empty-new" class="ghost-btn" type="button">СЫГРАТЬ ПЕРВЫЙ ЗАЕЗД</button></div>';
      return;
    }
    const head = '<div class="lb-row head"><div>#</div><div>Гонщик</div><div class="num">ОЧКИ</div><div class="num">УРОН</div><div class="num">МЕСТО</div></div>';
    el.innerHTML = head + rows.map((r) => {
      const f = faction(r.faction);
      const me = myAccountId && r.accountId === myAccountId;
      return '<div class="lb-row' + (me ? ' me' : '') + '">' +
        '<div class="rank">' + r.rank + '</div>' +
        '<div class="who"><b style="color:' + f.color + '">' + esc(r.displayName) + '</b><span>' + esc(f.name) + '</span></div>' +
        '<div class="num score">' + r.score + '</div>' +
        '<div class="num">' + (r.detail ? r.detail.damage : '—') + '</div>' +
        '<div class="num">' + (r.detail ? r.detail.pos : '—') + '</div>' +
        '</div>';
    }).join('');
  }

  async function loadLeaderboard(scope, mode) {
    const params = { mode, limit: 20 };
    const sel = scope === 'auth' ? '#auth-leaderboard' : '#leaderboard-full';
    try {
      const data = await API.leaderboard(params);
      renderLeaderboard(sel, data.rows, UI.account ? UI.account.id : null);
    } catch (e) {
      const el = $(sel);
      if (el) el.innerHTML = '<div class="lb-empty">Не удалось загрузить рейтинг.</div>';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Инициализация и события                                            */
  /* ------------------------------------------------------------------ */
  async function bootstrap() {
    try {
      const me = await API.me();
      UI.account = me.account;
      UI.stats = me.stats;
      UI.activeRun = me.activeRun || null;
      UI.activeSave = me.activeSave || null;
      showScreen('lobby');
      renderLobby();
      loadDaily();
      maybeShowOnboarding();
    } catch (e) {
      showScreen('auth');
      loadLeaderboard('auth', 'daily');
    }
  }

  function init() {
    // auth
    $$('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.auth)));
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#auth-help').addEventListener('click', () => openHelp('auth'));

    // гараж
    $('#logout-btn').addEventListener('click', async () => {
      try { await API.logout(); } catch (e) {}
      disconnectPvp();
      UI.account = null;
      UI.stats = null;
      UI.activeRun = null;
      UI.activeSave = null;
      UI.daily = null;
      showScreen('auth');
    });
    $('#hub-new').addEventListener('click', () => openFactionScreen('race'));
    $('#hub-continue').addEventListener('click', () => { if (UI.activeSave) continueRun(); });
    $('#hub-leaderboard').addEventListener('click', openHubLeaderboard);
    $('#hub-help').addEventListener('click', () => openHelp('lobby'));
    $('#hub-help-top').addEventListener('click', () => openHelp('lobby'));

    // выбор машины
    $('#faction-back').addEventListener('click', () => backToLobby());
    $('#faction-start').addEventListener('click', () => {
      if (UI.newRaceMode === 'daily') startDaily(); else startRace();
    });
    $$('#faction-tabs .faction-tab').forEach((t) => t.addEventListener('click', () => {
      const mode = t.dataset.mode === 'daily' ? 'daily' : 'race';
      if (mode === 'daily' && !UI.daily) { showToast('Ежедневный заезд недоступен.', 'event', 2200); return; }
      UI.newRaceMode = mode;
      renderFactionCards();
    }));

    // обучение / помощь
    $$('#help-tabs .help-tab').forEach((t) => t.addEventListener('click', () => renderHelp(t.dataset.help)));
    $$('#help-overlay [data-help-close]').forEach((b) => b.addEventListener('click', closeHelp));
    $('#help-replay').addEventListener('click', () => {
      try { localStorage.removeItem(LS_ONBOARD); localStorage.removeItem(LS_HINTS); } catch (e) {}
      closeHelp();
      showOnboarding();
    });
    $('#onboarding-next').addEventListener('click', advanceOnboarding);
    $('#onboarding-skip').addEventListener('click', skipOnboarding);
    $('#game-help').addEventListener('click', () => openHelp('game'));
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'lb-empty-new') openFactionScreen('race');
    });

    // game
    $('#save-now-btn').addEventListener('click', () => { if (UI.game && UI.saveId) doSave(); });
    $('#game-menu-btn').addEventListener('click', async () => {
      if (!UI.game || UI.game.race.over) { backToLobby(); return; }
      const yes = await modal(
        '<h3>ВЫЙТИ В ГАРАЖ?</h3><p>Прогресс сохранится автоматически. Заезд останется активным — его можно продолжить.</p>' +
        '<div class="modal-actions"><button class="act-btn ghost" data-close>ОСТАТЬСЯ</button>' +
        '<button class="act-btn primary" id="confirm-leave">В ГАРАЖ</button></div>',
        (rootEl, close) => {
          $('#confirm-leave', rootEl).addEventListener('click', () => close(true));
        });
      if (yes) { flushAutosave(); backToLobby(); }
    });

    // board: мини-модели, иллюстрации карт, камера, HP и журнал
    loadMinis();
    loadCardArt();
    $('#cam-toggle').addEventListener('click', toggleCamera);
    $('#hp-toggle').addEventListener('click', () => {
      UI.showHp = !UI.showHp;
      $('#hp-toggle').classList.toggle('active', UI.showHp);
      renderBoard();
    });
    $('#zoom-in').addEventListener('click', () => setCamZoom(UI.camZoom + 0.25));
    $('#zoom-out').addEventListener('click', () => setCamZoom(UI.camZoom - 0.25));
    $('#zoom-fit').addEventListener('click', () => setCamMode('overview'));
    $('#minimap').addEventListener('click', toggleCamera);
    $('#log-toggle').addEventListener('click', () => {
      UI.logCollapsed = !UI.logCollapsed;
      $('#log').classList.toggle('collapsed', UI.logCollapsed);
      $('#log-toggle').textContent = UI.logCollapsed ? 'развернуть' : 'свернуть';
    });
    // Журнал свёрнут по умолчанию — меньше визуального шума.
    if (UI.logCollapsed) {
      $('#log').classList.add('collapsed');
      $('#log-toggle').textContent = 'развернуть';
    }

    // results
    $('#results-new').addEventListener('click', () => openFactionScreen('race'));
    $('#results-leaderboard').addEventListener('click', () => {
      UI.leaderboardMode = UI.mode === 'daily' ? 'daily' : 'race';
      renderFullLeaderboard();
      showScreen('leaderboard');
    });
    $('#results-menu').addEventListener('click', () => backToLobby());

    // leaderboard
    $('#lb-back-btn').addEventListener('click', () => backToLobby());
    $$('[data-scope="full"] .board-tab').forEach((t) => {
      t.addEventListener('click', () => {
        $$('[data-scope="full"] .board-tab').forEach((b) => b.classList.toggle('active', b === t));
        loadLeaderboard('full', t.dataset.lb);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#help-overlay').hidden) { closeHelp(); return; }
        if (!$('#onboarding').hidden) { skipOnboarding(); return; }
        if (UI.modalClose) { UI.modalClose(null); return; }
      }
      if (UI.modalClose) return;
      if (e.key === ' ' && UI.screen === 'game' && humanReady() && UI.game.race.phase === 'prep') {
        e.preventDefault();
        const btn = $('#roll-btn');
        if (btn) btn.click();
      }
    });

    window.addEventListener('pagehide', () => flushAutosave());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutosave(); });

    window.addEventListener('unhandledrejection', (e) => {
      console.warn('unhandledrejection', e.reason);
    });

    renderFactionCards();
    setAuthMode('login');
    bindPvp();
    bootstrap();
  }

  function renderFullLeaderboard() {
    const mode = UI.leaderboardMode;
    $$('[data-scope="full"] .board-tab').forEach((b) => b.classList.toggle('active', b.dataset.lb === mode));
    loadLeaderboard('full', mode);
  }

  /* ================================================================== */
  /* PvP (фаза 2) — лобби + WS + проекция + таймер (07-pvp-protocol.md) */
  /* ================================================================== */
  const PVP = {
    socket: null,
    lobby: null,
    joinedCode: null,
    gameId: null,
    mySlot: null,
    myCarId: null,
    seq: 0,
    projection: null,
    deadline: null,
    timerRemainingMs: null,
    timerInterval: null,
  };

  function pvpTimerValue() {
    const v = $('#pvp-timer-select').value;
    return v === 'null' ? null : (Number(v) || 90);
  }

  function sendPvp(msg) {
    if (!PVP.socket) return false;
    msg.ackSeq = PVP.seq;
    msg.clientId = CnA_WS.uuid();
    return PVP.socket.send(msg);
  }

  function connectPvp() {
    disconnectPvp();
    PVP.socket = new CnA_WS.PvpSocket({
      onMessage: onPvpMessage,
      onOpen: () => {
        if (PVP.joinedCode) PVP.socket.send({ type: 'join_lobby', lobbyCode: PVP.joinedCode });
      },
      onClose: () => {},
    });
    PVP.socket.connect();
  }

  function disconnectPvp() {
    if (PVP.socket) { PVP.socket.close(); PVP.socket = null; }
    stopPvpTimer();
  }

  function onPvpMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'hello': break;
      case 'lobby_update': PVP.lobby = msg.lobby; renderPvpLobby(); break;
      case 'game_start': PVP.gameId = msg.gameId; if (msg.seq != null) PVP.seq = msg.seq; break;
      case 'state': applyState(msg.seq, msg.projection); break;
      case 'reconnect_ok':
        PVP.mySlot = msg.slot;
        PVP.myCarId = null;
        applyState(msg.seq, msg.projection);
        break;
      case 'your_turn':
        PVP.mySlot = msg.slot;
        PVP.myCarId = msg.carId;
        PVP.deadline = msg.deadline != null ? msg.deadline : null;
        PVP.timerRemainingMs = null;
        startPvpTimer();
        if (UI.screen === 'game') {
          if (PVP.projection) renderPvp();
          else renderPvpTurnCard();
        }
        break;
      case 'turn_timeout':
        PVP.timerRemainingMs = msg.remainingMs;
        if (PVP.deadline == null) startPvpTimer(); else updatePvpTimer();
        break;
      case 'route_choice': handleRouteChoice(msg); break;
      case 'result': showPvpResult(msg); break;
      case 'opponent_left':
        showToast(esc((msg.displayName || 'Игрок') + ' покинул игру (' + (msg.reason === 'resign' ? 'сдался' : 'разрыв') + ').'), 'event', 3200);
        break;
      case 'error': showToast(esc(msg.message || msg.code), 'damage', 3200); break;
      case 'pong': break;
      default: break;
    }
  }

  function applyState(seq, projection) {
    PVP.seq = seq;
    enterPvpGame();
    applyProjection(projection);
  }

  function applyProjection(projection) {
    PVP.projection = projection;
    if (projection && projection.cars) {
      const my = projection.cars.find((c) => c.human);
      if (my) PVP.myCarId = my.id;
    }
    if (PVP.myCarId != null && projection && projection.race && projection.race.currentId !== PVP.myCarId) {
      stopPvpTimer();
      PVP.deadline = null;
      PVP.timerRemainingMs = null;
    }
    renderPvp();
  }

  function enterPvpGame() {
    if (UI.screen !== 'game') showScreen('game');
    $('#save-now-btn').hidden = true;
    $('#save-status').hidden = true;
    $('#game-menu-btn').hidden = true;
    $('#game-help').hidden = true;
    $('#pvp-resign-btn').hidden = false;
  }

  function leavePvpGame() {
    $('#save-now-btn').hidden = false;
    $('#save-status').hidden = false;
    $('#game-menu-btn').hidden = false;
    $('#game-help').hidden = false;
    $('#pvp-resign-btn').hidden = true;
    PVP.projection = null;
  }

  /* ---------- рендер проекции ---------- */
  function renderPvp() {
    const proj = PVP.projection;
    if (!proj) return;
    UI.game = proj;
    renderPvpMeta();
    renderBoard();
    renderPvpPlayers();
    renderPvpTurnCard();
    renderPvpPhaseStrip();
    renderPvpHand();
    renderLog();
  }

  function renderPvpMeta() {
    const proj = PVP.projection;
    if (!proj || !proj.race || !proj.race.track) return;
    const leader = CnA.raceLeader(proj);
    const lf = leader ? faction(leader.factionId) : null;
    $('#game-mode-label').textContent = 'PvP';
    $('#race-meta').innerHTML =
      '<span class="pill">PvP</span>' +
      '<span>раунд <b>' + proj.race.round + '</b></span>' +
      '<span>круг <b>' + proj.laps + '</b></span>' +
      '<span>сид <b>' + proj.seed + '</b></span>';
    $('#track-label').textContent = proj.race.track.label || (proj.race.track.count + ' тайлов');
    $('#leader-label').innerHTML = lf ? 'ЛИДЕР: <b style="color:' + lf.color + '">' + esc(leader.name) + '</b>' : 'ЛИДЕР: —';
  }

  function renderPvpPlayers() {
    const proj = PVP.projection;
    if (!proj || !proj.cars || !proj.race) return;
    const order = proj.cars.slice().sort((a, b) => {
      if (a.finished && b.finished) return (a.finishPos || 9) - (b.finishPos || 9);
      if (a.finished) return -1;
      if (b.finished) return 1;
      return CnA.progressOf(proj, b) - CnA.progressOf(proj, a);
    });
    const pos = {};
    order.forEach((c, i) => { pos[c.id] = i + 1; });
    const cur = proj.cars.find((c) => c.id === proj.race.currentId) || null;
    $('#players').innerHTML = proj.cars.map((c) => {
      const f = faction(c.factionId);
      const hpPct = Math.max(0, Math.min(100, c.hp / c.maxHp * 100));
      const handCount = Array.isArray(c.hand) ? c.hand.length : (c.hand && c.hand.count);
      const statuses = [];
      if (c.finished) statuses.push('<span class="st">ФИНИШ</span>');
      if (c.destroyed) statuses.push('<span class="st down">ВНЕ ИГРЫ</span>');
      if (c.pit) statuses.push('<span class="st pit">ПИТ</span>');
      if (c.burn) statuses.push('<span class="st burn">ГОРИТ</span>');
      if (c.smoke) statuses.push('<span class="st smoke">ДЫМ</span>');
      if (c.shield > 0) statuses.push('<span class="st prot">БРОНЯ ' + c.shield + '</span>');
      if (c.emp) statuses.push('<span class="st burn">ЭМИ</span>');
      const ups = (c.upgrades || []).map((id) => '<span class="up" title="' + esc((CnA.upgrade(id) || {}).name || id) + '">' + (UP_SHORT[id] || id) + '</span>').join('');
      const cls = 'player' + (cur && cur.id === c.id ? ' active' : '') + (c.finished || c.destroyed ? ' out' : '');
      return '<div class="' + cls + '" style="--fc:' + f.color + '">' +
        '<div class="p-top"><span class="p-name"><span class="p-glyph" title="' + esc(f.name) + '">' + f.glyph + '</span>' + esc(c.name) + (c.human ? ' ★ВЫ' : '') + '</span><span class="p-pos">' + pos[c.id] + '/4</span></div>' +
        '<div class="p-stats"><span>КОРПУС <b>' + c.hp + '</b></span><span>ОЧ <b>' + c.cp + '</b></span><span>ЛОМ <b>' + c.scrap + '</b></span><span>КАРТ <b>' + handCount + '</b></span></div>' +
        '<div class="hp-bar"><div class="hp-fill" style="width:' + hpPct + '%"></div><span class="hp-mark" style="left:50%"></span><span class="hp-mark" style="left:20%"></span></div>' +
        '<div class="p-status">' + statuses.join('') + '</div>' +
        (ups ? '<div class="p-upgrades">' + ups + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderPvpTurnCard() {
    const proj = PVP.projection;
    const card = $('#turn-card');
    if (!proj || !proj.race) { card.innerHTML = ''; return; }
    const my = proj.cars.find((c) => c.human);
    const cur = proj.cars.find((c) => c.id === proj.race.currentId) || null;
    const isMyTurn = !!(my && cur && my.id === cur.id);
    const phase = proj.race.phase;
    const f = cur ? faction(cur.factionId) : null;

    card.classList.toggle('pvp-your-turn', isMyTurn);
    card.style.setProperty('--fc', f ? f.color : '#c8a04e');

    const status = [];
    if (cur) {
      status.push('корпус ' + cur.hp + '/' + cur.maxHp);
      if (cur.burn) status.push('горит');
      if (cur.smoke) status.push('дым');
      if (cur.pit) status.push('в боксах');
      if (cur.shield > 0) status.push('броня ' + cur.shield);
      if (cur.emp) status.push('ЭМИ');
    }
    const timerHtml = (isMyTurn && (PVP.deadline != null || PVP.timerRemainingMs != null))
      ? '<div class="pvp-timer" id="pvp-timer"></div>'
      : '';
    const lap = cur ? Math.min(proj.laps, Math.max(1, (cur.lapsDone || 0) + 1)) : 1;

    card.innerHTML =
      '<div class="turn-head">' +
      '<div><div class="turn-who" style="color:' + (f ? f.color : '#c8a04e') + '">' + (cur ? esc(cur.name) : '—') + '</div>' +
      '<div class="turn-sub">' + (isMyTurn ? 'ТВОЙ ХОД' : 'ХОД СОПЕРНИКА') + '</div></div>' +
      '<div class="turn-phase">' + phaseLabel(phase) + '</div>' +
      '</div>' +
      timerHtml +
      '<div class="turn-sub" style="margin-top:8px">РАУНД ' + proj.race.round + ' · КРУГ ' + lap + '/' + proj.laps + '</div>' +
      '<div class="turn-sub" style="margin-top:6px">' + esc(status.join(' · ')) + '</div>';

    updatePvpTimer();
  }

  /* Нижняя полоса фаз PvP: те же чипы/подсказка/действия, что в одиночном заезде. */
  function renderPvpPhaseStrip() {
    const proj = PVP.projection;
    const el = $('#phase-strip');
    if (!el) return;
    if (!proj || !proj.race) { el.innerHTML = ''; return; }
    const my = proj.cars.find((c) => c.human);
    const cur = proj.cars.find((c) => c.id === proj.race.currentId) || null;
    const isMyTurn = !!(my && cur && my.id === cur.id);
    const phase = proj.race.phase;

    const chips = [['prep', 'ПОДГОТОВКА'], ['move', 'ДВИЖЕНИЕ'], ['fire', 'ОГОНЬ']].map(([p, label]) => {
      const active = phase === p;
      const done = (p === 'prep' && (phase === 'move' || phase === 'fire' || phase === 'done')) ||
                   (p === 'move' && (phase === 'fire' || phase === 'done'));
      return '<span class="phase-chip' + (active ? ' active' : done ? ' done' : '') + '">' + label + '</span>';
    }).join('');

    let hint = '';
    let actions = '';
    if (!cur) {
      hint = 'Гонка завершена.';
    } else if (isMyTurn) {
      if (phase === 'prep') {
        hint = 'Сыграй карту, объяви пит-стоп — или сразу бросай d4.';
        actions += '<button id="pvp-roll-btn" class="act-btn primary">БРОСОК d4</button>';
        if (my && CnA.isPitNode(proj, my.node) && !(my.flags && my.flags.pitThisRace)) {
          actions += '<button id="pvp-pit-btn" class="act-btn sky">ПИТ-СТОП</button>';
        }
        if (my && my.factionId === 'rust' && !(my.flags && my.flags.repairUsed) && my.hp < my.maxHp) {
          actions += '<button id="pvp-ability-rust" class="act-btn">ЛАТАЕМ НА ХОДУ</button>';
        }
        if (my && my.factionId === 'carnival' && !(my.flags && my.flags.mineReturned)) {
          actions += '<button id="pvp-ability-mine" class="act-btn">ВЕРНУТЬ МИНУ</button>';
        }
        if (my && CnA.hasUpgrade(my, 'turbo') && !(my.flags && my.flags.turboUsed) && !(my.flags && my.flags.turboArmed)) {
          actions += '<button id="pvp-ability-turbo" class="act-btn">ТУРБИНА</button>';
        }
      } else if (phase === 'move') {
        const t = proj.race.turn || { speed: 0, remaining: 0 };
        hint = 'Движение: ' + (t.speed || 0) + ' · осталось ' + (t.remaining || 0) + '.';
      } else if (phase === 'fire') {
        hint = 'Фаза огня: одна атака или ловушка. После выстрела — отдача: −1 к движению.';
        const t = proj.race.turn || {};
        if (my && my.factionId === 'chrome' && !t.fireUsed && ((my.flags && my.flags.wildfireCharges) || 0) > 0) {
          const charges = my.flags.wildfireCharges;
          const armed = t.wildfire;
          actions = '<button id="pvp-ability-wildfire" class="act-btn ' + (armed ? 'primary' : '') + '">WILDFIRE ' + charges + '/2</button>' + actions;
        }
      } else {
        hint = 'Ход завершается…';
      }
      actions += '<button id="pvp-end-btn" class="act-btn primary">ЗАВЕРШИТЬ ХОД</button>';
    } else {
      hint = 'Ход соперника.';
      actions += '<button class="act-btn ghost" disabled>ХОД СОПЕРНИКА</button>';
    }

    const lap = cur ? Math.min(proj.laps, Math.max(1, (cur.lapsDone || 0) + 1)) : 1;
    const turnLine = 'РАУНД ' + proj.race.round + ' · КРУГ ' + lap + '/' + proj.laps + ' · ' + (isMyTurn ? 'ТВОЙ ХОД' : 'ХОД СОПЕРНИКА');
    el.innerHTML =
      '<div class="phase-chips">' + chips + '</div>' +
      '<div class="phase-info"><span class="phase-turn">' + turnLine + '</span><span class="phase-hint">' + hint + '</span></div>' +
      '<div class="phase-actions">' + actions + '</div>';

    const rollBtn = $('#pvp-roll-btn');
    if (rollBtn) rollBtn.addEventListener('click', pvpRoll);
    const pitBtn = $('#pvp-pit-btn');
    if (pitBtn) pitBtn.addEventListener('click', pvpPit);
    const rustBtn = $('#pvp-ability-rust');
    if (rustBtn) rustBtn.addEventListener('click', () => pvpAbility('rust'));
    const mineBtn = $('#pvp-ability-mine');
    if (mineBtn) mineBtn.addEventListener('click', () => pvpAbility('returnMine'));
    const turboBtn = $('#pvp-ability-turbo');
    if (turboBtn) turboBtn.addEventListener('click', () => pvpAbility('turbo'));
    const wildfireBtn = $('#pvp-ability-wildfire');
    if (wildfireBtn) wildfireBtn.addEventListener('click', () => pvpAbility('wildfire'));
    const endBtn = $('#pvp-end-btn');
    if (endBtn) endBtn.addEventListener('click', pvpEndTurn);
  }

  function pvpCardMarkup(h, playable) {
    const card = CnA.CARDS[h.type];
    if (!card) return '';
    const kindCls = card.kind === 'attack' ? 'attack' : card.kind === 'trap' ? 'trap' : card.kind === 'prep' ? 'prep' : 'reaction';
    const phaseText = card.phase === 'prep' ? 'ПОДГОТОВКА' : card.phase === 'fire' ? 'ОГОНЬ' : 'РЕАКЦИЯ';
    const stats = card.noDamage
      ? 'эффект' + (card.range ? ' · ' + card.range : '')
      : (card.dmg && card.dmg !== '—' ? card.dmg + (card.range ? ' · ' + card.range : '') : (card.kind === 'prep' ? 'эффект' : '—'));
    const icon = CARD_ICON[card.id] || '·';
    const art = CARD_ART[card.id]
      ? '<img class="card-illu" src="' + assetUrl('card', card.id) + '" alt="">'
      : '<div class="card-art">' + esc(icon) + '</div>';
    return '<button class="card ' + kindCls + (playable ? '' : ' disabled') + '" data-uid="' + h.uid + '" title="' + esc(card.text) + '">' +
      '<div class="phase">' + phaseText + '</div>' +
      art +
      '<div class="cname">' + esc(card.name) + '</div>' +
      '<div class="cstats">' + esc(stats) + '</div>' +
      '<div class="cshort">' + esc(card.short) + '</div>' +
      (card.phase === 'reaction' ? '<div class="badge-auto">АВТО</div>' : '') +
      '</button>';
  }

  function renderPvpHand() {
    const proj = PVP.projection;
    if (!proj || !proj.cars) { $('#hand-zone').innerHTML = ''; return; }
    const my = proj.cars.find((c) => c.human);
    const cur = proj.race ? (proj.cars.find((c) => c.id === proj.race.currentId) || null) : null;
    const isMyTurn = !!(my && cur && my.id === cur.id);
    const handCount = (my && Array.isArray(my.hand)) ? my.hand.length : 0;
    const head = '<div class="hand-head"><h3>РУКА АРСЕНАЛА</h3><span class="hand-count">' +
      handCount + ' / 5</span></div>';
    if (!my || !Array.isArray(my.hand)) {
      $('#hand-zone').innerHTML = head + '<div class="empty-hand">Рука скрыта.</div>';
      return;
    }
    const cards = my.hand.map((h) => pvpCardMarkup(h, isMyTurn)).join('');
    $('#hand-zone').innerHTML = head + '<div class="hand">' + (cards || '<div class="empty-hand">Рука пуста.</div>') + '</div>';
    $$('#hand-zone .card[data-uid]').forEach((el) => {
      el.addEventListener('click', () => { if (isMyTurn) onPvpHandCard(Number(el.dataset.uid)); });
    });
  }

  /* ---------- ввод ---------- */
  function pvpRoll() { sendPvp({ type: 'roll' }); }
  function pvpEndTurn() { sendPvp({ type: 'end_turn' }); }
  function pvpPit() { sendPvp({ type: 'pit' }); }
  function pvpAbility(id) { sendPvp({ type: 'ability', id }); }

  function handleRouteChoice(msg) {
    const proj = PVP.projection;
    if (!proj) return;
    const options = msg.options || [];
    UI.highlightRouteNodes = options.map((o) => o.node);
    renderBoard();
    pvpChooseRouteModal(options).then((nodeId) => {
      UI.highlightRouteNodes = [];
      renderBoard();
      const chosen = nodeId != null ? nodeId : (options[0] ? options[0].node : null);
      if (chosen != null) sendPvp({ type: 'choose_route', nodeId: chosen });
    });
  }

  function pvpChooseRouteModal(options) {
    const proj = PVP.projection;
    const my = proj.cars.find((c) => c.human);
    const curNode = my ? proj.race.track.nodes[my.node] : null;
    const rows = options.map((o, i) => {
      const node = proj.race.track.nodes[o.node];
      const type = node ? (CnA.TILES[node.type] ? CnA.TILES[node.type].label : node.type) : o.node;
      let label = 'Объезд';
      if (o.jump) label = 'Прыжок с трамплина';
      else if (node && node.pitLane) label = 'Пит-лейн';
      else if (curNode && curNode.pitEntry) label = 'Трасса';
      else if (node && node.inner) label = 'Короткий срез';
      return '<button class="target-btn" data-route="' + i + '">' +
        '<b>' + esc(label) + ' → ' + esc(type) + '</b>' +
        '<span>тайл ' + o.node + (o.jump ? ' · перелёт через ' + o.via : '') + '</span></button>';
    }).join('');
    const isPitChoice = !!(curNode && curNode.pitEntry);
    return modal(
      '<h3>' + (isPitChoice ? 'ПИТ-ЛЕЙН' : 'РАЗВИЛКА') + '</h3><p>Выбери маршрут.</p>' +
      '<div class="target-list">' + rows + '</div>',
      (rootEl, close) => {
        $$('[data-route]', rootEl).forEach((b) => b.addEventListener('click', () => close(options[Number(b.dataset.route)].node)));
      });
  }

  function pvpAttackTargets(cardType) {
    const proj = PVP.projection;
    const my = proj.cars.find((c) => c.human);
    if (!my) return [];
    try {
      return CnA.attackTargets(proj, my, cardType).map((t) => t.carId);
    } catch (e) {
      return proj.cars.filter((c) => c.id !== my.id && !c.finished && !c.destroyed).map((c) => c.id);
    }
  }

  function pvpTrapNodes(uid) {
    const proj = PVP.projection;
    const my = proj.cars.find((c) => c.human);
    if (!my) return [];
    try {
      return CnA.trapOptions(proj, my, uid).map((o) => o.node);
    } catch (e) {
      return [my.node];
    }
  }

  async function onPvpHandCard(uid) {
    const proj = PVP.projection;
    const my = proj.cars.find((c) => c.human);
    if (!my || !Array.isArray(my.hand)) return;
    const h = my.hand.find((x) => x.uid === uid);
    if (!h) return;
    const card = CnA.CARDS[h.type];
    if (!card) return;

    if (card.kind === 'attack') {
      const targets = pvpAttackTargets(h.type);
      if (!targets.length) { showToast('Нет целей.', 'damage'); return; }
      if (card.twin) {
        const t1 = await pvpChooseTarget(card, targets);
        if (t1 == null) return;
        const rest = targets.filter((id) => id !== t1);
        if (!rest.length) { showToast('Нужны две цели.', 'damage'); return; }
        const t2 = await pvpChooseTarget(card, rest);
        if (t2 == null) return;
        sendPvp({ type: 'play_card', uid, targets: [t1, t2] });
      } else {
        const target = await pvpChooseTarget(card, targets);
        if (target == null) return;
        sendPvp({ type: 'play_card', uid, target });
      }
      return;
    }
    if (card.kind === 'trap') {
      const nodes = pvpTrapNodes(uid);
      if (!nodes.length) { showToast('Нет места для ловушки.', 'damage'); return; }
      const node = await pvpChooseTrapNode(card, nodes);
      if (node == null) return;
      sendPvp({ type: 'play_card', uid, node });
      return;
    }
    sendPvp({ type: 'play_card', uid });
  }

  function pvpChooseTarget(card, targets) {
    const proj = PVP.projection;
    const rows = targets.map((id) => {
      const t = proj.cars.find((c) => c.id === id);
      if (!t) return '';
      const f = faction(t.factionId);
      const valText = card.noDamage ? 'эффект' : (card.dmg || '');
      return '<button class="target-btn" data-target="' + id + '">' +
        '<b>' + esc(t.name) + '</b>' +
        '<span style="color:' + f.color + '">' + esc(f.name) + ' · корпус ' + t.hp + '/' + t.maxHp + ' · <span class="tval">' + esc(valText) + '</span></span></button>';
    }).join('');
    return modal('<h3>' + esc(card.name) + '</h3><p>Выбери цель. Сервер проверит дальность.</p><div class="target-list">' + rows + '</div>' +
      '<div class="modal-actions"><button class="act-btn ghost" data-close>ОТМЕНА</button></div>',
      (rootEl, close) => {
        $$('[data-target]', rootEl).forEach((b) => b.addEventListener('click', () => close(Number(b.dataset.target))));
      });
  }

  function pvpChooseTrapNode(card, nodes) {
    const proj = PVP.projection;
    const my = proj.cars.find((c) => c.human);
    const rows = nodes.map((n) => {
      const node = proj.race.track.nodes[n];
      const t = node ? (CnA.TILES[node.type] ? CnA.TILES[node.type].label : node.type) : n;
      return '<button class="target-btn" data-node="' + n + '">' +
        '<b>' + (my && n === my.node ? 'Свой тайл' : 'Тайл позади') + ' · ' + esc(t) + '</b>' +
        '<span>тайл ' + n + '</span></button>';
    }).join('');
    return modal('<h3>' + esc(card.name) + '</h3><p>Куда поставить?</p><div class="target-list">' + rows + '</div>',
      (rootEl, close) => {
        $$('[data-node]', rootEl).forEach((b) => b.addEventListener('click', () => close(Number(b.dataset.node))));
      });
  }

  async function pvpResign() {
    const yes = await modal(
      '<h3>СДАТЬСЯ?</h3><p>Твой слот перейдёт боту. В течение окна возврата можно вернуться по коду лобби.</p>' +
      '<div class="modal-actions"><button class="act-btn ghost" data-close>ОСТАТЬСЯ</button>' +
      '<button class="act-btn primary" id="pvp-resign-ok">СДАТЬСЯ</button></div>',
      (rootEl, close) => {
        $('#pvp-resign-ok', rootEl).addEventListener('click', () => close(true));
      });
    if (yes) sendPvp({ type: 'resign' });
  }

  /* ---------- таймер ---------- */
  function pvpDeadlineMs(deadline) {
    if (deadline == null) return null;
    if (typeof deadline === 'number') return deadline;
    const t = Date.parse(deadline);
    return isNaN(t) ? null : t;
  }

  function startPvpTimer() {
    stopPvpTimer();
    if (PVP.deadline == null && PVP.timerRemainingMs == null) return;
    updatePvpTimer();
    PVP.timerInterval = setInterval(updatePvpTimer, 1000);
  }

  function stopPvpTimer() {
    if (PVP.timerInterval) { clearInterval(PVP.timerInterval); PVP.timerInterval = null; }
  }

  function updatePvpTimer() {
    const el = $('#pvp-timer');
    if (!el) return;
    let remaining = null;
    if (PVP.deadline != null) {
      const d = pvpDeadlineMs(PVP.deadline);
      if (d != null) remaining = Math.max(0, d - Date.now());
    }
    if (remaining == null && PVP.timerRemainingMs != null) remaining = PVP.timerRemainingMs;
    if (remaining == null) { el.textContent = ''; return; }
    el.textContent = Math.ceil(remaining / 1000) + 'с';
    el.classList.toggle('low', remaining < 10000);
  }

  function showPvpResult(msg) {
    stopPvpTimer();
    const rows = (msg.standings || []).map((s, i) => {
      const f = faction(s.factionId || s.faction);
      const place = s.place || (i + 1);
      return '<div class="res-row" style="--fc:' + f.color + '">' +
        '<div class="place">' + place + '</div>' +
        '<div class="who"><b>' + esc(s.name) + '</b><span>' + esc(f.name) + '</span></div>' +
        '<div class="num cp">' + s.cp + '</div>' +
        '<div class="num">' + s.damage + '</div>' +
        '<div class="num">' + s.kills + '</div>' +
        '</div>';
    }).join('');
    modal('<h3>ИГРА ЗАВЕРШЕНА</h3><div class="results-table">' + (rows || '<p>—</p>') + '</div>' +
      '<div class="modal-actions"><button class="act-btn primary" id="pvp-result-ok">В ГАРАЖ</button></div>',
      (rootEl, close) => {
        $('#pvp-result-ok', rootEl).addEventListener('click', () => {
          close(true);
          leavePvpGame();
          PVP.lobby = null;
          showScreen('pvpLobby');
          renderPvpLobby();
        });
      });
  }

  /* ---------- лобби ---------- */
  function openPvpLobby() {
    showScreen('pvpLobby');
    renderPvpLobby();
  }

  function renderPvpLobby() {
    const panels = $('#pvp-lobby-panels');
    const state = $('#pvp-lobby-state');
    if (!PVP.lobby) {
      panels.hidden = false;
      state.hidden = true;
      state.innerHTML = '';
      return;
    }
    const lobby = PVP.lobby;
    panels.hidden = true;
    state.hidden = false;
    const isOwner = lobby.ownerAccountId === (UI.account ? UI.account.id : null);
    const statusLabel = lobby.status === 'playing' ? 'ИГРА ИДЁТ' : lobby.status === 'finished' ? 'ЗАВЕРШЕНА' : 'ОЖИДАНИЕ';
    const timerText = (lobby.config && lobby.config.turnTimerSeconds != null) ? lobby.config.turnTimerSeconds + ' с' : 'без таймера';
    const slotsHtml = (lobby.slots || []).map((s) => {
      const me = s.accountId === (UI.account ? UI.account.id : null);
      const cls = 'pvp-slot' + (s.slot === 0 ? ' owner' : '') + (me ? ' me' : '') +
        (s.controller === 'bot' ? ' bot' : '') + (!s.accountId && s.controller !== 'bot' ? ' empty' : '');
      const name = s.displayName || (s.controller === 'bot' ? 'БОТ' : '—');
      const factionName = s.faction ? faction(s.faction).name : (s.controller === 'bot' ? 'бот' : 'пусто');
      return '<div class="' + cls + '">' +
        '<div class="slot-num">СЛОТ ' + s.slot + (s.slot === 0 ? ' · ВЛАДЕЛЕЦ' : '') + '</div>' +
        '<div class="slot-name">' + esc(name) + (me ? ' (вы)' : '') + '</div>' +
        '<div class="slot-faction">' + esc(factionName) + '</div>' +
        '</div>';
    }).join('');

    let actions = '';
    if (lobby.status === 'waiting' && isOwner) actions += '<button id="pvp-start-btn" class="big-btn">СТАРТ</button>';
    actions += '<button id="pvp-leave-btn" class="big-btn secondary">ПОКИНУТЬ</button>';

    state.innerHTML =
      '<div class="panel-head"><span class="num">♛</span><h2>ЛОББИ</h2></div>' +
      '<div class="pvp-code">' + esc(lobby.code) + '</div>' +
      '<div class="pvp-status ' + (lobby.status === 'playing' ? 'playing' : '') + '">' + statusLabel + ' · таймер ' + esc(timerText) + '</div>' +
      '<div class="pvp-slots">' + slotsHtml + '</div>' +
      '<div class="pvp-actions">' + actions + '</div>';

    const startBtn = $('#pvp-start-btn');
    if (startBtn) startBtn.addEventListener('click', pvpStartLobby);
    const leaveBtn = $('#pvp-leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', pvpLeaveLobby);
  }

  async function pvpCreateLobby() {
    const tv = pvpTimerValue();
    try {
      const res = await API.lobbyCreate({ turnTimerSeconds: tv, trackKind: 'mosaic', trackSize: 36, laps: 1 });
      PVP.lobby = res.lobby;
      PVP.joinedCode = res.lobby.code;
      connectPvp();
      renderPvpLobby();
    } catch (e) {
      showToast('Не удалось создать лобби: ' + esc(e.message), 'damage', 3200);
    }
  }

  async function pvpJoinLobby() {
    const code = $('#pvp-join-code').value.trim().toUpperCase();
    if (!code) { showToast('Введи код.', 'damage'); return; }
    try {
      const res = await API.lobbyJoin(code);
      PVP.lobby = res.lobby;
      PVP.joinedCode = code;
      connectPvp();
      renderPvpLobby();
    } catch (e) {
      showToast('Не удалось войти: ' + esc(e.message), 'damage', 3200);
    }
  }

  async function pvpLeaveLobby() {
    const code = PVP.lobby ? PVP.lobby.code : null;
    disconnectPvp();
    PVP.lobby = null;
    PVP.joinedCode = null;
    PVP.projection = null;
    PVP.seq = 0;
    PVP.myCarId = null;
    PVP.mySlot = null;
    renderPvpLobby();
    if (code) { try { await API.lobbyLeave(code); } catch (e) {} }
  }

  async function pvpStartLobby() {
    if (!PVP.lobby) return;
    try {
      await API.lobbyStart(PVP.lobby.code);
    } catch (e) {
      showToast('Не удалось начать: ' + esc(e.message), 'damage', 3200);
    }
  }

  function bindPvp() {
    $('#open-pvp-btn').addEventListener('click', openPvpLobby);
    $('#pvp-back-btn').addEventListener('click', () => { pvpLeaveLobby(); showScreen('lobby'); });
    $('#pvp-create-btn').addEventListener('click', pvpCreateLobby);
    $('#pvp-join-btn').addEventListener('click', pvpJoinLobby);
    $('#pvp-join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') pvpJoinLobby(); });
    $('#pvp-resign-btn').addEventListener('click', pvpResign);
  }

  /* ================================================================== */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(typeof window !== 'undefined' ? window : globalThis);
