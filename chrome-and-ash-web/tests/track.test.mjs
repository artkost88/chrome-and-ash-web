import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.join(here, '..', 'js');
for (const f of ['data.js', 'track-gen.js', 'track.js', 'engine.js', 'ai.js']) require(path.join(js, f));
const CnA = globalThis.CnA;
const ARCHETYPES = ['club', 'horseshoe', 'snake'];

function specFor(archetype, seed) {
  return CnA.generateTrackSpec(seed, { archetype, size: CnA.TRACK_ARCHETYPES[archetype].defaultSize });
}

test('three archetypes generate valid specs for 100 seeds', () => {
  for (const archetype of ARCHETYPES) {
    for (let seed = 1; seed <= 100; seed++) {
      const spec = specFor(archetype, seed);
      const check = CnA.validateTrackSpec(spec);
      assert.equal(check.ok, true, archetype + '/' + seed + ': ' + JSON.stringify(check.issues.slice(0, 3)));
      assert.equal(new Set(spec.grid).size, 2);
      assert.equal(spec.nodes.filter((n) => n.type === 'start').length, 1);
    }
  }
});

test('generation is deterministic', () => {
  const a = specFor('snake', 4242);
  const b = specFor('snake', 4242);
  assert.deepEqual(a, b);
  const ra = CnA.compileTrack(a);
  const rb = CnA.compileTrack(b);
  assert.deepEqual(ra.nodes, rb.nodes);
});

test('compiled track is reachable and has runtime fields', () => {
  for (const archetype of ARCHETYPES) {
    const track = CnA.generateTrack(7, { archetype });
    assert.ok(track.nodes.length >= 24);
    assert.ok(Array.isArray(track.edges));
    assert.equal(track.grid.length, 4);
    assert.equal(new Set(track.grid).size, 2);
    assert.ok(track.checkpoints.length >= 1);
    for (const n of track.main) {
      const node = track.nodes[n];
      assert.ok(node.next.length > 0);
      assert.ok(isFinite(track.distFromStart[n]));
      assert.ok(isFinite(track.distToFinish[n]));
    }
    assert.deepEqual(CnA.validateTrack(track), []);
  }
});

test('engine accepts a selected archetype', () => {
  const game = CnA.createGame({ mode: 'race', humanFaction: 'rust', seed: 42, trackArchetype: 'snake', trackSize: 30, laps: 1, quiet: true });
  assert.equal(game.race.track.archetype, 'snake');
  assert.equal(game.race.track.name, 'Змея');
  assert.equal(new Set(game.race.track.grid).size, 2);
});

test('engine compiles a custom spec and preserves its name', () => {
  const spec = CnA.generateTrackSpec(77, { archetype: 'snake', size: 31 });
  spec.name = 'Авторская змея';
  const game = CnA.createGame({
    humanFaction: 'chrome', trackSpec: spec, trackName: spec.name,
    trackArchetype: 'custom', trackSize: spec.size, quiet: true,
  });
  assert.equal(game.race.track.name, 'Авторская змея');
  assert.equal(game.race.track.main.length, spec.main.length);
  assert.equal(game.trackSpec.name, 'Авторская змея');
  assert.equal(new Set(game.race.track.grid).size, 2);
});

test('engine rejects an invalid custom spec', () => {
  const spec = CnA.generateTrackSpec(77, { archetype: 'snake' });
  spec.nodes[1].type = 'start';
  assert.throws(() => CnA.createGame({ trackSpec: spec, quiet: true }), /invalid trackSpec/);
});

test('validator catches broken graph and hazard rules', () => {
  const spec = specFor('club', 1);
  const broken = JSON.parse(JSON.stringify(spec));
  broken.nodes[5].next = [];
  let check = CnA.validateTrackSpec(broken);
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((i) => i.code === 'E_DEAD_END' || i.code === 'E_REACHABILITY'));

  const hazard = JSON.parse(JSON.stringify(spec));
  const gridId = hazard.grid[0];
  hazard.nodes.find((n) => n.id === gridId).type = 'sand';
  check = CnA.validateTrackSpec(hazard);
  assert.ok(check.issues.some((i) => i.code === 'E_HAZARD_ZONE' || i.code === 'E_GRID'));
});

test('horseshoe keeps a pit branch and checkpoint', () => {
  const spec = specFor('horseshoe', 3);
  assert.ok(spec.pit);
  assert.ok(spec.pit.nodes.length >= 2);
  assert.ok(spec.checkpoints.length >= 2);
  const check = CnA.validateTrackSpec(spec);
  assert.equal(check.ok, true, JSON.stringify(check.issues.slice(0, 4)));
});

test('snake has a shortcut and no pit', () => {
  const spec = specFor('snake', 5);
  assert.equal(spec.pit, null);
  assert.ok(spec.shortcut);
  assert.ok(spec.shortcut.nodes.length >= 1);
  const shortcutTypes = spec.shortcut.nodes.map((id) => spec.nodes.find((n) => n.id === id).type);
  assert.ok(shortcutTypes.some((t) => ['sand', 'debris', 'event'].includes(t)), 'срез должен иметь риск');
});

test('hazard budget override is valid and respected', () => {
  for (const archetype of ['club', 'horseshoe', 'snake']) {
    for (const budget of [[0, 0], [2, 2], [5, 5]]) {
      for (let seed = 1; seed <= 20; seed++) {
        const spec = CnA.generateTrackSpec(seed, {
          archetype,
          size: CnA.TRACK_ARCHETYPES[archetype].defaultSize,
          hazardBudget: budget,
        });
        const report = CnA.validateTrackSpec(spec);
        assert.equal(report.ok, true, `${archetype}/${seed}: ${JSON.stringify(report.issues.slice(0, 3))}`);
        const count = spec.main.filter((id) => {
          const node = spec.nodes.find((n) => n.id === id);
          return node && CnA.HAZARD_TILES.includes(node.type);
        }).length;
        assert.ok(count >= budget[0] && count <= budget[1], `${archetype}/${seed}: ${count} hazards for ${budget}`);
      }
    }
  }
});
