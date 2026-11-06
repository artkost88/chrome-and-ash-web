/* Прогон мозаичной трассы «Пыльная подкова». */
const path = require('path');
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'track-gen.js'));
require(path.join(__dirname, '..', 'js', 'track.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
require(path.join(__dirname, '..', 'js', 'ai.js'));
const CnA = globalThis.CnA;

const N = Number(process.argv[2] || 300);
let turns = 0, finishes = 0, destructions = 0, damage = 0, fireTurns = 0, errors = 0;
const wins = {};
const cp = {};
for (let i = 0; i < N; i++) {
  try {
    const game = CnA.createGame({
      mode: 'race', humanFaction: null, seed: 7000 + i, laps: 1,
      quiet: true, trackKind: 'mosaic',
    });
    let guard = 0;
    while (guard++ < 5000 && game.stage !== 'results') {
      if (game.stage === 'race') CnA.aiTakeTurn(game);
      else break;
    }
    if (!game.race.results) { errors++; continue; }
    const s = game.race.stats;
    turns += s.turns;
    finishes += s.finishes;
    destructions += s.destructions;
    damage += s.damage;
    fireTurns += s.fireTurns;
    if (game.race.finishOrder.length) {
      const w = game.cars.find((c) => c.id === game.race.finishOrder[0]);
      wins[w.factionId] = (wins[w.factionId] || 0) + 1;
    }
    game.race.results.rows.forEach((r) => { cp[r.factionId] = (cp[r.factionId] || 0) + r.cpGained; });
  } catch (e) {
    errors++;
    if (errors <= 3) console.error(e.stack || e);
  }
}
const r = Math.max(1, N);
console.log('Мозаика «Пыльная подкова» · гонок:', N, '· ошибок:', errors);
console.log('Ходов/гонка:', (turns / r).toFixed(1));
console.log('Финишёров/гонка:', (finishes / r).toFixed(2), 'из 4');
console.log('Уничтожений/гонка:', (destructions / r).toFixed(2));
console.log('Урона/гонка:', (damage / r).toFixed(0));
console.log('Ходов с огнём:', (fireTurns / Math.max(1, turns) * 100).toFixed(0) + '%');
console.log('Победы:', wins);
console.log('Очки/гонка:', Object.fromEntries(Object.entries(cp).map(([k, v]) => [k, (v / r).toFixed(2)])));

