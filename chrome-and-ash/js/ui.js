/* ХРОМ И ПЕПЕЛ — интерфейс прототипа. */
(function (root) {
  'use strict';
  const CnA = root.CnA;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const UI = {
    game: null,
    mode: 'race',
    factionId: 'rust',
    trackKind: 'mosaic',
    speed: 1,
    laps: 1,
    patch: false,
    seed: '',
    screen: 'menu',
    stage: 'idle',
    busy: false,
    loopGen: 0,
    humanResolve: null,
    turnEnding: false,
    highlightTargets: [],
    modalClose: null,
    lastDice: null,
    logCollapsed: true,
    resultsShownFor: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    camMode: 'follow',   // 'follow' | 'overview'
    camZoom: 3.6,        // вертикальный масштаб окна слежения
    showHp: false,       // постоянные HP-цифры (по умолчанию только по наведению)
    view: { x: 0, y: 0, w: 1000, h: 784 },
    camAnim: null,
    trackKey: null,
    miniKey: null,
  };
  root.__CnA_UI__ = UI;

  const UP_SHORT = {
    engine2: 'ДВ2', engine3: 'ДВ3', turbo: 'ТУР', armor: 'БРН', reactive: 'РЕА',
    plow: 'ПЛД', suspension: 'ПОД', tracks: 'ГУС', balance: 'БАЛ', turret: 'ТУР',
    barrel: 'СТВ', autoloader: 'АВТ', spikes: 'ШИП', cage: 'КЛТ', magnet: 'МАГ',
  };
  const CAT_COLOR = {
    'Двигатель': '#ff7a1e', 'Броня': '#d8d8d2', 'Шасси': '#c8a04e',
    'Вооружение': '#9e1f1a', 'Корпус': '#a34a24',
  };
  const CARD_ICON = {
    mg: '✹', twin: '⁂', rocket: '➤', harpoon: '↩', mine: '✸', oil: '◉',
    flamer: '▲', smoke: '☁', nitro: '⚡', brake: '■', ramplate: '◣', repair: '✚',
    jammer: '✖', canister: '▣', drone: '✚', boost: '»', ramboost: '⇶', shield: '◈',
    emp: 'ϟ', net: '#', sabotage: '☠', tow: '↩',
  };
  /* Сгенерированные мини-модели машин (assets/factions/<id>/mini.png). */
  const MINI = { chrome: false, rust: false, carnival: false, swarm: false };
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
      img.src = 'assets/factions/' + f.id + '/mini.png';
    });
  }
  /* Иллюстрации карт арсенала: список сгенерированных id (расширяется по мере генерации). */
  const CARD_ART_IDS = ['mg', 'twin', 'harpoon', 'mine', 'oil', 'flamer', 'smoke', 'nitro', 'brake', 'ramplate', 'repair', 'jammer', 'canister', 'drone', 'boost', 'ramboost', 'shield', 'emp', 'net', 'sabotage', 'tow', 'rocket'];
  const CARD_ART = {};
  function loadCardArt() {
    CARD_ART_IDS.forEach((id) => {
      const img = new Image();
      img.onload = () => { CARD_ART[id] = true; if (UI.game) renderHand(); };
      img.onerror = () => { CARD_ART[id] = false; };
      img.src = 'assets/cards/arsenal/' + id + '.png';
    });
  }
  /* Палитра «Закат в Пустоши» (см. docs/05-art-brief-sunset-readability.md §1). */
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

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function faction(id) { return CnA.faction(id); }
  function humanCar() {
    return UI.game ? UI.game.cars.find((c) => c.human) || null : null;
  }
  function currentCar() {
    return UI.game && UI.game.race ? CnA.currentCar(UI.game) : null;
  }
  function isHumanTurn() {
    const c = currentCar();
    return !!c && c.human && !UI.busy;
  }
  function activeScreen() { return UI.screen; }

  /* ------------------------------------------------------------------ */
  /* Экраны и модалки                                                   */
  /* ------------------------------------------------------------------ */
  const SCREENS = {
    menu: 'screen-menu', game: 'screen-game', shop: 'screen-shop',
    results: 'screen-results', final: 'screen-final',
  };

  function showScreen(name) {
    UI.screen = name;
    $$('.screen').forEach((s) => s.classList.remove('active'));
    const el = $('#' + SCREENS[name]);
    if (el) el.classList.add('active');
    window.scrollTo(0, 0);
  }

  function modal(html, setup, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const rootEl = $('#modal-root');
      rootEl.innerHTML =
        '<div class="modal-backdrop" data-backdrop></div>' +
        '<div class="modal" style="' + (opts.maxWidth ? 'max-width:' + opts.maxWidth : '') + '">' +
        '<button class="modal-close" data-close aria-label="Закрыть">×</button>' + html + '</div>';
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
      const back = rootEl.querySelector('[data-backdrop]');
      if (back) back.addEventListener('click', () => close(null));
      $$('[data-close]', rootEl).forEach((b) => b.addEventListener('click', () => close(null)));
      if (setup) setup(rootEl, close);
    });
  }

  function openRules() {
    const html = $('#tpl-rules').innerHTML;
    modal(html, (rootEl) => {
      $$('.rules-tab', rootEl).forEach((tab) => {
        tab.addEventListener('click', () => {
          $$('.rules-tab', rootEl).forEach((t) => t.classList.remove('active'));
          $$('.rules-pane', rootEl).forEach((p) => p.classList.remove('active'));
          tab.classList.add('active');
          const pane = $('#' + tab.dataset.tab, rootEl);
          if (pane) pane.classList.add('active');
        });
      });
    }, { maxWidth: '960px' });
  }

  /* ------------------------------------------------------------------ */
  /* Меню                                                               */
  /* ------------------------------------------------------------------ */
  function renderMenu() {
    const picker = $('#faction-picker');
    picker.innerHTML = CnA.FACTIONS.map((f) => (
      '<button class="faction-card' + (f.id === UI.factionId ? ' active' : '') + '" data-faction="' + f.id + '" ' +
      'style="--fc:' + f.color + '" data-glyph="' + esc(f.glyph) + '">' +
      '<img class="faction-portrait" src="' + CnA.assets.url('faction', f.id, 'portrait') + '" alt="" aria-hidden="true" onerror="this.remove()">' +
      '<span class="fname">' + esc(f.name) + '</span>' +
      '<span class="fcar">' + esc(f.car) + ' · ' + f.hp + ' корпуса · ' + f.slots + ' слотов</span>' +
      '<span class="fstats"><span>КОРПУС ' + f.hp + '</span><span>СЛОТЫ ' + f.slots + '</span>' +
      (f.id === 'rust' ? '<span class="ftag">рекомендуется</span>' : '') + '</span>' +
      '<span class="fability"><b>' + esc(f.abilityName) + '.</b> ' + esc(f.ability) + '</span>' +
      '</button>'
    )).join('');
    $$('#faction-picker .faction-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        UI.factionId = btn.dataset.faction;
        $$('#faction-picker .faction-card').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
    $$('#mode-row .mode-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === UI.mode);
    });
    $('#menu-version').textContent = 'v' + CnA.VERSION + ' · сид ' + (UI.game ? UI.game.seed : '—');
  }

  function bindMenu() {
    $$('#mode-row .mode-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        UI.mode = btn.dataset.mode;
        $$('#mode-row .mode-card').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
    $('#start-btn').addEventListener('click', startGame);
    $('#menu-rules-btn').addEventListener('click', openRules);
    $$('.rules-tab').forEach(() => {});
  }

  function readMenuOptions() {
    UI.trackKind = $('#opt-track').value === 'ring' ? 'ring' : 'mosaic';
    UI.laps = Number($('#opt-laps').value) === 2 ? 2 : 1;
    UI.speed = Number($('#opt-speed').value) || 1;
    UI.patch = $('#opt-patch').checked;
    const raw = $('#opt-seed').value.trim();
    UI.seed = raw ? (Number(raw) >>> 0) : '';
  }

  function startGame() {
    readMenuOptions();
    UI.loopGen++;
    if (UI.humanResolve) { const r = UI.humanResolve; UI.humanResolve = null; r(); }
    UI.humanResolve = null;
    UI.busy = false;
    UI.turnEnding = false;
    UI.highlightTargets = [];
    UI.resultsShownFor = null;
    UI.stage = 'prep';
    UI.game = CnA.createGame({
      mode: UI.mode,
      humanFaction: UI.factionId,
      seed: UI.seed === '' ? undefined : UI.seed,
      laps: UI.laps,
      hpPatch: UI.patch,
      trackKind: UI.trackKind,
    });
    showScreen('game');
    renderAll();
    raceLoop();
  }

  function backToMenu() {
    UI.loopGen++;
    if (UI.humanResolve) { const r = UI.humanResolve; UI.humanResolve = null; r(); }
    UI.humanResolve = null;
    UI.busy = false;
    UI.stage = 'idle';
    UI.game = null;
    UI.highlightTargets = [];
    renderMenu();
    showScreen('menu');
  }

  /* ------------------------------------------------------------------ */
  /* Главный цикл                                                       */
  /* ------------------------------------------------------------------ */
  async function raceLoop() {
    const gen = UI.loopGen;
    while (gen === UI.loopGen && UI.game && UI.game.race && !UI.game.race.over) {
      const started = CnA.beginTurn(UI.game);
      renderAll();
      if (started.skip) {
        const why = started.reason === 'pit' ? 'пит-стоп' :
          started.reason === 'destroyed' ? 'ремонт после уничтожения' :
          started.reason === 'burned' ? 'пожар' : 'пропуск';
        showToast(esc(started.car ? started.car.name : 'Гонщик') + ' пропускает ход (' + why + ').', 'event', 1400);
        await sleep(650 / UI.speed);
        if (gen !== UI.loopGen) return;
        if (UI.game.race.over) break;
        const end = CnA.endTurn(UI.game);
        renderAll();
        if (end.raceOver) { showResults(); return; }
        continue;
      }
      if (started.car.human) {
        UI.stage = UI.game.race.phase;
        renderAll();
        await new Promise((res) => { UI.humanResolve = res; });
        if (gen !== UI.loopGen) return;
        if (UI.game.race.over) { showResults(); return; }
      } else {
        UI.stage = 'ai';
        renderAll();
        await aiTurn(started.car);
        if (gen !== UI.loopGen) return;
        if (UI.game.race.over) { showResults(); return; }
      }
    }
    if (UI.game && UI.game.race && UI.game.race.over) showResults();
  }

  async function finishTurn() {
    if (!UI.game || !UI.game.race || UI.turnEnding) return;
    UI.turnEnding = true;
    const end = CnA.endTurn(UI.game);
    UI.busy = false;
    UI.stage = UI.game.race.phase;
    renderAll();
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
    if (!res.ok) {
      UI.busy = false;
      showToast(esc(res.reason || 'Нельзя двигаться'), 'damage');
      renderAll();
      return;
    }
    showDice(res.roll, res.total, res.mods, res.nitroRoll);
    renderAll();
    await sleep(420 / UI.speed);
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
      }
      const step = CnA.stepMovement(UI.game, car, opt.node, opt.jump);
      UI.stage = 'move';
      renderAll();
      if (step.events) handleStepEvents(step, car);
      await sleep(260 / UI.speed);
      if (!step.ok || step.stop) break;
    }
    await afterHumanMovement(car);
  }

  async function afterHumanMovement(car) {
    const fin = CnA.finishMovement(UI.game, car);
    if (fin && fin.event) showEvent(fin.event);
    await sleep(220 / UI.speed);
    renderAll();
    if (UI.game.race.over) { UI.busy = false; showResults(); return; }
    if (car.destroyed || car.finished) {
      UI.busy = false;
      UI.stage = 'done';
      renderAll();
      await sleep(500 / UI.speed);
      finishTurn();
      return;
    }
    UI.busy = false;
    UI.stage = 'fire';
    renderAll();
  }

  function handleStepEvents(step, car) {
    (step.events || []).forEach((e) => {
      if (e.type === 'damage' && e.amount > 0) {
        const c = e.carId != null ? CnA.carById(UI.game, e.carId) : car;
        if (c) floatAtCar(c, '−' + e.amount, false);
      }
    });
    if (step.ram) {
      const r = step.ram;
      showToast('ТАРАН: ' + esc(r.text || 'машины столкнулись'), 'damage', 2300);
    }
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
        '<span>тайл ' + node.id + (o.jump ? ' · перелет через ' + o.via : '') + '</span></button>';
    }).join('');
    const isPitChoice = !!(curNode && curNode.pitEntry);
    const res = await modal(
      '<h3>' + (isPitChoice ? 'ПИТ-ЛЕЙН' : 'РАЗВИЛКА') + '</h3><p>Осталось движения: <b>' + (UI.game.race.turn ? UI.game.race.turn.remaining : 0) +
      '</b>. ' + (isPitChoice
        ? 'Можно заехать в боксы (длиннее круга на 2 шага) или остаться на трассе.'
        : 'Выберите маршрут — короткий срез опаснее, объезд длиннее.') + '</p>' +
      '<div class="target-list">' + rows + '</div>',
      (rootEl, close) => {
        $$('[data-route]', rootEl).forEach((b) => {
          b.addEventListener('click', () => close(opts[Number(b.dataset.route)]));
        });
      });
    return res || null;
  }

  async function onPrepCard(uid) {
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
    showToast('Пит-стоп: +' + r.heal + ' корпуса. Машина стоит в боксах.', 'event', 2200);
    UI.busy = true;
    renderAll();
    await sleep(400 / UI.speed);
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
    showToast('Турбина взведена: следующий бросок удвоится.', 'event');
    renderAll();
  }

  async function onHandCard(uid) {
    if (!UI.game || UI.busy) return;
    const car = currentCar();
    if (!car || !car.human) return;
    const h = car.hand.find((c) => c.uid === uid);
    if (!h) return;
    const card = CnA.CARDS[h.type];
    if (card.phase === 'prep') { onPrepCard(uid); return; }
    if (card.phase === 'reaction') {
      showToast('«' + card.name + '» срабатывает автоматически в момент угрозы.', 'event', 2200);
      return;
    }
    if (UI.game.race.phase !== 'fire') {
      showToast('Атака возможна только в фазе огня.', 'damage');
      return;
    }
    if (!CnA.cardPlayable(UI.game, car, uid)) {
      showToast('Сейчас эту карту сыграть нельзя.', 'damage');
      return;
    }
    if (card.kind === 'trap') { await doTrap(car, h); return; }
    await doAttack(car, h);
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
      floatAtCar(target, '−' + res.damage, false);
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
      const f = faction(target.factionId);
      const dir = t.dir === 'fwd' ? 'вперёд' : 'назад';
      const avg = card.dmg === 'd4' ? 2.5 : card.dmg === '2d4' ? 5 : card.dmg === '3d4' ? 7.5 : 0;
      let bonus = 0;
      if (car.factionId === 'swarm' && CnA.isLeader(UI.game, target)) bonus = 2;
      const dmg = Math.round((avg + bonus) * 10) / 10;
      const valText = card.noDamage ? 'эффект' : '≈' + dmg + ' урона';
      return '<button class="target-btn" data-target="' + t.carId + '">' +
        '<b>' + esc(target.name) + '</b>' +
        '<span>' + dir + ' · ' + t.dist + ' тайл(а) · корпус ' + target.hp + '/' + target.maxHp +
        ' · <span class="tval">' + valText + '</span></span>' +
        '</button>';
    }).join('');
    return modal(
      '<h3>' + esc(label || card.name) + '</h3>' +
      '<p>Дальность и направление уже учтены. Выберите цель.</p>' +
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
    const pause = (ms) => sleep(ms * 0.55 / UI.speed);
    await pause(420);

    const prep = CnA.aiChoosePrep(UI.game, car);
    if (prep.type === 'pit') {
      CnA.startPit(UI.game, car);
      renderAll();
      await pause(600);
      UI.busy = false;
      finishTurn();
      return;
    }
    if (prep.type === 'card') {
      CnA.playPrep(UI.game, car, prep.uid);
      renderAll();
      await pause(360);
    } else if (prep.type === 'rust') {
      CnA.useRustRepair(UI.game, car);
      renderAll();
      await pause(300);
    } else if (prep.type === 'turbo') {
      CnA.armTurbo(UI.game, car);
      renderAll();
      await pause(250);
    } else if (prep.type === 'returnMine') {
      CnA.returnMine(UI.game, car);
      renderAll();
      await pause(250);
    }
    if (car.destroyed || car.finished) { UI.busy = false; finishTurn(); return; }

    const roll = CnA.rollMove(UI.game, car);
    if (!roll.ok) { UI.busy = false; finishTurn(); return; }
    showDice(roll.roll, roll.total, roll.mods, roll.nitroRoll);
    renderAll();
    await pause(480);
    if (car.destroyed) { UI.busy = false; finishTurn(); return; }

    let guard = 0;
    while (guard++ < 16) {
      const opts = CnA.movementOptions(UI.game, car);
      if (!opts.length) break;
      const opt = CnA.aiChooseStep(UI.game, car, opts);
      const step = CnA.stepMovement(UI.game, car, opt.node, opt.jump);
      renderAll();
      if (step.events) handleStepEvents(step, car);
      await pause(300);
      if (!step.ok || step.stop) break;
    }
    const fin = CnA.finishMovement(UI.game, car);
    if (fin && fin.event) showEvent(fin.event);
    renderAll();
    await pause(420);
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
      await pause(520);
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
    const total = game.mode === 'championship' ? 3 : 1;
    const leader = CnA.raceLeader(game);
    const lf = leader ? faction(leader.factionId) : null;
    const atStart = !game.race.stats || game.race.stats.turns === 0;
    const totalPath = game.laps * game.race.track.count;
    $('#race-meta').innerHTML =
      '<span class="pill">' + (game.mode === 'championship' ? 'ЧЕМПИОНАТ' : 'ЗАЕЗД') + '</span>' +
      (total > 1 ? '<span>гонка <b>' + (game.raceIndex + 1) + '</b>/' + total + '</span>' : '') +
      '<span>раунд <b>' + game.race.round + '</b></span>' +
      '<span>круг <b>' + game.laps + '</b></span>' +
      '<span>сид <b>' + game.seed + '</b></span>';
    $('#track-label').textContent = game.race.track.label || (game.race.track.count + ' тайлов · развилка');
    $('#leader-label').innerHTML = lf
      ? 'ЛИДЕР: <b style="color:' + lf.color + '">' + esc(leader.name) + '</b> · ' +
        (atStart ? 'на старте' : Math.round(CnA.progressOf(game, leader)) + ' / ' + totalPath + ' пути')
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
      const wantRight = Math.cos(ang * Math.PI / 180) >= 0;
      const mirror = (wantRight === !!FRONT_RIGHT[f.id]) ? 1 : -1;
      s += '<g transform="scale(' + mirror + ',1)"><image class="car-mini" href="assets/factions/' + f.id + '/mini.png" x="-28" y="-50" width="56" height="56" preserveAspectRatio="xMidYMid meet"/></g>';
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
        parts.push('<polygon class="token-mine" points="' + starPoints(x, y, 7.5) + '"></polygon>');
        parts.push('<text class="token-label" x="' + x + '" y="' + (y + 2.5) + '">✸</text>');
      } else if (tok.type === 'oil') {
        parts.push('<ellipse class="token-oil" cx="' + x + '" cy="' + y + '" rx="8" ry="5"></ellipse>');
      } else if (tok.type === 'fire') {
        parts.push('<polygon class="token-fire" points="' + (x - 6) + ',' + (y + 4) + ' ' + (x + 6) + ',' + (y + 4) + ' ' + x + ',' + (y - 6) + '"></polygon>');
      } else {
        parts.push('<line class="token-wreck" x1="' + (x - 5) + '" y1="' + (y - 5) + '" x2="' + (x + 5) + '" y2="' + (y + 5) + '" stroke="#b9b2a6" stroke-width="2.5"></line>');
        parts.push('<line class="token-wreck" x1="' + (x + 5) + '" y1="' + (y - 5) + '" x2="' + (x - 5) + '" y2="' + (y + 5) + '" stroke="#b9b2a6" stroke-width="2.5"></line>');
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
        parts.push('<title>' + esc(c.name + ' · ' + c.hp + '/' + c.maxHp + ' корпуса · ОЧ ' + c.cp + ' · лом ' + c.scrap) + '</title>');
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
      if (c.hp > 0 && c.hp / c.maxHp <= 0.2 && !c.destroyed) statuses.push('<span class="st burn">КРИТ</span>');
      const ups = c.upgrades.map((id) => '<span class="up" title="' + esc((CnA.upgrade(id) || {}).name || id) + '">' + (UP_SHORT[id] || id) + '</span>').join('');
      const cls = 'player' + (cur && cur.id === c.id ? ' active' : '') + (c.finished || c.destroyed ? ' out' : '');
      return '<div class="' + cls + '" style="--fc:' + f.color + '">' +
        '<div class="p-top"><span class="p-name"><span class="p-glyph" title="' + esc(f.name) + '">' + f.glyph + '</span>' + esc(c.name) + '</span><span class="p-pos">' + pos[c.id] + '/4</span></div>' +
        '<div class="p-stats"><span>КОРПУС <b>' + c.hp + '</b>/' + c.maxHp + '</span><span>ОЧ <b>' + c.cp + '</b></span><span>ЛОМ <b>' + c.scrap + '</b></span></div>' +
        '<div class="hp-bar"><div class="hp-fill" style="width:' + hpPct + '%"></div><span class="hp-mark" style="left:50%"></span><span class="hp-mark" style="left:20%"></span></div>' +
        '<div class="p-status">' + statuses.join('') + '</div>' +
        '<div class="p-upgrades">' + ups + '</div>' +
        '</div>';
    }).join('');
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
    if (c.nextMovePenalty) status.push('−' + c.nextMovePenalty + ' след. ход');
    const lap = Math.min(game.laps, Math.max(1, c.lapsDone + 1));

    card.style.setProperty('--fc', f.color);
    card.innerHTML =
      '<div class="turn-head">' +
      '<div><div class="turn-who" style="color:' + f.color + '">' + esc(c.name) + '</div>' +
      '<div class="turn-sub">' + (isHuman ? 'ВАШ ХОД' : 'ХОД ИИ') + ' · ' + esc(c.carName) + '</div></div>' +
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
        hint = 'Сыграйте одну карту из руки, объявите пит-стоп или сразу бросайте движение.';
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
        hint = t.fireUsed ? 'Действие огня использовано. Завершите ход.'
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
      hint = phase === 'prep' ? 'ИИ оценивает обстановку.' :
        phase === 'move' ? 'ИИ едет по трассе.' :
        phase === 'fire' ? 'ИИ выбирает, кого ударить.' : 'ИИ завершает ход.';
      actions += '<button class="act-btn ghost" disabled>ХОД ИИ</button>';
    }

    const lap = c ? Math.min(game.laps, Math.max(1, c.lapsDone + 1)) : 1;
    const turnLine = 'РАУНД ' + game.race.round + ' · КРУГ ' + lap + '/' + game.laps + ' · ' + (isHuman ? 'ВАШ ХОД' : 'ХОД ИИ');
    el.innerHTML =
      '<div class="phase-chips">' + chips + '</div>' +
      '<div class="phase-info"><span class="phase-turn">' + turnLine + '</span><span class="phase-hint">' + hint + '</span></div>' +
      '<div class="phase-actions">' + actions + '</div>';

    const rollBtn = $('#roll-btn'); if (rollBtn) rollBtn.addEventListener('click', onRoll);
    const pitBtn = $('#pit-btn'); if (pitBtn) pitBtn.addEventListener('click', onPit);
    const rustBtn = $('#rust-btn'); if (rustBtn) rustBtn.addEventListener('click', onRustRepair);
    const mineBtn = $('#mine-return-btn'); if (mineBtn) mineBtn.addEventListener('click', onReturnMine);
    const turboBtn = $('#turbo-btn'); if (turboBtn) turboBtn.addEventListener('click', onTurbo);
    const wildfireBtn = $('#wildfire-btn'); if (wildfireBtn) wildfireBtn.addEventListener('click', onWildfire);
    const endBtn = $('#end-turn-btn'); if (endBtn) endBtn.addEventListener('click', () => { if (!UI.busy) finishTurn(); });
  }

  function phaseLabel(phase) {
    if (phase === 'prep') return 'ПОДГОТОВКА';
    if (phase === 'move') return 'ДВИЖЕНИЕ';
    if (phase === 'fire') return 'ОГОНЬ';
    if (phase === 'done') return 'КОНЕЦ ХОДА';
    return '—';
  }

  function renderHand() {
    const game = UI.game;
    if (!game || !game.race) { $('#hand-zone').innerHTML = ''; return; }
    const c = currentCar();
    if (!c) { $('#hand-zone').innerHTML = ''; return; }
    const head = '<div class="hand-head"><h3>' + (c.human ? 'РУКА АРСЕНАЛА' : 'РУКА СОПЕРНИКА') +
      '</h3><span class="hand-count">' + c.hand.length + ' / 5</span></div>';

    if (!c.human) {
      const backUrl = CnA.assets.url('bg', 'card-back');
      const backs = c.hand.map(() => '<div class="card card-back">' +
        '<img class="card-back-img" src="' + backUrl + '" alt="" aria-hidden="true" onerror="this.parentNode.classList.add(\'no-art\');this.remove()">' +
        '<div class="phase">СКРЫТО</div><div class="cname">?</div></div>').join('');
      $('#hand-zone').innerHTML = head + '<div class="hand">' + backs + '<div class="empty-hand">Рука соперника не показывается.</div></div>';
      return;
    }

    const cards = c.hand.map((h) => {
      const card = CnA.CARDS[h.type];
      const playable = !UI.busy && CnA.cardPlayable(game, c, h.uid);
      const kindCls = card.kind === 'attack' ? 'attack' : card.kind === 'trap' ? 'trap' : card.kind === 'prep' ? 'prep' : 'reaction';
      const phaseText = card.phase === 'prep' ? 'ПОДГОТОВКА' : card.phase === 'fire' ? 'ОГОНЬ' : 'РЕАКЦИЯ';
      const stats = card.noDamage
        ? 'эффект' + (card.range ? ' · ' + card.range : '')
        : (card.dmg && card.dmg !== '—' ? card.dmg + (card.range ? ' · ' + card.range : '') : (card.kind === 'prep' ? 'эффект' : '—'));
      const icon = CARD_ICON[card.id] || '·';
      const art = CARD_ART[card.id]
        ? '<img class="card-illu" src="assets/cards/arsenal/' + card.id + '.png" alt="">'
        : '<div class="card-art">' + esc(icon) + '</div>';
      return '<button class="card ' + kindCls + (playable ? '' : ' disabled') + '" data-uid="' + h.uid + '" title="' + esc(card.text) + '">' +
        '<div class="phase">' + phaseText + '</div>' +
        art +
        '<div class="cname">' + esc(card.name) + '</div>' +
        '<div class="cstats">' + esc(stats) + '</div>' +
        '<div class="cshort">' + esc(card.short) + '</div>' +
        (card.phase === 'reaction' ? '<div class="badge-auto">АВТО</div>' : '') +
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
      if (!anyTarget) hint = '<div class="empty-hand" style="min-height:0;padding:6px 4px 0">Нет целей в радиусе. Завершите ход.</div>';
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

  /* ------------------------------------------------------------------ */
  /* Всплывашки                                                         */
  /* ------------------------------------------------------------------ */
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

  function showEvent(ev) {
    if (!ev) return;
    showToast('<b>ПУСТОШЬ · ' + esc(ev.name) + '</b><br>' + esc(ev.text), 'event', 3400);
  }

  function floatAtCar(car, text, heal) {
    const zone = $('#board-floats');
    if (!zone || !UI.game || !UI.game.race) return;
    const n = UI.game.race.track.nodes[car.node];
    if (!n) return;
    const div = document.createElement('div');
    div.className = 'float-dmg' + (heal ? ' heal' : '');
    div.textContent = text;
    div.style.left = (n.x / 1000 * 100) + '%';
    div.style.top = (n.y / 784 * 100) + '%';
    zone.appendChild(div);
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 1150);
  }

  function showDice(roll, total, mods, nitroRoll) {
    const strip = $('#dice-strip');
    if (!strip) return;
    const modText = (mods && mods.length) ? ' <span class="mods">[' + esc(mods.join(', ')) + ']</span>' : '';
    strip.innerHTML = '<div class="dice rolling">' + roll + '</div>' +
      '<div class="dice-note">бросок <b>' + roll + '</b>' + (nitroRoll ? ' + нитро <b>' + nitroRoll + '</b>' : '') +
      ' → движение <b>' + total + '</b>' + modText + '</div>';
    const d = $('.dice', strip);
    if (d) { d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling'); }
    UI.lastDice = { roll, total, mods };
  }

  /* ------------------------------------------------------------------ */
  /* Результаты                                                         */
  /* ------------------------------------------------------------------ */
  function showResults() {
    const game = UI.game;
    if (!game || !game.results) return;
    if (UI.resultsShownFor === game.results) return;
    UI.resultsShownFor = game.results;
    UI.stage = 'results';
    UI.busy = false;
    const res = game.results;
    const total = game.mode === 'championship' ? 3 : 1;
    $('#results-meta').innerHTML =
      '<span class="pill">' + (game.mode === 'championship' ? 'ЧЕМПИОНАТ · ГОНКА ' + (game.raceIndex + 1) + '/' + total : 'ЗАЕЗД') + '</span>' +
      '<span>сид <b>' + game.seed + '</b></span>' +
      '<span>кругов <b>' + game.laps + '</b></span>';
    $('#results-title').textContent = 'ИТОГИ ГОНКИ ' + (game.raceIndex + 1);
    $('#results-sub').textContent = 'После финиша лидера остальные доезжают ещё один полный раунд. ' +
      'Финишировавшие получают полные очки за место, не доехавшие — половину по прогрессу. Лом за место — по инверсии: чем хуже финиш, тем больше запчастей.';

    const rows = res.rows;
    const head = '<div class="res-row head"><div class="place">#</div><div>Гонщик</div><div class="num">ОЧ</div>' +
      '<div class="num">ЛОМ</div><div class="num">УРОН</div><div class="num">ФИНИШ</div></div>';
    $('#results-table').innerHTML = head + rows.map((r) => {
      const f = faction(r.factionId);
      const cls = 'res-row' + (r.pos === 1 ? ' winner' : '') + (!r.finished ? ' dnf' : '');
      return '<div class="' + cls + '" style="--fc:' + f.color + '">' +
        '<div class="place">' + r.pos + '</div>' +
        '<div class="who"><b>' + esc(r.name) + '</b><span>' + esc(f.car) + (r.finished ? '' : ' · не доехал') + '</span></div>' +
        '<div class="num cp">+' + r.cpGained + '<small>' + (r.cpPos ? 'место +' + r.cpPos : '') +
        (r.cpKills ? ' · убийства +' + r.cpKills : '') + (r.cpLeader ? ' · лидерство +' + r.cpLeader : '') + '</small></div>' +
        '<div class="num scrap">+' + r.scrapGained + '<small>' + (r.scrapKills ? 'убийства +' + r.scrapKills + ' · ' : '') +
        'урон +' + r.scrapDamage + (r.finished ? '' : ' · DNF +3') + '</small></div>' +
        '<div class="num">' + r.damage + '<small>' + r.kills + ' убийств</small></div>' +
        '<div class="num">' + (r.finished ? '🏁' : '—') + '<small>корпус ' + r.hp + '</small></div>' +
        '</div>';
    }).join('');

    const st = res.stats;
    const avgMove = st.turns ? (st.movementSum / st.turns).toFixed(2) : '0';
    const fireShare = st.turns ? Math.round(st.fireTurns / st.turns * 100) : 0;
    $('#results-stats').innerHTML =
      '<h3>ПОСЛЕ ГОНКИ</h3>' +
      statLine('Ходов', st.turns) +
      statLine('Среднее движение', avgMove) +
      statLine('Ходов с огнём', fireShare + '%') +
      statLine('Атак', st.attacks) +
      statLine('Ловушек', st.traps) +
      statLine('Уничтожений', st.destructions) +
      statLine('Сработало мин', st.mineTriggers) +
      statLine('Событий Пустоши', st.events) +
      statLine('Сид трассы', res.trackSeed) +
      '<p style="margin-top:12px;font-size:11px;color:var(--muted)">Следующая гонка — новая трасса. ' +
      'Улучшения сохраняются, лом переносится, рука арсенала сбрасывается.</p>';

    const actions = [];
    if (game.mode === 'championship' && game.raceIndex < 2) {
      actions.push('<button id="to-shop" class="big-btn">В МАСТЕРСКУЮ</button>');
    } else if (game.mode === 'championship') {
      actions.push('<button id="to-final" class="big-btn">ИТОГИ ЧЕМПИОНАТА</button>');
    } else {
      actions.push('<button id="again-btn" class="big-btn">ЕЩЁ ЗАЕЗД</button>');
    }
    actions.push('<button id="results-menu" class="big-btn secondary">В МЕНЮ</button>');
    $('#results-actions').innerHTML = actions.join('');

    if ($('#to-shop')) $('#to-shop').addEventListener('click', () => {
      CnA.prepareShop(game);
      renderShop();
      showScreen('shop');
    });
    if ($('#to-final')) $('#to-final').addEventListener('click', () => {
      CnA.nextRace(game);
      renderFinal();
      showScreen('final');
    });
    if ($('#again-btn')) $('#again-btn').addEventListener('click', () => startGame());
    $('#results-menu').addEventListener('click', () => backToMenu());
    showScreen('results');
  }

  function statLine(k, v) {
    return '<div class="stat-line"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Мастерская                                                         */
  /* ------------------------------------------------------------------ */
  function renderShop() {
    const game = UI.game;
    if (!game) return;
    const car = humanCar();
    const f = faction(car.factionId);
    $('#shop-meta').innerHTML =
      '<span class="pill">МАСТЕРСКАЯ</span>' +
      '<span>гонка <b>' + (game.raceIndex + 1) + '</b> завершена</span>' +
      '<span>лом <b>' + car.scrap + '</b></span>';
    $('#shop-cards').innerHTML = game.shop.map((entry) => {
      const u = CnA.upgrade(entry.id);
      if (!u) return '';
      const chk = CnA.canInstall(car, u);
      const afford = car.scrap >= u.price;
      const disabled = entry.sold || !afford || !chk.ok;
      const reason = entry.sold ? 'ПРОДАНО' : !afford ? 'НЕ ХВАТАЕТ ЛОМА' : !chk.ok ? chk.reason.toUpperCase() : 'КУПИТЬ';
      return '<div class="up-card' + (entry.sold ? ' sold' : '') + '" style="--cat:' + (CAT_COLOR[u.cat] || '#c8a04e') + '">' +
        '<div class="cat">' + esc(u.cat) + '</div>' +
        '<div class="name">' + esc(u.name) + '</div>' +
        '<div class="desc">' + esc(u.text) + '</div>' +
        '<div class="price">' + u.price + ' <span>лома</span></div>' +
        '<button class="buy" data-buy="' + u.id + '"' + (disabled ? ' disabled' : '') + '>' + reason + '</button>' +
        '</div>';
    }).join('') || '<p>Витрина пуста — все улучшения уже установлены.</p>';

    const cats = {};
    car.upgrades.forEach((id) => { const u = CnA.upgrade(id); if (u) cats[u.cat] = (cats[u.cat] || 0) + 1; });
    const slots = [];
    for (let i = 0; i < car.slots; i++) {
      const id = car.upgrades[i];
      const u = id ? CnA.upgrade(id) : null;
      slots.push('<div class="slot' + (u ? ' filled' : '') + '" title="' + esc(u ? u.name : 'свободный слот') + '">' + (u ? (UP_SHORT[id] || '?') : '—') + '</div>');
    }
    const list = car.upgrades.map((id) => {
      const u = CnA.upgrade(id);
      return '<li><span>' + esc(u ? u.name : id) + '</span><b style="color:var(--dust)">' + (u ? u.price : '') + '</b></li>';
    }).join('');
    $('#shop-side').innerHTML =
      '<h3>' + esc(f.name) + ' · ' + esc(f.car) + '</h3>' +
      '<div class="shop-scrap">' + car.scrap + ' <span>лома в кармане</span></div>' +
      '<div style="margin-top:12px;font-size:10px;letter-spacing:.1em;color:var(--muted)">СЛОТЫ ' + car.upgrades.length + '/' + car.slots + '</div>' +
      '<div class="slot-row">' + slots.join('') + '</div>' +
      '<div style="font-size:10px;color:var(--muted);line-height:1.5">Не больше 2 улучшений одной категории. ' +
      Object.keys(cats).map((k) => esc(k) + ': ' + cats[k] + '/2').join(' · ') + '</div>' +
      '<ul class="shop-list">' + list + '</ul>' +
      '<p style="margin-top:12px;font-size:10.5px;color:var(--muted);line-height:1.5">После вас докупаются ИИ. ' +
      'Витрина общая, поэтому редкий «Двигатель III» может уйти.</p>';

    $$('#shop-cards [data-buy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = CnA.buyUpgrade(game, car, btn.dataset.buy);
        if (!r.ok) showToast(esc(r.reason || 'Не удалось купить'), 'damage');
        else showToast('Улучшение установлено.', 'event');
        renderShop();
      });
    });
    $('#shop-continue').onclick = () => {
      CnA.aiBuyUpgrades(game);
      const next = CnA.nextRace(game);
      if (!next) { renderFinal(); showScreen('final'); return; }
      UI.resultsShownFor = null;
      UI.loopGen++;
      UI.busy = false;
      UI.stage = 'prep';
      showScreen('game');
      renderAll();
      raceLoop();
    };
  }

  /* ------------------------------------------------------------------ */
  /* Финал                                                              */
  /* ------------------------------------------------------------------ */
  function renderFinal() {
    const game = UI.game;
    if (!game) return;
    const standings = game.finalStandings || CnA.computeStandings(game);
    const champ = standings[0];
    const f = faction(champ.factionId);
    $('#final-meta').innerHTML = '<span class="pill">ЧЕМПИОНАТ ЗАВЕРШЁН</span><span>сид <b>' + game.seed + '</b></span>';
    $('#final-hero').innerHTML =
      '<div class="champ-name" style="color:' + f.color + '">' + esc(champ.name) + '</div>' +
      '<div class="champ-sub">' + esc(f.car) + ' · чемпион «Хрома и Пепла»</div>' +
      '<div class="champ-stats">' +
      '<div class="cs"><b>' + champ.cp + '</b><span>очков</span></div>' +
      '<div class="cs"><b>' + champ.damage + '</b><span>урона</span></div>' +
      '<div class="cs"><b>' + champ.kills + '</b><span>убийств</span></div>' +
      '<div class="cs"><b>' + champ.scrap + '</b><span>лома</span></div>' +
      '</div>';
    const head = '<div class="res-row head"><div class="place">#</div><div>Гонщик</div><div class="num">ОЧ</div>' +
      '<div class="num">УРОН</div><div class="num">УБИЙСТВ</div><div class="num">ЛОМ</div></div>';
    $('#final-table').innerHTML = head + standings.map((s) => {
      const sf = faction(s.factionId);
      return '<div class="res-row' + (s.place === 1 ? ' winner' : '') + '" style="--fc:' + sf.color + '">' +
        '<div class="place">' + s.place + '</div>' +
        '<div class="who"><b>' + esc(s.name) + '</b><span>' + esc(sf.car) + '</span></div>' +
        '<div class="num cp">' + s.cp + '</div>' +
        '<div class="num">' + s.damage + '</div>' +
        '<div class="num">' + s.kills + '</div>' +
        '<div class="num scrap">' + s.scrap + '</div>' +
        '</div>';
    }).join('');
    showScreen('final');
  }

  /* ------------------------------------------------------------------ */
  /* Служебное                                                          */
  /* ------------------------------------------------------------------ */
  function cycleSpeed() {
    UI.speed = UI.speed >= 3 ? 1 : UI.speed + 1;
    $('#speed-btn').textContent = '×' + UI.speed;
    showToast('Скорость ИИ: ×' + UI.speed, 'event', 900);
  }

  async function confirmLeave() {
    if (!UI.game || UI.game.race.over) { backToMenu(); return; }
    const yes = await modal(
      '<h3>ВЫЙТИ ИЗ ГОНКИ?</h3><p>Текущий прогресс заезда будет потерян. Настройки в меню сохранятся.</p>' +
      '<div class="modal-actions"><button class="act-btn ghost" data-close>ОСТАТЬСЯ</button>' +
      '<button class="act-btn primary" id="confirm-leave">ВЫЙТИ</button></div>',
      (rootEl, close) => {
        $('#confirm-leave', rootEl).addEventListener('click', () => close(true));
      });
    if (yes) backToMenu();
  }

  function showError(message) {
    const box = $('#error-overlay');
    const txt = $('#error-text');
    if (!box || !txt) return;
    txt.textContent = String(message || 'неизвестная ошибка');
    box.hidden = false;
    UI.busy = false;
  }

  /* ------------------------------------------------------------------ */
  /* Инициализация                                                      */
  /* ------------------------------------------------------------------ */
  function init() {
    renderMenu();
    bindMenu();
    loadMinis();
    loadCardArt();
    $('#menu-version').textContent = 'v' + CnA.VERSION;
    $('#opt-speed').value = '1';
    $('#opt-laps').value = '1';

    $('#game-rules-btn').addEventListener('click', openRules);
    $('#game-menu-btn').addEventListener('click', confirmLeave);
    $('#speed-btn').addEventListener('click', cycleSpeed);
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
    $('#final-menu').addEventListener('click', backToMenu);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (UI.modalClose) UI.modalClose(null);
        return;
      }
      if (UI.modalClose) return;
      if (e.key === ' ' && UI.screen === 'game' && humanReady() && UI.game.race.phase === 'prep') {
        e.preventDefault();
        const btn = $('#roll-btn');
        if (btn) btn.click();
      }
    });

    window.addEventListener('error', (e) => showError((e.error && e.error.stack) || e.message));
    window.addEventListener('unhandledrejection', (e) => showError((e.reason && e.reason.stack) || e.reason));

    // проверка целостности данных при старте
    try {
      const r = CnA.generateTrack(42, 28);
      const issues = CnA.validateTrack(r);
      if (issues.length) console.warn('Track issues:', issues);
    } catch (e) { console.warn('Track check failed', e); }

    // Режим разработчика: ?autostart=1&faction=chrome&seed=42 — сразу открыть стол.
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.has('autostart')) {
        UI.mode = q.get('mode') === 'championship' ? 'championship' : 'race';
        UI.factionId = q.get('faction') || 'chrome';
        if (q.get('laps')) $('#opt-laps').value = q.get('laps');
        if (q.get('track')) $('#opt-track').value = q.get('track');
        if (q.get('seed')) $('#opt-seed').value = q.get('seed');
        if (q.get('speed')) $('#opt-speed').value = q.get('speed');
        if (q.get('patch')) $('#opt-patch').checked = true;
        startGame();
      }
    } catch (e) { /* no-op */ }
  }

  // Инструменты для QA и скриншотов (не влияют на игру).
  root.__CnA_DEV__ = {
    UI, showResults, renderShop, renderFinal, showScreen, openRules, renderAll, renderBoard, renderShop,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(typeof window !== 'undefined' ? window : globalThis);

