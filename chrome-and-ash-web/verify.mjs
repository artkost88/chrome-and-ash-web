/* ХРОМ И ПЕПЕЛ — проверка веб-клиента (фаза 1).
   Проверяет: загрузку логического слоя, сериализацию SaveState (round-trip),
   детерминизм движка по сиду, форму результата для PUT /api/save/:id.
   Запуск: node chrome-and-ash-web/verify.mjs */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = new URL('./js/', import.meta.url);

function load(name) {
  const code = readFileSync(new URL(name, base), 'utf8');
  (0, eval)(code);
}

load('data.js');
load('track.js');
load('engine.js');
load('ai.js');

const CnA = globalThis.CnA;
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}

/* --- Логический слой загружен и расширен uid-счётчиком --- */
check('CnA загружен', !!CnA);
check('CnA.VERSION — строка', typeof CnA.VERSION === 'string');
check('CnA.getUidCounter', typeof CnA.getUidCounter === 'function');
check('CnA.setUidCounter', typeof CnA.setUidCounter === 'function');

CnA.setUidCounter(77);
check('uid-счётчик: restore + nextUid', CnA.getUidCounter() === 77 && CnA.nextUid() === 77 && CnA.getUidCounter() === 78);

/* --- Сериализация SaveState (зеркало js/ui.js) --- */
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

function simulate(game) {
  let guard = 0;
  while (!game.race.over && guard++ < 5000) CnA.aiTakeTurn(game);
  return game;
}

/* --- Детерминизм полного заезда по сиду --- */
const g1 = CnA.createGame({ mode: 'race', humanFaction: 'rust', seed: 123456 });
simulate(g1);
check('полный заезд доигрывается (есть results)', !!g1.results);

const g2 = CnA.createGame({ mode: 'race', humanFaction: 'rust', seed: 123456 });
simulate(g2);
check('детерминизм: два одинаковых сида = одинаковый результат',
  JSON.stringify(g1.results) === JSON.stringify(g2.results));

/* --- Round-trip SaveState: сохранили рано, восстановили, доиграли --- */
CnA.setUidCounter(1);
const g3 = CnA.createGame({ mode: 'race', humanFaction: 'rust', seed: 654321 });
let guard = 0;
while (!g3.race.over && guard++ < 6) CnA.aiTakeTurn(g3);
const saved = toSaveState(g3);
check('toSaveState: rng/quiet не сериализуются', !('rng' in saved.engine) && !('quiet' in saved.engine));
check('toSaveState: schemaVersion = 1', saved.schemaVersion === 1);
check('toSaveState: engineVersion = CnA.VERSION', saved.engineVersion === CnA.VERSION);
check('toSaveState: seed в конверте', saved.seed === 654321);
check('toSaveState: mode в конверте', saved.mode === 'race');

const restored = fromSaveState(JSON.parse(JSON.stringify(saved)));
check('fromSaveState: seed', restored.seed === 654321);
check('fromSaveState: 4 машины', Array.isArray(restored.cars) && restored.cars.length === 4);
check('fromSaveState: нет rng-функции до установки', typeof restored.rng === 'function');
simulate(restored);
check('восстановленная партия доигрывается до results', !!restored.results);

/* --- mode='daily' сохраняется в конверте --- */
const g4 = CnA.createGame({ mode: 'race', humanFaction: 'chrome', seed: 42 });
g4.mode = 'daily';
check('mode=daily проносится в SaveState', toSaveState(g4).mode === 'daily');

/* --- Форма результата (RunResult) --- */
function buildResult(game) {
  const human = game.cars.find((c) => c.human) || game.cars[0];
  const rows = game.results ? game.results.rows : [];
  const row = rows.find((r) => r.carId === human.id) || null;
  const standings = game.results.standings.map((s) => ({
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
const res = buildResult(g1);
check('result.score — неотрицательное число', typeof res.score === 'number' && res.score >= 0);
check('result.detail.pos в [1..4]', res.detail.pos >= 1 && res.detail.pos <= 4);
check('result.detail поля finished/damage/kills/scrap', 'finished' in res.detail && 'damage' in res.detail && 'kills' in res.detail && 'scrap' in res.detail);
check('result.standings — 4 строки', Array.isArray(res.standings) && res.standings.length === 4);
check('result.standings содержит human:true', res.standings.some((r) => r.human === true));
check('result.standings строки полны', res.standings.every((r) => ['place','faction','name','cp','damage','kills','scrap','human'].every((k) => k in r)));

/* --- Синтаксис клиентских файлов --- */
function syntaxOk(file) {
  const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, base))], { encoding: 'utf8' });
  return r.status === 0;
}
check('syntax: data.js', syntaxOk('data.js'));
check('syntax: track.js', syntaxOk('track.js'));
check('syntax: engine.js', syntaxOk('engine.js'));
check('syntax: ai.js', syntaxOk('ai.js'));
check('syntax: api.js', syntaxOk('api.js'));
check('syntax: ui.js', syntaxOk('ui.js'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
