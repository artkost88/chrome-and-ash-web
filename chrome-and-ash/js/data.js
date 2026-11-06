/* ХРОМ И ПЕПЕЛ — данные игры (фракции, карты, улучшения, события, тайлы).
   Классический скрипт: работает и в браузере, и в Node через require(). */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});

  CnA.VERSION = '0.1.0';
  CnA.TITLE = 'ХРОМ И ПЕПЕЛ';
  CnA.SUBTITLE = 'цифровой прототип';

  /* ------------------------------------------------------------------ */
  /* Фракции                                                            */
  /* ------------------------------------------------------------------ */
  CnA.FACTIONS = [
    {
      id: 'chrome',
      name: 'Хромированные',
      short: 'ХР',
      glyph: '▲',
      car: '«Ревун»',
      hp: 18,
      slots: 5,
      color: '#d8d8d2',
      ink: '#241f1a',
      motto: 'Культ скорости. Едут умирать красиво.',
      abilityName: 'Дикий огонь',
      ability: 'Два раза за гонку следующий выстрел не даёт отдачи. 5 слотов под улучшения.',
      tags: ['огонь', 'риск'],
    },
    {
      id: 'rust',
      name: 'Кузнецы Ржавчины',
      short: 'КР',
      glyph: '■',
      car: '«Наковальня»',
      hp: 22,
      slots: 4,
      color: '#ff7a1e',
      ink: '#241f1a',
      motto: 'Автоколонна-мастерская. Чинят всё, кроме совести.',
      abilityName: 'Латаем на ходу',
      ability: 'Пит-стоп занимает 2 хода вместо 3. Раз за гонку ремонтирует d4 корпуса на ходу (действие в фазе подготовки).',
      tags: ['танк', 'ремонт'],
    },
    {
      id: 'carnival',
      name: 'Карнавал Боли',
      short: 'КБ',
      glyph: '☠',
      car: '«Сахарный зуб»',
      hp: 22,
      slots: 4,
      color: '#3ba7b0',
      ink: '#241f1a',
      motto: 'Фургон мороженщика с горелкой. Дети плачут от счастья.',
      abilityName: 'Оставь им подарок',
      ability: 'Первую ловушку в ход ставит бесплатно, не тратя фазу огня. Раз за гонку возвращает мину в руку.',
      tags: ['ловушки', 'контроль'],
    },
    {
      id: 'swarm',
      name: 'Стая',
      short: 'СТ',
      glyph: '➤',
      car: '«Гарпун»',
      hp: 18,
      slots: 5,
      color: '#c8a04e',
      ink: '#241f1a',
      motto: 'Охотники на багги. Бьют первыми и издалека.',
      abilityName: 'Ведущий выстрел',
      ability: 'Дальность всего оружия +1. Урон по лидеру гонки +2.',
      tags: ['дальний бой', 'охота'],
    },
  ];

  CnA.faction = function (id) {
    return CnA.FACTIONS.find(function (f) { return f.id === id; }) || CnA.FACTIONS[0];
  };

  /* ------------------------------------------------------------------ */
  /* Карты арсенала                                                     */
  /* ------------------------------------------------------------------ */
  /* phase: prep | fire | reaction
     kind:  attack | trap | prep | reaction
     range: базовая дальность (в тайлах); dir: fwd | back | both | none
     los:   требует ли прямого участка вперёд                        */
  CnA.CARDS = {
    mg: {
      id: 'mg', name: 'Пулемёт', phase: 'fire', kind: 'attack', count: 10,
      dmg: 'd4', range: 2, dir: 'both', los: true,
      text: 'd4 урона, 1–2 вперёд или назад. Если выпало 4 — цель теряет 1 к движению в следующем ходу.',
      short: 'd4 · 1–2 · колесо на 4',
    },
    twin: {
      id: 'twin', name: 'Спаренный пулемёт', phase: 'fire', kind: 'attack', count: 4,
      dmg: 'd4', range: 2, dir: 'both', los: true, twin: true,
      text: 'Два броска d4 по разным целям в пределах 1–2 вперёд или назад.',
      short: '2×d4 · две цели',
    },
    rocket: {
      id: 'rocket', name: 'Ракета', phase: 'fire', kind: 'attack', count: 8,
      dmg: '2d4', range: 4, dir: 'fwd', los: false, push: 1,
      text: '2d4 урона, 1–4 вперёд. Игнорирует линию огня. Цель сдвигается на 1 тайл назад.',
      short: '2d4 · 1–4 · отбрасывает',
    },
    harpoon: {
      id: 'harpoon', name: 'Гарпун', phase: 'fire', kind: 'attack', count: 3,
      dmg: 'd4', range: 3, dir: 'fwd', los: true, pull: 1,
      text: 'd4 урона, 1–3 вперёд. Цель подтягивается на 1 тайл к стрелку; +1 к твоему следующему движению.',
      short: 'd4 · 1–3 · тянет',
    },
    mine: {
      id: 'mine', name: 'Мина', phase: 'fire', kind: 'trap', count: 6,
      dmg: '2d4', range: 0, dir: 'none', trap: 'mine',
      text: 'Жетон мины на свой тайл или тайл позади. Срабатывает, когда машина въезжает: 2d4 урона.',
      short: '2d4 · жетон',
    },
    oil: {
      id: 'oil', name: 'Масло', phase: 'fire', kind: 'trap', count: 5,
      dmg: '—', range: 0, dir: 'none', trap: 'oil',
      text: 'Жетон масла на свой тайл или позади. Вошедший бросает d4: 1–2 — занос, ход окончен, −1 к следующему движению.',
      short: 'занос · жетон',
    },
    flamer: {
      id: 'flamer', name: 'Огнемёт', phase: 'fire', kind: 'attack', count: 3,
      dmg: '2d4', range: 1, dir: 'back', los: false, burn: true,
      text: '2d4 урона, 1 назад. Цель загорается: d4 урона в начале её хода, пока не выпадет 4 или она не встанет в пит.',
      short: '2d4 · 1 назад · горение',
    },
    smoke: {
      id: 'smoke', name: 'Дымовая завеса', phase: 'prep', kind: 'prep', count: 4,
      dmg: '—', range: 0, dir: 'none', prep: 'smoke',
      text: 'До начала твоего следующего хода по тебе нельзя стрелять с дальности 2+.',
      short: 'защита от дальнего боя',
    },
    nitro: {
      id: 'nitro', name: 'Нитро-ускоритель', phase: 'prep', kind: 'prep', count: 6,
      dmg: '—', range: 0, dir: 'none', prep: 'nitro',
      text: '+d4 к движению в этот ход. Если итог движения 7+ — 1 урон от перегрева.',
      short: '+d4 · перегрев на 7+',
    },
    brake: {
      id: 'brake', name: 'Экстренный тормоз', phase: 'prep', kind: 'prep', count: 4,
      dmg: '—', range: 0, dir: 'none', prep: 'brake',
      text: 'Движение в этот ход = 1. Игнорируешь эффекты препятствий на пройденных тайлах.',
      short: 'движение = 1',
    },
    ramplate: {
      id: 'ramplate', name: 'Таранный отвал', phase: 'reaction', kind: 'reaction', count: 3,
      dmg: '2d4', range: 0, dir: 'none', reaction: 'ram',
      text: 'Разыгрывается при таране: твой урон тарана становится 2d4 вместо d4.',
      short: 'реакция · 2d4 таран',
    },
    repair: {
      id: 'repair', name: 'Ремкомплект', phase: 'prep', kind: 'prep', count: 3,
      dmg: '—', range: 0, dir: 'none', prep: 'repair',
      text: 'Восстанавливает d4+1 корпуса, не останавливаясь.',
      short: 'd4+1 корпуса',
    },
    jammer: {
      id: 'jammer', name: 'Глушилка', phase: 'reaction', kind: 'reaction', count: 1,
      dmg: '—', range: 0, dir: 'none', reaction: 'jam',
      text: 'Автоматически отменяет первую атаку по тебе и сбрасывается.',
      short: 'отменяет атаку',
    },
    canister: {
      id: 'canister', name: 'Канистра', phase: 'prep', kind: 'prep', count: 3,
      dmg: '—', range: 0, dir: 'none', prep: 'canister',
      text: 'Возьми 2 карты арсенала.',
      short: 'добор 2 карт',
    },
    drone: {
      id: 'drone', name: 'Ремонтный дрон', phase: 'prep', kind: 'prep', count: 3,
      dmg: '—', range: 0, dir: 'none', prep: 'drone',
      text: 'Чинит 2 корпуса и берёт 1 карту. Не останавливает машину.',
      short: '+2 корпуса · +1 карта',
    },
    boost: {
      id: 'boost', name: 'Форсаж', phase: 'prep', kind: 'prep', count: 4,
      dmg: '—', range: 0, dir: 'none', prep: 'boost',
      text: '+2 к движению в этот ход. Без перегрева.',
      short: '+2 движение',
    },
    ramboost: {
      id: 'ramboost', name: 'Разгон на таран', phase: 'prep', kind: 'prep', count: 3,
      dmg: '—', range: 0, dir: 'none', prep: 'ramboost',
      text: '+1 к движению. Если в этот ход таранишь — ещё +2 к броску тарана.',
      short: '+1 ход · +2 таран',
    },
    shield: {
      id: 'shield', name: 'Наварная броня', phase: 'prep', kind: 'prep', count: 4,
      dmg: '—', range: 0, dir: 'none', prep: 'shield',
      text: 'Поглощает следующие 2 урона. Жетон брони снимается по мере использования.',
      short: 'поглощает 2 урона',
    },
    emp: {
      id: 'emp', name: 'ЭМИ', phase: 'fire', kind: 'attack', count: 3,
      dmg: '—', range: 2, dir: 'both', los: false, noDamage: true,
      text: 'Без урона. Цель в следующий свой ход не может атаковать и ставить ловушки.',
      short: 'глушит следующий ход цели',
    },
    net: {
      id: 'net', name: 'Сеть', phase: 'fire', kind: 'attack', count: 4,
      dmg: '—', range: 2, dir: 'back', los: false, noDamage: true,
      text: 'Без урона. Цель теряет 2 движения в следующий ход.',
      short: '−2 к следующему движению',
    },
    sabotage: {
      id: 'sabotage', name: 'Саботаж', phase: 'fire', kind: 'attack', count: 4,
      dmg: '—', range: 2, dir: 'both', los: false, noDamage: true,
      text: 'Без урона. Цель сбрасывает случайную карту из руки.',
      short: 'цель теряет карту',
    },
    tow: {
      id: 'tow', name: 'Абордажный крюк', phase: 'fire', kind: 'attack', count: 3,
      dmg: '—', range: 2, dir: 'fwd', los: false, noDamage: true,
      text: 'Без урона. Подтягивает цель на 2 тайла к тебе и крадёт 1 лом.',
      short: 'тянет на 2 · крадёт лом',
    },
  };

  CnA.card = function (id) { return CnA.CARDS[id]; };

  /* Полная колода: 63 карты базовых (в дизайн-документе сумма таблицы даёт 63,
     а в составе коробки указано 60) + 28 карт расширения. */
  CnA.DECK_RECIPE = Object.keys(CnA.CARDS).map(function (id) {
    return [id, CnA.CARDS[id].count];
  });

  CnA.deckSize = function () {
    return CnA.DECK_RECIPE.reduce(function (s, r) { return s + r[1]; }, 0);
  };

  /* ------------------------------------------------------------------ */
  /* Улучшения                                                          */
  /* ------------------------------------------------------------------ */
  CnA.UPGRADES = [
    { id: 'engine2', name: 'Двигатель II', cat: 'Двигатель', price: 6, mods: { move: 1 }, text: '+1 к движению.' },
    { id: 'engine3', name: 'Двигатель III', cat: 'Двигатель', price: 12, mods: { move: 2, maxHp: -2 }, text: '+2 к движению, −2 к максимуму корпуса.' },
    { id: 'turbo', name: 'Турбина на выхлопе', cat: 'Двигатель', price: 8, mods: { turbo: true }, text: 'Один раз за гонку удвой результат броска движения.' },
    { id: 'armor', name: 'Листовая броня', cat: 'Броня', price: 5, mods: { maxHp: 6 }, text: '+6 к максимуму корпуса.' },
    { id: 'reactive', name: 'Реактивные пластины', cat: 'Броня', price: 9, mods: { reactive: true }, text: 'Первое попадание за гонку наносит 0 урона.' },
    { id: 'plow', name: 'Противоминный поддон', cat: 'Броня', price: 6, mods: { plow: true }, text: 'Урон мин вдвое меньше (округление вверх).' },
    { id: 'suspension', name: 'Усиленная подвеска', cat: 'Шасси', price: 5, mods: { sandIgnore: true }, text: 'Игнорируешь −1 от песка.' },
    { id: 'tracks', name: 'Гусеничный привод', cat: 'Шасси', price: 7, mods: { wreckIgnore: true }, text: 'Игнорируешь −1 от обломков и жетонов обломков.' },
    { id: 'balance', name: 'Балансир', cat: 'Шасси', price: 6, mods: { balance: true }, text: 'Броски на занос проходишь автоматически.' },
    { id: 'turret', name: 'Турель', cat: 'Вооружение', price: 8, mods: { turret: true }, text: 'Оружие бьёт в любом направлении и игнорирует линию огня.' },
    { id: 'barrel', name: 'Удлинённый ствол', cat: 'Вооружение', price: 6, mods: { barrel: true }, text: 'Дальность всего оружия +1.' },
    { id: 'autoloader', name: 'Автозарядка', cat: 'Вооружение', price: 10, mods: { autoloader: true }, text: 'Раз за гонку — вторая атака в тот же ход.' },
    { id: 'spikes', name: 'Шипастый таран', cat: 'Корпус', price: 7, mods: { spikes: true }, text: 'Твой урон при таране 2d4 вместо d4.' },
    { id: 'cage', name: 'Клетка безопасности', cat: 'Корпус', price: 6, mods: { cage: true }, text: 'При уничтожении пропускаешь 1 ход вместо 2.' },
    { id: 'magnet', name: 'Магнитный захват', cat: 'Корпус', price: 9, mods: { magnet: true }, text: 'Въезжая на жетон мины или масла, забираешь его в руку вместо срабатывания.' },
  ];

  CnA.upgrade = function (id) {
    return CnA.UPGRADES.find(function (u) { return u.id === id; }) || null;
  };

  /* ------------------------------------------------------------------ */
  /* События Пустоши                                                    */
  /* ------------------------------------------------------------------ */
  CnA.EVENTS = [
    { id: 'sandstorm', name: 'Песчаная буря', count: 4, text: 'До конца раунда всё оружие бьёт не дальше 1 тайла.' },
    { id: 'scavengers', name: 'Стая падальщиков', count: 4, text: 'd4 урона каждой машине на этом тайле и соседних.' },
    { id: 'depot', name: 'Брошенный склад', count: 3, text: 'Возьми 2 карты арсенала.' },
    { id: 'spill', name: 'Сорвавшаяся цистерна', count: 3, text: 'Положи жетоны огня на 3 тайла впереди.' },
    { id: 'asphalt', name: 'Хороший асфальт', count: 4, text: '+2 к следующему движению.' },
    { id: 'sinkhole', name: 'Просевший грунт', count: 3, text: 'Этот тайл становится обломками до конца гонки.' },
    { id: 'witnesses', name: 'Свидетели', count: 3, text: 'Если ты последний — возьми 3 лома.' },
    { id: 'night', name: 'Ночь падает', count: 3, text: 'До конца раунда дальность всего оружия −1 (минимум 1).' },
    { id: 'fuel', name: 'Трофейное топливо', count: 3, text: '+1 к следующему движению и 1 лом.' },
  ];

  CnA.EVENT_RECIPE = CnA.EVENTS.map(function (e) { return [e.id, e.count]; });

  /* ------------------------------------------------------------------ */
  /* Тайлы                                                              */
  /* ------------------------------------------------------------------ */
  CnA.TILES = {
    start:    { id: 'start',    label: 'СТАРТ',     short: 'СТ',  fill: '#c8a04e', ink: '#241f1a', road: '#241f1a' },
    straight: { id: 'straight', label: 'ПРЯМАЯ',    short: '',    fill: '#3a332c', ink: '#f5f0e8', road: '#241f1a' },
    turn:     { id: 'turn',     label: 'ПОВОРОТ',   short: '↷',   fill: '#3a332c', ink: '#f5f0e8', road: '#241f1a', hazard: false },
    fork:     { id: 'fork',     label: 'РАЗВИЛКА',  short: 'Y',   fill: '#3a332c', ink: '#c8a04e', road: '#241f1a' },
    sand:     { id: 'sand',     label: 'ПЕСОК',     short: '≈',   fill: '#a34a24', ink: '#f5f0e8', road: '#241f1a', hazard: true },
    debris:   { id: 'debris',   label: 'ОБЛОМКИ',   short: '✕',   fill: '#3a332c', ink: '#f5f0e8', road: '#241f1a', hazard: true },
    ramp:     { id: 'ramp',     label: 'ТРАМПЛИН',  short: '⌒',   fill: '#c8a04e', ink: '#241f1a', road: '#241f1a', hazard: true },
    tunnel:   { id: 'tunnel',   label: 'ТОННЕЛЬ',   short: '∩',   fill: '#0b0f12', ink: '#f5f0e8', road: '#241f1a' },
    bridge:   { id: 'bridge',   label: 'МОСТ',      short: '═',   fill: '#241f1a', ink: '#f5f0e8', road: '#241f1a' },
    event:    { id: 'event',    label: 'ПУСТОШЬ ?', short: '?',   fill: '#3a332c', ink: '#ff7a1e', road: '#241f1a', hazard: true },
    pit:      { id: 'pit',      label: 'ПИТ-ЛЕЙН',  short: '⚙',   fill: '#241f1a', ink: '#d8d8d2', road: '#241f1a' },
    checkpoint: { id: 'checkpoint', label: 'КП', short: 'КП', fill: '#d8d8d2', ink: '#241f1a', road: '#241f1a' },
    building: { id: 'building', label: 'ЗДАНИЕ', short: '▣', fill: '#3a332c', ink: '#c8a04e' },
    ruin:     { id: 'ruin',     label: 'РУИНЫ',  short: '▨', fill: '#241f1a', ink: '#c8a04e' },
  };

  CnA.HAZARD_TILES = ['sand', 'debris', 'event'];

  /* ------------------------------------------------------------------ */
  /* Утилиты                                                            */
  /* ------------------------------------------------------------------ */
  CnA.mulberry32 = function (seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  CnA.d4 = function (rng) { return 1 + Math.floor(rng() * 4); };
  CnA.d6 = function (rng) { return 1 + Math.floor(rng() * 6); };
  CnA.pick = function (rng, arr) { return arr[Math.floor(rng() * arr.length)]; };
  CnA.shuffle = function (rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };
  CnA.clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  CnA.rollDice = function (rng, formula) {
    const f = String(formula).toLowerCase();
    if (f === 'd4') return CnA.d4(rng);
    if (f === '2d4') return CnA.d4(rng) + CnA.d4(rng);
    if (f === '3d4') return CnA.d4(rng) + CnA.d4(rng) + CnA.d4(rng);
    return 0;
  };

  let uidCounter = 1;
  CnA.nextUid = function () { return uidCounter++; };
  /* Веб-клиент: сохранение/загрузка партии (см. docs/06-web-api.md §5.1) требует
     читать и восстанавливать счётчик uid карт, чтобы после восстановления новые
     карты не получали uid, совпадающий с уже лежащими в руках. */
  CnA.getUidCounter = function () { return uidCounter; };
  CnA.setUidCounter = function (n) { uidCounter = Number(n) || 1; };

  /* Целевые ориентиры из дизайн-документа — используются в отчёте. */
  CnA.TARGETS = {
    moveAvg: 2.5,
    raceTiles: 55,
    turnsPerPlayer: 18,
    shootShare: 0.5,
    destructionsPerRace: 1.5,
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);
