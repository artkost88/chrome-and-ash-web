const path = require('path');
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'track.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
require(path.join(__dirname, '..', 'js', 'ai.js'));
const CnA = globalThis.CnA;

const N = Number(process.argv[2] || 200);
const mode = process.argv[3] || 'race';
const laps = Number(process.argv[4] || 1);
const agg = {
  races: 0, games: 0, turns: 0, rounds: 0, finishes: 0, destructions: 0, damage: 0,
  damageBy: {}, movementSum: 0,
  fireTurns: 0, attacks: 0, traps: 0, mineTriggers: 0, events: 0,
  wins: {}, positions: {}, cp: {}, scrap: {}, finalWins: {}, finalCp: {}, errors: 0,
  raceMs: 0,
};

function collectRace(game) {
  const race = game.race;
  const stats = race.stats;
  agg.races++;
  agg.turns += stats.turns;
  agg.movementSum = (agg.movementSum || 0) + stats.movementSum;
  agg.finishes += stats.finishes;
  agg.destructions += stats.destructions;
  agg.damage += stats.damage;
  Object.keys(stats.damageBy || {}).forEach(k => { agg.damageBy[k] = (agg.damageBy[k] || 0) + stats.damageBy[k]; });
  agg.fireTurns += stats.fireTurns;
  agg.attacks += stats.attacks;
  agg.traps += stats.traps;
  agg.mineTriggers += stats.mineTriggers;
  agg.events += stats.events;
  agg.rounds += race.round;
  const rows = race.results ? race.results.rows : [];
  if (rows.length) {
    const w = rows[0];
    agg.wins[w.factionId] = (agg.wins[w.factionId] || 0) + 1;
    rows.forEach(r => {
      agg.positions[r.factionId] = (agg.positions[r.factionId] || 0) + r.pos;
      agg.cp[r.factionId] = (agg.cp[r.factionId] || 0) + r.cpGained;
      agg.scrap[r.factionId] = (agg.scrap[r.factionId] || 0) + r.scrapGained;
    });
  }
}

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  try {
    const game = CnA.createGame({ mode, humanFaction: null, seed: 1000 + i, laps, quiet: true });
    let guard = 0;
    while (guard++ < 3000 && game.stage !== 'final') {
      if (game.stage === 'race') {
        if (game.race.over) throw new Error('race over but stage race');
        CnA.aiTakeTurn(game);
        if (game.race.over) collectRace(game);
      } else if (game.stage === 'results') {
        if (mode === 'championship') {
          CnA.aiBuyUpgrades(game);
          CnA.nextRace(game);
        } else {
          break;
        }
      } else {
        throw new Error('unknown stage ' + game.stage);
      }
    }
    if (mode === 'championship' && game.stage !== 'final') { agg.errors++; continue; }
    agg.games++;
    if (mode === 'championship') {
      const w = game.finalStandings[0];
      agg.finalWins[w.factionId] = (agg.finalWins[w.factionId] || 0) + 1;
      game.cars.forEach(c => {
        agg.finalCp[c.factionId] = (agg.finalCp[c.factionId] || 0) + c.cp;
      });
    }
  } catch (e) {
    agg.errors++;
    if (agg.errors <= 3) console.error('ERR seed', 1000 + i, e && e.stack || e);
  }
}
agg.raceMs = (Date.now() - t0) / Math.max(1, agg.races);

function avg(obj) { return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, (v / agg.races).toFixed(2)])); }

console.log('N', N, 'mode', mode, 'laps', laps, 'ms/race', agg.raceMs.toFixed(1));
console.log('errors', agg.errors);
console.log('avg turns', (agg.turns / agg.races).toFixed(1));
console.log('avg rounds', (agg.rounds / agg.races).toFixed(1));
console.log('finish rate', (agg.finishes / (agg.races * 4)).toFixed(2));
console.log('destructions/race', (agg.destructions / agg.races).toFixed(2));
console.log('damage/race', (agg.damage / agg.races).toFixed(1));
console.log('damage by cause/race', Object.fromEntries(Object.entries(agg.damageBy).map(([k, v]) => [k, (v / agg.races).toFixed(1)])));
console.log('avg movement', (agg.turns ? (agg.movementSum / agg.turns) : 0));
console.log('fire share', (agg.fireTurns / agg.turns).toFixed(2), '| attacks/race', (agg.attacks / agg.races).toFixed(1), '| traps/race', (agg.traps / agg.races).toFixed(1));
console.log('mine triggers/race', (agg.mineTriggers / agg.races).toFixed(2));
console.log('events/race', (agg.events / agg.races).toFixed(1));
console.log('race wins', agg.wins);
console.log('avg pos', avg(agg.positions));
console.log('avg cp', avg(agg.cp));
console.log('avg scrap', avg(agg.scrap));
if (mode === 'championship') {
  console.log('championship wins', agg.finalWins);
  console.log('final cp total', agg.finalCp);
}
