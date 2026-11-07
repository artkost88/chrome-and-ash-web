import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.join(here, '..', 'js');
for (const f of ['data.js', 'track-gen.js', 'track-editor.js']) require(path.join(js, f));
const CnA = globalThis.CnA;
const E = CnA.TrackEditor;

test('normalizeOptions clamps archetype, seed, budget and name', () => {
  const o = E.normalizeOptions({ archetype: 'snake', seed: -3, hazardMin: 9, hazardMax: 2, name: '  Моя <b>трасса</b>  ' });
  assert.equal(o.archetype, 'snake');
  assert.equal(o.seed, 0);
  assert.ok(o.hazardMin <= o.hazardMax);
  assert.ok(o.hazardMin >= 0 && o.hazardMax <= 6);
  assert.ok(!o.name.includes('<') && o.name.length <= 40);
  assert.equal(o.name, 'Моя трасса');
});

test('generate returns a valid deterministic spec and stats', () => {
  const a = E.generate({ archetype: 'snake', seed: 123, hazardMin: 2, hazardMax: 2, name: 'Тест' });
  const b = E.generate({ archetype: 'snake', seed: 123, hazardMin: 2, hazardMax: 2, name: 'Тест' });
  assert.equal(a.ok, true, JSON.stringify(a.issues));
  assert.deepEqual(a.spec, b.spec);
  assert.equal(a.spec.name, 'Тест');
  assert.equal(a.spec.seed, 123);
  assert.equal(a.stats.length, a.spec.size);
  assert.ok(a.stats.hazards >= 2 && a.stats.hazards <= 2);
});

test('preview is SVG and contains node/start markers', () => {
  const { spec, ok } = E.generate({ archetype: 'club', seed: 4, hazardMin: 1, hazardMax: 1, name: 'Клуб' });
  assert.equal(ok, true);
  const svg = E.previewSvg(spec);
  assert.match(svg, /^<svg /);
  assert.match(svg, /data-node="0"/);
  assert.match(svg, /data-start="1"/);
  assert.doesNotMatch(svg, /undefined|NaN/);
});

test('store saves, replaces, lists and removes tracks', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
  const store = E.createStore(storage);
  const { spec } = E.generate({ archetype: 'club', seed: 1, hazardMin: 0, hazardMax: 0, name: 'A' });
  const t1 = E.envelope(spec, 'A', 'custom-a');
  const t2 = E.envelope(spec, 'A2', 'custom-a');
  assert.equal(store.save(t1).ok, true);
  assert.equal(store.save(t2).ok, true);
  assert.equal(store.list().length, 1);
  assert.equal(store.get('custom-a').name, 'A2');
  assert.equal(store.remove('custom-a').ok, true);
  assert.equal(store.list().length, 0);
});

test('export/import round-trips and rejects broken input', () => {
  const store = E.createStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const { spec } = E.generate({ archetype: 'snake', seed: 8, hazardMin: 2, hazardMax: 2, name: 'S' });
  const env = E.envelope(spec, 'S', 'custom-s');
  const text = store.exportJson(env);
  assert.equal(store.importJson(text, new Date('2026-01-01')).ok, true);
  assert.equal(store.importJson('{bad', new Date()).ok, false);
  const bad = JSON.parse(text);
  bad.track.spec.nodes[0].type = 'start';
  bad.track.spec.nodes[1].type = 'start';
  assert.equal(store.importJson(JSON.stringify(bad), new Date()).ok, false);
});

/* ==================================================================== */
/* Stage B — B1: canonical representation, fromSpec/toSpec, migration.  */
/* ==================================================================== */

const TD = CnA.TrackDraft;
const ARCH = ['club', 'horseshoe', 'snake'];

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function gen(archetype, seed, budget) {
  return CnA.generateTrackSpec(seed, {
    archetype,
    size: CnA.TRACK_ARCHETYPES[archetype].defaultSize,
    ...(budget ? { hazardBudget: budget } : {}),
  });
}

function legacyHorseshoeExpected(spec) {
  const expected = clone(spec);
  const byId = new Map(expected.nodes.map((n) => [n.id, n]));
  for (const [id, q, r] of [[4, 8, 0], [5, 9, 0]]) {
    const n = byId.get(id);
    n.q = q; n.r = r;
    n.x = expected.hexSize * Math.sqrt(3) * (q + r / 2);
    n.y = expected.hexSize * 1.5 * r;
  }
  return expected;
}

function rekey(spec, fn) {
  const s = clone(spec);
  const map = new Map(s.nodes.map((n) => [n.id, fn(n.id)]));
  const m = (id) => map.get(id);
  s.nodes = s.nodes.map((n) => Object.assign(n, {
    id: m(n.id),
    next: (n.next || []).map(m),
    prev: (n.prev || []).map(m),
  }));
  s.main = s.main.map(m);
  s.grid = s.grid.map(m);
  s.startNode = m(s.startNode);
  s.checkpoints = s.checkpoints.map(m);
  if (s.pit) {
    if (s.pit.tile != null) s.pit.tile = m(s.pit.tile);
    if (s.pit.entry != null) s.pit.entry = m(s.pit.entry);
    if (s.pit.exit != null) s.pit.exit = m(s.pit.exit);
    s.pit.nodes = (s.pit.nodes || []).map(m);
  }
  if (s.shortcut) {
    s.shortcut.entry = m(s.shortcut.entry);
    s.shortcut.exit = m(s.shortcut.exit);
    s.shortcut.nodes = (s.shortcut.nodes || []).map(m);
  }
  if (Array.isArray(s.decor)) s.decor = s.decor.map(m);
  return s;
}

test('B1: fromSpec/toSpec is a strict identity for club and snake', () => {
  for (const archetype of ['club', 'snake']) {
    for (let seed = 1; seed <= 5; seed++) {
      const spec = gen(archetype, seed);
      const res = TD.fromSpec(spec);
      assert.equal(res.ok, true, JSON.stringify(res.issues));
      assert.equal(res.readOnly, false);
      assert.deepEqual(TD.toSpec(res.draft), spec, archetype + '/' + seed);
    }
  }
});

test('B1: horseshoe legacy bump is migrated exactly once', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const spec = gen('horseshoe', seed);
    const res = TD.fromSpec(spec);
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.deepEqual(res.draft.source.migrated, ['horseshoe-bump-v1']);
    assert.ok(res.warnings.some((w) => w.code === 'W_MIGRATED_GEOMETRY'));
    assert.deepEqual(TD.toSpec(res.draft), legacyHorseshoeExpected(spec), 'seed ' + seed);
  }
});

test('B1: rotated/rekeyed horseshoe is canonicalized before migration', () => {
  const spec = gen('horseshoe', 3);
  const expected = legacyHorseshoeExpected(spec);
  const k = 5;
  const rotated = clone(spec);
  rotated.main = rotated.main.slice(k).concat(rotated.main.slice(0, k));
  assert.notEqual(rotated.main[0], rotated.startNode);
  for (const candidate of [rotated, rekey(rotated, (id) => (id + 13) % 49)]) {
    const res = TD.fromSpec(candidate);
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.deepEqual(res.draft.source.migrated, ['horseshoe-bump-v1']);
    assert.deepEqual(TD.toSpec(res.draft), expected);
  }
});

test('B1: 100 seeds x 3 archetypes canonicalize to dense ids', () => {
  for (const archetype of ARCH) {
    for (let seed = 1; seed <= 100; seed++) {
      const spec = gen(archetype, seed);
      const input = clone(spec);
      const res = TD.fromSpec(spec);
      assert.equal(res.ok, true, archetype + '/' + seed + ': ' + JSON.stringify(res.issues.slice(0, 3)));
      assert.deepEqual(spec, input, 'input must not be mutated');
      const out = TD.toSpec(res.draft);
      out.nodes.forEach((n, i) => assert.equal(n.id, i, archetype + '/' + seed + ' dense ids'));
      assert.equal(out.startNode, 0);
      assert.equal(out.size, out.main.length);
      assert.deepEqual(out.main, out.main.map((_, i) => i));
      assert.equal(out.nodes.filter((n) => n.type === 'start').length, 1);
      const check = CnA.validateTrackSpec(out);
      assert.equal(check.ok, true, JSON.stringify(check.issues.slice(0, 3)));
    }
  }
});

test('B1: 100 seeds x 3 archetypes accept hazard budgets 0/2/5/6', () => {
  for (const archetype of ARCH) {
    for (const budget of [[0, 0], [2, 2], [5, 5], [6, 6]]) {
      for (let seed = 1; seed <= 100; seed += 9) {
        const spec = gen(archetype, seed, budget);
        const res = TD.fromSpec(spec);
        assert.equal(res.ok, true,
          archetype + '/' + seed + '/' + budget + ': ' + JSON.stringify(res.issues.slice(0, 3)));
      }
    }
  }
});

test('B1: canonicalize is immutable, idempotent and rejects dangling refs', () => {
  const spec = gen('snake', 9);
  const input = clone(spec);
  const a = TD.canonicalizeRepresentation(spec);
  assert.equal(a.ok, true);
  assert.deepEqual(spec, input);
  const b = TD.canonicalizeRepresentation(a.spec);
  assert.equal(b.ok, true);
  assert.deepEqual(b.spec, a.spec);

  const dangling = clone(spec);
  dangling.nodes = dangling.nodes.filter((n) => n.id !== 5);
  const broken = TD.canonicalizeRepresentation(dangling);
  assert.equal(broken.ok, false);
  assert.ok(broken.issues.some((i) => i.code === 'E_REF'));

  const dup = clone(spec);
  dup.nodes[1].id = dup.nodes[0].id;
  const dupRes = TD.canonicalizeRepresentation(dup);
  assert.equal(dupRes.ok, false);
  assert.ok(dupRes.issues.some((i) => i.code === 'E_DUP_ID'));
});

test('B1: broken specs stay broken through fromSpec and report', () => {
  const spec = gen('club', 4);
  const broken = clone(spec);
  broken.nodes[5].next = [];
  assert.equal(E.report(broken).ok, false);
  assert.equal(TD.fromSpec(broken).ok, false);
});

test('B1: validateStructural rejects the review constructs', () => {
  const snake = gen('snake', 5);
  const wrapped = clone(snake);
  wrapped.shortcut.entry = 28;
  wrapped.shortcut.exit = 2;
  assert.ok(TD.validateStructural(wrapped).issues.some((i) => i.code === 'E_SHORTCUT_WRAP'));

  const conflict = clone(snake);
  conflict.pit = { entry: 3, exit: 5, nodes: [31] };
  assert.ok(TD.validateStructural(conflict).issues.some((i) => i.code === 'E_BRANCH_CONFLICT'));

  const unknown = clone(snake);
  unknown.nodes[3].type = 'portal';
  assert.ok(TD.validateStructural(unknown).issues.some((i) => i.code === 'E_TYPE'));

  const horseshoe = gen('horseshoe', 2);
  const gridEntry = clone(horseshoe);
  gridEntry.grid = [33, 33, 35, 35];
  assert.ok(TD.validateStructural(gridEntry).issues.some((i) => i.code === 'E_GRID_ENTRY'));

  const dangling = clone(snake);
  dangling.nodes[7].next = [999];
  assert.ok(TD.validateStructural(dangling).issues.some((i) => i.code === 'E_REF'));

  const duplicate = clone(snake);
  duplicate.nodes[9].q = duplicate.nodes[8].q;
  duplicate.nodes[9].r = duplicate.nodes[8].r;
  assert.ok(TD.validateStructural(duplicate).issues.some((i) => i.code === 'E_DUPLICATE_COORD'));

  const degree = clone(snake);
  degree.nodes[7].next = [8, 9];
  assert.ok(TD.validateStructural(degree).issues.some((i) => i.code === 'E_DEGREE'));

  const input = clone(horseshoe);
  TD.validateStructural(horseshoe);
  assert.deepEqual(horseshoe, input);
});

test('B1: validateStructural enforces branch and start-zone rules', () => {
  const snake = gen('snake', 8);
  const noRisk = clone(snake);
  noRisk.shortcut.nodes.forEach((id) => { noRisk.nodes.find((n) => n.id === id).type = 'straight'; });
  assert.ok(TD.validateStructural(noRisk).issues.some((i) => i.code === 'E_SHORTCUT_RISK'));

  const horseshoe = gen('horseshoe', 8);
  const pitBypass = clone(horseshoe);
  pitBypass.pit.entry = 10;
  pitBypass.pit.exit = 20;
  assert.ok(TD.validateStructural(pitBypass).issues.some((i) => i.code === 'E_PIT_CP_BYPASS'));

  const pitShort = clone(horseshoe);
  pitShort.pit.entry = 28;
  pitShort.pit.exit = 33;
  pitShort.pit.nodes = [36, 37];
  assert.ok(TD.validateStructural(pitShort).issues.some((i) => i.code === 'E_PIT_LENGTH'));

  const hazardStart = clone(snake);
  hazardStart.nodes.find((n) => n.id === hazardStart.grid[0]).type = 'sand';
  assert.ok(TD.validateStructural(hazardStart).issues.some((i) => i.code === 'E_HAZARD_ZONE'));

  const rampStart = clone(snake);
  rampStart.nodes.find((n) => n.id === rampStart.grid[0]).type = 'ramp';
  assert.ok(TD.validateStructural(rampStart).issues.some((i) => i.code === 'E_RAMP_ZONE'));
});

test('B1: non-axial and fork specs load read-only, not rejected', () => {
  const polar = gen('club', 1);
  polar.layout = 'polar';
  const fork = gen('snake', 1);
  for (const n of fork.nodes) {
    if (n.id === 4) n.type = 'fork';
  }
  for (const spec of [polar, fork]) {
    const res = TD.fromSpec(spec);
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.equal(res.readOnly, true);
    assert.ok(res.reason);
  }
});

test('B1: report exposes read-only specs and never mutates input', () => {
  const polar = gen('club', 2);
  polar.layout = 'polar';
  const input = clone(polar);
  const r = E.report(polar);
  assert.equal(r.ok, true);
  assert.equal(r.readOnly, true);
  assert.deepEqual(polar, input);
});

test('storage corruption and malformed generated specs do not throw', () => {
  const store = E.createStore({
    getItem: () => '{not-json',
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  });
  assert.deepEqual(store.list(), []);
  const { spec } = E.generate({ archetype: 'horseshoe', seed: 2, hazardMin: 4, hazardMax: 4, name: 'H' });
  const broken = JSON.parse(JSON.stringify(spec));
  broken.nodes[0].next = [];
  const r = E.report(broken);
  assert.equal(r.ok, false);
  assert.ok(r.issues.length > 0);
});
