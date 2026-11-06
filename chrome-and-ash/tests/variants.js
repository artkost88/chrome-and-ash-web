const path = require('path');
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'track-gen.js'));
require(path.join(__dirname, '..', 'js', 'track.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
require(path.join(__dirname, '..', 'js', 'ai.js'));
const CnA = globalThis.CnA;

const N = Number(process.argv[2] || 300);
const configs = [
  { name: 'base', opts: {} },
  { name: 'extra 2 rounds', opts: { extraRounds: 2 } },
  { name: 'extra 3 rounds', opts: { extraRounds: 3 } },
  { name: 'extra 2 + full respawn', opts: { extraRounds: 2, respawnFraction: 1 } },
  { name: 'extra 2 + hp + full', opts: { extraRounds: 2, hpPatch: true, respawnFraction: 1 } },
  { name: 'extra 3 + no draw', opts: { extraRounds: 3, draw: 0 } },
  { name: 'no draw', opts: { draw: 0 } },
  { name: 'full respawn', opts: { respawnFraction: 1 } },
  { name: 'hp patch', opts: { hpPatch: true } },
  { name: 'hp patch + full', opts: { hpPatch: true, respawnFraction: 1 } },
  { name: 'no checkpoints', opts: { checkpoints: false } },
  { name: 'no spawn prot', opts: { spawnProtect: false } },
  { name: 'mine limit 2', opts: { mineLimit: 2 } },
  { name: 'hp + no draw', opts: { hpPatch: true, draw: 0 } },
  { name: 'hp + full + no checkpoints', opts: { hpPatch: true, respawnFraction: 1, checkpoints: false } },
];

function run(cfg) {
  const agg = {
    races: 0, turns: 0, finishes: 0, destructions: 0, damage: 0, fireTurns: 0,
    wins: {}, pos: {}, cp: {}, finishDist: {}, errors: 0, sumFinish: 0, sumWinnerRound: 0,
  };
  for (let i = 0; i < N; i++) {
    try {
      const game = CnA.createGame(Object.assign({ mode: 'race', humanFaction: null, seed: 5000 + i, laps: 1, quiet: true }, cfg.opts));
      let guard = 0;
      while (guard++ < 3000 && game.stage !== 'results') {
        if (game.stage === 'race') {
          if (game.race.over) break;
          CnA.aiTakeTurn(game);
        } else break;
      }
      if (!game.race.results) { agg.errors++; continue; }
      agg.races++;
      const s = game.race.stats;
      agg.turns += s.turns;
      agg.finishes += s.finishes;
      agg.destructions += s.destructions;
      agg.damage += s.damage;
      agg.fireTurns += s.fireTurns;
      agg.finishDist[s.finishes] = (agg.finishDist[s.finishes] || 0) + 1;
      const rows = game.race.results.rows;
      const w = rows[0];
      agg.wins[w.factionId] = (agg.wins[w.factionId] || 0) + 1;
      agg.sumWinnerRound += game.race.firstFinishRound || 0;
      rows.forEach(r => {
        agg.pos[r.factionId] = (agg.pos[r.factionId] || 0) + r.pos;
        agg.cp[r.factionId] = (agg.cp[r.factionId] || 0) + r.cpGained;
      });
    } catch (e) {
      agg.errors++;
      if (agg.errors <= 2) console.error('ERR', cfg.name, e.stack || e);
    }
  }
  return agg;
}

function line(name, a) {
  const r = Math.max(1, a.races);
  const wins = Object.fromEntries(Object.entries(a.wins).map(([k, v]) => [k, (v / r * 100).toFixed(0)]));
  const cp = Object.fromEntries(Object.entries(a.cp).map(([k, v]) => [k, (v / r).toFixed(2)]));
  return [
    name.padEnd(28),
    'finish/car=' + (a.finishes / (4 * r)).toFixed(2),
    'deaths=' + (a.destructions / r).toFixed(1),
    'dmg=' + (a.damage / r).toFixed(0),
    'rounds=' + (a.turns / r / 4).toFixed(1),
    'firstFinishR=' + (a.sumWinnerRound / r).toFixed(1),
    'win%=' + JSON.stringify(wins),
    'cp=' + JSON.stringify(cp),
    'err=' + a.errors,
  ].join('  ');
}

console.log('N per config =', N);
configs.forEach(cfg => {
  const a = run(cfg);
  console.log(line(cfg.name, a));
});

