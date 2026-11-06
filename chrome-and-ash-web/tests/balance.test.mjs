import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.join(here, '..', 'js');
for (const f of ['data.js', 'track.js', 'engine.js', 'ai.js']) require(path.join(js, f));
const CnA = globalThis.CnA;

function gameFor(faction = 'chrome', seed = 7) {
  return CnA.createGame({ mode: 'race', humanFaction: faction, seed, laps: 1, quiet: false });
}
function turn(over = {}) {
  return Object.assign({
    speed: 0, remaining: 0, rolled: false, prepUsed: false, fireUsed: false,
    freeTrapUsed: false, nitro: false, brake: false, ignoreHazards: false,
    eventPending: false, pitDeclared: false, extraAttack: false, speedBase: 0,
    empDisabled: false, wildfire: false,
  }, over);
}
function armAttack(game, car, target, cardType = 'mg') {
  car.node = 10;
  target.node = 11;
  car.hp = car.maxHp;
  target.hp = 1;
  car.hand = [{ uid: 'test-card', type: cardType }];
  game.race.phase = 'fire';
  game.race.over = false;
  game.race.turn = turn({ fireUsed: false });
  return { targetId: target.id, uid: 'test-card' };
}

test('start grid uses two tiles with two cars each', () => {
  const game = gameFor('rust', 11);
  const counts = {};
  for (const car of game.cars) counts[car.node] = (counts[car.node] || 0) + 1;
  assert.equal(Object.keys(counts).length, 2);
  assert.deepEqual(Object.values(counts).sort((a, b) => a - b), [2, 2]);
});

test('faction HP is compressed to 19/22/22/18', () => {
  const hp = Object.fromEntries(CnA.FACTIONS.map((f) => [f.id, f.hp]));
  assert.deepEqual(hp, { chrome: 19, rust: 22, carnival: 22, swarm: 18 });
});

test('finish window is two rounds after the leader', () => {
  const game = gameFor('rust', 19);
  assert.equal(game.options.extraRounds, 2);
});

test('mine card is 2d4', () => {
  assert.equal(CnA.CARDS.mine.dmg, '2d4');
});

test('debris deals exactly 1 damage and keeps its movement penalty', () => {
  const game = gameFor('rust', 12);
  const car = game.cars.find((c) => c.human);
  const debris = Object.values(game.race.track.nodes).find((n) => n.type === 'debris' && n.prev && n.prev.length);
  assert.ok(debris, 'track must contain debris');
  car.node = debris.prev[0];
  car.hp = car.maxHp;
  game.race.phase = 'move';
  game.race.turn = turn({ speed: 4, remaining: 4, rolled: true });
  const res = CnA.stepMovement(game, car, debris.id, false);
  assert.equal(res.ok, true);
  assert.equal(car.hp, car.maxHp - 1);
});

test('mine log says 2d4 and damage is within 2..8', () => {
  const game = gameFor('rust', 13);
  const car = game.cars.find((c) => c.human);
  const debris = Object.values(game.race.track.nodes).find((n) => n.type === 'debris' && n.prev && n.prev.length);
  assert.ok(debris);
  car.node = debris.prev[0];
  car.hp = car.maxHp;
  game.race.tokens = [{ type: 'mine', node: debris.id, owner: null }];
  game.race.phase = 'move';
  game.race.turn = turn({ speed: 4, remaining: 4, rolled: true });
  CnA.stepMovement(game, car, debris.id, false);
  const hit = game.log.find((l) => l.text.includes('МИНА!'));
  assert.ok(hit, 'mine log line');
  assert.match(hit.text, /2d4/);
  const m = hit.text.match(/\(2d4=(\d+)\)/);
  assert.ok(m);
  assert.ok(Number(m[1]) >= 2 && Number(m[1]) <= 8);
});

test('attack gives -1 next movement (recoil)', () => {
  const game = gameFor('rust', 14);
  const car = game.cars.find((c) => c.human);
  const target = game.cars.find((c) => c.id !== car.id);
  const { targetId, uid } = armAttack(game, car, target);
  const res = CnA.playAttack(game, car, uid, targetId);
  assert.equal(res.ok, true);
  assert.equal(car.nextMovePenalty, 1);
});

test('Chrome Wildfire cancels recoil and spends a charge', () => {
  const game = gameFor('chrome', 15);
  const car = game.cars.find((c) => c.human);
  const target = game.cars.find((c) => c.id !== car.id);
  car.flags.wildfireCharges = 2;
  const { targetId, uid } = armAttack(game, car, target);
  const armed = CnA.armWildfire(game, car);
  assert.equal(armed.ok, true);
  assert.equal(armed.armed, true);
  const res = CnA.playAttack(game, car, uid, targetId);
  assert.equal(res.ok, true);
  assert.equal(car.nextMovePenalty, 0);
  assert.equal(car.flags.wildfireCharges, 1);
});

test('DNF placement points are 5/3/1/0', () => {
  const game = gameFor('rust', 16);
  const [a, b, c, d] = game.cars;
  a.finished = true;
  a.finishPos = 1;
  game.race.finishOrder = [a.id];
  b.node = 20;
  c.node = 10;
  d.node = 5;
  game.race.phase = 'done';
  const res = CnA.endRace(game);
  const byId = Object.fromEntries(res.rows.map((r) => [r.carId, r]));
  assert.equal(byId[a.id].cpPos, 10);
  assert.equal(byId[b.id].cpPos, 3);
  assert.equal(byId[c.id].cpPos, 1);
  assert.equal(byId[d.id].cpPos, 0);
});

test('first-lap kill gives +1 CP; later kill gives +3', () => {
  const game = gameFor('chrome', 17);
  const car = game.cars.find((c) => c.human);
  const enemy1 = game.cars.find((c) => c.id !== car.id);
  let setup = armAttack(game, car, enemy1);
  car.lapsDone = 0;
  const cp0 = car.cp;
  assert.equal(CnA.playAttack(game, car, setup.uid, setup.targetId).ok, true);
  assert.equal(car.cp - cp0, 1);

  const enemy2 = game.cars.find((c) => c.id !== car.id && c.id !== enemy1.id);
  car.node = 10;
  enemy2.node = 9;
  enemy2.hp = 1;
  car.hand = [{ uid: 'test-card-2', type: 'mg' }];
  game.race.phase = 'fire';
  game.race.turn = turn({ fireUsed: false });
  car.lapsDone = 1;
  const cp1 = car.cp;
  assert.equal(CnA.playAttack(game, car, 'test-card-2', enemy2.id).ok, true);
  assert.equal(car.cp - cp1, 3);
});

test('reroll d4 is available once per race', () => {
  const game = gameFor('rust', 18);
  const car = game.cars.find((c) => c.human);
  game.race.phase = 'prep';
  game.race.turn = turn();
  const first = CnA.rollMove(game, car);
  assert.equal(first.ok, true);
  game.race.phase = 'move';
  const rr = CnA.rerollMove(game, car);
  assert.equal(rr.ok, true);
  assert.equal(car.flags.rerollUsed, true);
  assert.ok(rr.roll >= 1 && rr.roll <= 4);
  const rr2 = CnA.rerollMove(game, car);
  assert.equal(rr2.ok, false);
});
