/* Отчёт по балансу: прогоняет набор конфигураций и печатает markdown. */
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'track.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
require(path.join(__dirname, '..', 'js', 'ai.js'));
const CnA = globalThis.CnA;

const N = Number(process.argv[2] || 500);
const CH_N = Number(process.argv[3] || 150);

const configs = [
  { key: 'proto', name: 'Прототип: добор 1 карты', opts: {} },
  { key: 'doc', name: 'По документу: без добора', opts: { draw: 0 } },
  { key: 'nocheck', name: 'Без контрольных пунктов', opts: { checkpoints: false } },
  { key: 'nospawn', name: 'Без щита после возврата', opts: { spawnProtect: false } },
  { key: 'mine2', name: 'Лимит мин 2', opts: { mineLimit: 2 } },
  { key: 'extra2', name: 'Финиш: +2 раунда', opts: { extraRounds: 2 } },
  { key: 'patch', name: 'Баланс-патч 18/22/22/18', opts: { hpPatch: true } },
  { key: 'patchfull', name: 'Патч + полный корпус', opts: { hpPatch: true, respawnFraction: 1 } },
  { key: 'twolaps', name: 'Прототип, 2 круга', opts: {}, laps: 2 },
  { key: 'twolapsdoc', name: '2 круга, без добора', opts: { draw: 0 }, laps: 2 },
];

function blank() {
  return {
    races: 0, turns: 0, rounds: 0, finishes: 0, firstFinisher: 0, destructions: 0,
    damage: 0, movement: 0, fireTurns: 0, attacks: 0, traps: 0, mineTriggers: 0,
    oilTriggers: 0, events: 0, damageBy: {}, deathsBy: {}, wins: {}, cp: {}, scrap: {},
    positions: {}, errors: 0, finishDist: {}, turnsDist: {},
  };
}

function collect(agg, race, game) {
  if (!race || !race.stats) return;
  const s = race.stats;
  agg.races++;
  agg.turns += s.turns;
  agg.rounds += race.round;
  agg.finishes += s.finishes;
  if (race.finishOrder.length) {
    agg.firstFinisher++;
    const w = game.cars.find((c) => c.id === race.finishOrder[0]);
    if (w) agg.wins[w.factionId] = (agg.wins[w.factionId] || 0) + 1;
  }
  agg.finishDist[s.finishes] = (agg.finishDist[s.finishes] || 0) + 1;
  agg.destructions += s.destructions;
  agg.damage += s.damage;
  agg.movement += s.movementSum;
  agg.fireTurns += s.fireTurns;
  agg.attacks += s.attacks;
  agg.traps += s.traps;
  agg.mineTriggers += s.mineTriggers;
  agg.oilTriggers += s.oilTriggers;
  agg.events += s.events;
  Object.keys(s.damageBy || {}).forEach((k) => { agg.damageBy[k] = (agg.damageBy[k] || 0) + s.damageBy[k]; });
  Object.keys(s.deathsBy || {}).forEach((k) => { agg.deathsBy[k] = (agg.deathsBy[k] || 0) + s.deathsBy[k]; });
  (race.results ? race.results.rows : []).forEach((r) => {
    agg.positions[r.factionId] = (agg.positions[r.factionId] || 0) + r.pos;
    agg.cp[r.factionId] = (agg.cp[r.factionId] || 0) + r.cpGained;
    agg.scrap[r.factionId] = (agg.scrap[r.factionId] || 0) + r.scrapGained;
  });
}

function runRaceConfig(cfg) {
  const agg = blank();
  for (let i = 0; i < N; i++) {
    try {
      const g = CnA.createGame(Object.assign({ mode: 'race', humanFaction: null, seed: 42000 + i, laps: cfg.laps || 1, quiet: true }, cfg.opts));
      let guard = 0;
      while (guard++ < 4000 && g.stage !== 'results') {
        if (g.stage === 'race') CnA.aiTakeTurn(g);
        else break;
      }
      if (!g.race.results) { agg.errors++; continue; }
      collect(agg, g.race, g);
    } catch (e) { agg.errors++; if (agg.errors < 3) console.error(e.stack); }
  }
  return agg;
}

function pct(x, d) { return (x / Math.max(1, d) * 100).toFixed(0) + '%'; }
function num(x, d) { return (x / Math.max(1, d)).toFixed(2); }

function row(cfg, a) {
  const r = a.races;
  return '| ' + cfg.name + ' | ' + num(a.turns, r) + ' | ' + num(a.finishes, r) + ' / 4 | ' +
    pct(a.firstFinisher, r) + ' | ' + num(a.destructions, r) + ' | ' + num(a.damage, r) + ' | ' +
    pct(a.fireTurns, a.turns) + ' | ' + num(a.mineTriggers, r) + ' | ' + num(a.events, r) + ' | ' + a.errors + ' |';
}

// --- одиночные гонки -------------------------------------------------
const results = configs.map((cfg) => ({ cfg, a: runRaceConfig(cfg) }));

// --- чемпионат -------------------------------------------------------
const ch = { games: 0, champion: {}, cp: {}, scrap: {}, upgrades: {}, errors: 0, races: 0 };
for (let i = 0; i < CH_N; i++) {
  try {
    const g = CnA.createGame({ mode: 'championship', humanFaction: null, seed: 90000 + i, laps: 1, quiet: true });
    let guard = 0;
    while (guard++ < 6000 && g.stage !== 'final') {
      if (g.stage === 'race') CnA.aiTakeTurn(g);
      else if (g.stage === 'results') { CnA.aiBuyUpgrades(g); CnA.nextRace(g); }
      else break;
    }
    if (g.stage !== 'final') { ch.errors++; continue; }
    ch.games++;
    ch.races += 3;
    const w = g.finalStandings[0];
    ch.champion[w.factionId] = (ch.champion[w.factionId] || 0) + 1;
    g.cars.forEach((c) => {
      ch.cp[c.factionId] = (ch.cp[c.factionId] || 0) + c.cp;
      ch.scrap[c.factionId] = (ch.scrap[c.factionId] || 0) + c.scrap;
      ch.upgrades[c.factionId] = (ch.upgrades[c.factionId] || 0) + c.upgrades.length;
    });
  } catch (e) { ch.errors++; if (ch.errors < 3) console.error(e.stack); }
}

// --- печать ----------------------------------------------------------
const out = [];
out.push('# Симуляции баланса — «Хром и Пепел»');
out.push('');
out.push('Автоматический прогон цифрового прототипа: 4 ИИ, 1 круг, 28 тайлов, базовая конфигурация — добор 1 карты, контрольные пункты, щит после возврата, лимит 3 мин.');
out.push('Каждая конфигурация: **' + N + ' гонок**. Чемпионат: **' + CH_N + ' партий** по 3 гонки.');
out.push('');
out.push('## Одиночные гонки');
out.push('');
out.push('| Конфигурация | Ходов/гонка | Финишеров | Гонок с финишёром | Уничтожений | Урона | Ходов с огнём | Мин/гонка | Событий | Ошибок |');
out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
results.forEach(({ cfg, a }) => out.push(row(cfg, a)));
out.push('');
const two = results.find((x) => x.cfg.key === 'twolaps');
if (two) {
  out.push('Конфигурация «2 круга» нужна для сверки с целью дизайн-документа: **' + num(two.a.turns, two.a.races * 4) +
    '** ходов на игрока против цели 16–20. При средней скорости 2,2 тайла два круга по 28 тайлов дают около 24 ходов — гонка длиннее заявленной.');
  out.push('');
}
out.push('### Прототип: детали');
const base = results[0].a;
out.push('');
out.push('- Среднее движение за бросок: **' + num(base.movement, base.turns) + '** тайла (цель 2,5).');
out.push('- Ходов на игрока: **' + num(base.turns, base.races * 4) + '** (цель 16–20 при 2 кругах; здесь 1 круг).');
out.push('- Доля ходов с огнём (атаки + ловушки): **' + pct(base.fireTurns, base.turns) + '**; только атак: **' + pct(base.attacks, base.turns) + '**.');
out.push('- Уничтожений за гонку: **' + num(base.destructions, base.races) + '** (цель 1–2).');
out.push('- Урон за гонку: **' + num(base.damage, base.races) + '**; средний урон атаки: **' + num(base.damageBy.attack || 0, base.attacks || 1) + '**.');
out.push('- Финишёров за гонку: **' + num(base.finishes, base.races) + '** из 4; гонок без финишёра: **' + pct(base.races - base.firstFinisher, base.races) + '**.');
out.push('');
out.push('Распределение числа финишёров (% гонок):');
out.push('');
out.push('| Финишёров | 0 | 1 | 2 | 3 | 4 |');
out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
let dist = '| Доля |';
for (let k = 0; k <= 4; k++) dist += ' ' + pct(base.finishDist[k] || 0, base.races) + ' |';
out.push(dist);
out.push('');
out.push('Причины уничтожения (прототип):');
out.push('');
out.push('| Причина | Доля |');
out.push('| --- | ---: |');
const deathTotal = Object.values(base.deathsBy).reduce((s, x) => s + x, 0);
Object.keys(base.deathsBy).sort((a, b) => base.deathsBy[b] - base.deathsBy[a]).forEach((k) => {
  out.push('| ' + k + ' | ' + pct(base.deathsBy[k], deathTotal) + ' |');
});
out.push('');
out.push('Урон по источникам (прототип):');
out.push('');
out.push('| Источник | Урон/гонка |');
out.push('| --- | ---: |');
Object.keys(base.damageBy).sort((a, b) => base.damageBy[b] - base.damageBy[a]).forEach((k) => {
  out.push('| ' + k + ' | ' + num(base.damageBy[k], base.races) + ' |');
});
out.push('');
out.push('Победы в гонках по фракциям (первый финишёр):');
out.push('');
out.push('| Фракция | Победы | Доля | Очки/гонка | Лом/гонка |');
out.push('| --- | ---: | ---: | ---: | ---: |');
CnA.FACTIONS.forEach((f) => {
  out.push('| ' + f.name + ' | ' + (base.wins[f.id] || 0) + ' | ' + pct(base.wins[f.id] || 0, base.firstFinisher) + ' | ' +
    num(base.cp[f.id] || 0, base.races) + ' | ' + num(base.scrap[f.id] || 0, base.races) + ' |');
});
out.push('');
out.push('## Чемпионат из 3 гонок');
out.push('');
out.push('| Фракция | Титулы | Доля | Очки за чемпионат | Улучшений к концу |');
out.push('| --- | ---: | ---: | ---: | ---: |');
CnA.FACTIONS.forEach((f) => {
  out.push('| ' + f.name + ' | ' + (ch.champion[f.id] || 0) + ' | ' + pct(ch.champion[f.id] || 0, ch.games) + ' | ' +
    num(ch.cp[f.id] || 0, ch.games) + ' | ' + num(ch.upgrades[f.id] || 0, ch.games) + ' |');
});
out.push('');
out.push('Ошибок: ' + (base.errors + results.reduce((s, x) => s + x.a.errors, 0) + ch.errors) + '.');
out.push('');
out.push('> Это не плейтест людей. ИИ агрессивно фокусирует огонь и не умеет договариваться; абсолютные значения важны как сравнение конфигураций, а не как приговор игре.');
out.push('');

const text = out.join('\n');
fs.writeFileSync(path.join(__dirname, '..', 'docs', '03-balance-report-generated.md'), text, 'utf8');
console.log(text);
