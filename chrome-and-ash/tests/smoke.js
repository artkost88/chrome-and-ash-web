const path = require('path');
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'track-gen.js'));
require(path.join(__dirname, '..', 'js', 'track.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
require(path.join(__dirname, '..', 'js', 'ai.js'));
const CnA = globalThis.CnA;

const seed = Number(process.argv[2] || 12345);
const game = CnA.createGame({ mode: 'race', humanFaction: null, seed, laps: 1, quiet: true });
let guard = 0;
while (!game.race.over && guard++ < 4000) {
  CnA.aiTakeTurn(game);
}
console.log('guard', guard, 'over', game.race.over, 'round', game.race.round);
console.log('track', game.race.track.count, game.race.track.fork);
console.log('finishOrder', game.race.finishOrder);
if (game.race.results) {
  console.table(game.race.results.rows.map(r => ({
    name: r.name, pos: r.pos, fin: r.finished, cp: r.cpGained, scrap: r.scrapGained,
    dmg: r.damage, kills: r.kills, hp: r.hp,
  })));
  console.log('stats', game.race.stats);
}
const cars = game.cars.map(c => ({
  name: c.name, node: c.node, laps: c.lapsDone, cp: c.cp, scrap: c.scrap, up: c.upgrades,
  raceStats: c.raceStats,
}));
console.log(cars);

