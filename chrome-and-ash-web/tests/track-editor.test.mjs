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

/* ==================================================================== */
/* Stage B — B2: select/paint/insert/remove/move + atomic rollback.     */
/* ==================================================================== */

function sessionFor(spec) {
  const r = TD.createSession(spec);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.session);
  return r.session;
}

function draftNode(draft, uid) { return draft.nodes.find((n) => n.uid === uid); }
function isHazardType(t) { return CnA.HAZARD_TILES.includes(t); }
function draftNodeAt(draft, q, r) { return draft.nodes.find((n) => n.q === q && n.r === r); }
function isAdj(a, b) {
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  return dirs.some(([dq, dr]) => b.q - a.q === dq && b.r - a.r === dr);
}
function freeCommonCell(draft, aUid, bUid) {
  const a = draftNode(draft, aUid), b = draftNode(draft, bUid);
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const candidates = [];
  for (const [dq, dr] of dirs) candidates.push({ q: a.q + dq, r: a.r + dr });
  return candidates.filter((c) =>
    isAdj(c, b) && !draft.nodes.some((n) => n.q === c.q && n.r === c.r));
}
function featureUids(draft) {
  return new Set([draft.startUid, draft.checkpointUid, ...draft.grid,
    draft.pit && draft.pit.tile, draft.pit && draft.pit.entry, draft.pit && draft.pit.exit,
    draft.shortcut && draft.shortcut.entry, draft.shortcut && draft.shortcut.exit]);
}
function paintable(session) {
  const feature = featureUids(session.draft);
  return session.draft.main.filter((uid) => {
    if (feature.has(uid)) return false;
    const node = draftNode(session.draft, uid);
    return node && ['straight', 'turn'].includes(node.type);
  });
}

test('B2: paint updates the draft and undo restores it', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const uid = paintable(s)[0];
  const before = clone(s.draft);
  const r = s.apply({ op: 'paint', uid, type: 'sand' });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(draftNode(s.draft, uid).type, 'sand');
  assert.equal(s.selectionUid, uid);
  assert.equal(s.revision, 1);
  assert.equal(TD.toSpec(s.draft).nodes.find((n) => n.id === s.draft.main.indexOf(uid)).type, 'sand');
  s.undo();
  assert.deepEqual(s.draft, before);
});

test('B2: paint rejects the third consecutive hazard atomically', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const clean = new Set(paintable(s));
  let start = -1;
  for (let i = 0; i < s.draft.main.length; i++) {
    if (clean.has(s.draft.main[i]) && clean.has(s.draft.main[(i + 1) % s.draft.main.length]) &&
      clean.has(s.draft.main[(i + 2) % s.draft.main.length])) { start = i; break; }
  }
  assert.ok(start >= 0, 'need three consecutive paintable tiles');
  const [a, b, c] = [0, 1, 2].map((k) => s.draft.main[(start + k) % s.draft.main.length]);
  assert.equal(s.apply({ op: 'paint', uid: a, type: 'sand' }).ok, true);
  assert.equal(s.apply({ op: 'paint', uid: b, type: 'sand' }).ok, true);
  const before = clone(s.draft);
  const past = s.past.length;
  const r = s.apply({ op: 'paint', uid: c, type: 'sand' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'E_HAZARD_RUN'));
  assert.deepEqual(s.draft, before);
  assert.equal(s.past.length, past);
});

test('B2: paint keeps at least one hazard on a shortcut', () => {
  const s = sessionFor(gen('snake', 3));
  const ids = s.draft.shortcut.nodes.slice();
  assert.ok(ids.length >= 1);
  for (let i = 0; i < ids.length - 1; i++) {
    const r = s.apply({ op: 'paint', uid: ids[i], type: 'straight' });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  }
  const before = clone(s.draft);
  const r = s.apply({ op: 'paint', uid: ids[ids.length - 1], type: 'straight' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'E_SHORTCUT_RISK'));
  assert.deepEqual(s.draft, before);
});

test('B2: paint protects feature tiles, branches and type locks', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const freeUid = paintable(s)[0];
  assert.ok(s.apply({ op: 'paint', uid: s.draft.startUid, type: 'sand' }).issues
    .some((i) => i.code === 'E_PAINT_FEATURE'));
  assert.ok(s.apply({ op: 'paint', uid: freeUid, type: 'start' }).issues
    .some((i) => i.code === 'E_PAINT_FEATURE'));
  const branch = sessionFor(gen('horseshoe', 1));
  const pitNode = branch.draft.pit.nodes[0];
  assert.ok(branch.apply({ op: 'paint', uid: pitNode, type: 'straight' }).issues
    .some((i) => i.code === 'E_TILE_ROLE'));
  const snake = sessionFor(gen('snake', 3));
  assert.ok(snake.apply({ op: 'paint', uid: snake.draft.shortcut.nodes[0], type: 'tunnel' }).issues
    .some((i) => i.code === 'E_TILE_ROLE'));
  const locked = sessionFor(gen('club', 1, [0, 0]));
  const uid = paintable(locked)[0];
  assert.equal(locked.apply({ op: 'setLock', uid, flags: { type: true } }).ok, true);
  assert.ok(locked.apply({ op: 'paint', uid, type: 'sand' }).issues
    .some((i) => i.code === 'E_LOCKED_TYPE'));
});

test('B2: insertBetween adds a dense node and rolls back', () => {
  const s = sessionFor(gen('snake', 2));
  const before = clone(s.draft);
  const startLen = s.draft.main.length;
  let inserted = null;
  for (let i = 0; i < s.draft.main.length && !inserted; i++) {
    const from = s.draft.main[i];
    const to = s.draft.main[(i + 1) % s.draft.main.length];
    const r = s.apply({ op: 'insertBetween', from, to });
    if (r.ok) inserted = r;
  }
  assert.ok(inserted, 'at least one main edge must accept a node');
  assert.equal(s.draft.main.length, startLen + 1);
  assert.ok(s.draft.nodes.some((n) => n.uid === inserted.selectionUid));
  const out = TD.toSpec(s.draft);
  assert.equal(out.size, startLen + 1);
  assert.equal(CnA.validateTrackSpec(out).ok, true, JSON.stringify(CnA.validateTrackSpec(out).issues));
  s.undo();
  assert.deepEqual(s.draft, before);
});

test('B2: insertBetween rejects non-edges, max length and full cells', () => {
  const s = sessionFor(gen('snake', 2));
  assert.ok(s.apply({ op: 'insertBetween', from: s.draft.main[0], to: s.draft.main[2] }).issues
    .some((i) => i.code === 'E_INSERT_EDGE'));
  const full = sessionFor(gen('horseshoe', 1));
  assert.equal(full.draft.main.length, 36);
  assert.ok(full.apply({ op: 'insertBetween', from: full.draft.main[0], to: full.draft.main[1] }).issues
    .some((i) => i.code === 'E_LENGTH_MAX'));
});

test('B2: remove deletes a legal bend and rejects protected geometry', () => {
  const s = sessionFor(gen('snake', 2));
  const feature = featureUids(s.draft);
  const n = s.draft.main.length;
  let bend = null, straight = null;
  for (let i = 2; i < n - 1; i++) {
    const uid = s.draft.main[i];
    if (feature.has(uid)) continue;
    const prev = draftNode(s.draft, s.draft.main[i - 1]);
    const next = draftNode(s.draft, s.draft.main[i + 1]);
    if (isAdj(prev, next) && !bend) bend = uid;
    if (!isAdj(prev, next) && !straight) straight = uid;
  }
  assert.ok(bend, 'generated snake must have a bend');
  const before = clone(s.draft);
  const r = s.apply({ op: 'remove', uid: bend });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(s.draft.main.length, n - 1);
  s.undo();
  assert.deepEqual(s.draft, before);
  assert.ok(straight, 'generated snake must have a straight run');
  assert.ok(s.apply({ op: 'remove', uid: straight }).issues.some((i) => i.code === 'E_REMOVE_GEOMETRY'));
  assert.ok(s.apply({ op: 'remove', uid: s.draft.startUid }).issues.some((i) => i.code === 'E_REMOVE_FEATURE'));
  assert.ok(s.apply({ op: 'remove', uid: s.draft.grid[0] }).issues.some((i) => i.code === 'E_REMOVE_FEATURE'));
  assert.ok(s.apply({ op: 'remove', uid: s.draft.checkpointUid }).issues.some((i) => i.code === 'E_REMOVE_FEATURE'));
});

test('B2: remove respects the minimum lap length', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const uid = paintable(s)[0];
  assert.ok(s.apply({ op: 'remove', uid }).issues.some((i) => i.code === 'E_LENGTH_MIN'));
});

test('B2: move keeps all road neighbours adjacent and rolls back', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const feature = featureUids(s.draft);
  let uid = null, target = null;
  for (let i = 1; i < n - 1 && !uid; i++) {
    const u = s.draft.main[i];
    if (feature.has(u)) continue;
    const prev = s.draft.main[i - 1];
    const next = s.draft.main[i + 1];
    const cells = freeCommonCell(s.draft, prev, next);
    if (cells.length) { uid = u; target = cells[0]; }
  }
  assert.ok(uid && target, 'need a bend with a free legal target');
  const before = clone(s.draft);
  const r = s.apply({ op: 'move', uid, q: target.q, r: target.r });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(draftNode(s.draft, uid).q, target.q);
  assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);
  s.undo();
  assert.deepEqual(s.draft, before);

  const occupied = draftNode(s.draft, s.draft.main[3]);
  assert.ok(s.apply({ op: 'move', uid, q: occupied.q, r: occupied.r }).issues
    .some((i) => i.code === 'E_MOVE_OCCUPIED'));
  assert.ok(s.apply({ op: 'move', uid, q: 99, r: 99 }).issues
    .some((i) => i.code === 'E_MOVE_ADJACENCY'));
  assert.ok(s.apply({ op: 'move', uid: s.draft.startUid, q: 99, r: 99 }).ok === false);
});

test('B2: move honours the position lock', () => {
  const s = sessionFor(gen('snake', 2));
  const uid = s.draft.main[5];
  assert.equal(s.apply({ op: 'setLock', uid, flags: { pos: true } }).ok, true);
  assert.ok(s.apply({ op: 'move', uid, q: 99, r: 99 }).issues.some((i) => i.code === 'E_LOCKED_POS'));
});

test('B2: select validates the node and does not create history', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const past = s.past.length;
  assert.equal(s.apply({ op: 'select', uid: s.draft.main[3] }).ok, true);
  assert.equal(s.selectionUid, s.draft.main[3]);
  assert.equal(s.past.length, past);
  assert.ok(s.apply({ op: 'select', uid: 'nope' }).issues.some((i) => i.code === 'E_NO_NODE'));
});

test('B2: validateDraft reports axial and duplicate problems', () => {
  const res = TD.fromSpec(gen('club', 1, [0, 0]));
  const draft = clone(res.draft);
  draft.nodes[5].q = 0.5;
  assert.ok(TD.validateDraft(draft).issues.some((i) => i.code === 'E_AXIAL'));
  const dup = clone(res.draft);
  const other = draftNode(dup, dup.main[6]);
  const node = draftNode(dup, dup.main[7]);
  other.q = node.q; other.r = node.r;
  assert.ok(TD.validateDraft(dup).issues.some((i) => i.code === 'E_DUPLICATE_COORD'));
});

/* ==================================================================== */
/* Stage B — B3: start/checkpoint/grid, pit and shortcut tools.         */
/* ==================================================================== */

function mainIndex(s, uid) { return s.draft.main.indexOf(uid); }
function cpIndexInRange(s) {
  const idx = mainIndex(s, s.draft.checkpointUid);
  return idx >= Math.ceil(s.draft.main.length * 0.25) && idx <= Math.floor(s.draft.main.length * 0.65);
}

test('B3: setStart rotates the loop, moves grid and keeps the lap valid', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const cp = mainIndex(s, s.draft.checkpointUid);
  const feature = featureUids(s.draft);
  let uid = null;
  for (let i = 1; i < n; i++) {
    const u = s.draft.main[i];
    if (feature.has(u)) continue;
    const node = draftNode(s.draft, u);
    if (!node || isHazardType(node.type) || node.type === 'ramp') continue;
    const newCp = (cp - i + n) % n;
    if (newCp < Math.ceil(n * 0.25) || newCp > Math.floor(n * 0.65)) continue;
    const g1 = draftNode(s.draft, s.draft.main[(i - 1 + n) % n]);
    const g2 = draftNode(s.draft, s.draft.main[(i - 2 + n) % n]);
    if (!['straight', 'turn'].includes(g1.type) || !['straight', 'turn'].includes(g2.type)) continue;
    uid = u;
    break;
  }
  assert.ok(uid, 'need a legal new start');
  const oldStart = s.draft.startUid;
  const r = s.apply({ op: 'setStart', uid });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(s.draft.startUid, uid);
  assert.equal(s.draft.main[0], uid);
  assert.equal(draftNode(s.draft, uid).type, 'start');
  assert.equal(draftNode(s.draft, oldStart).type, 'straight');
  assert.deepEqual(s.draft.grid, [
    s.draft.main[n - 1], s.draft.main[n - 1], s.draft.main[n - 2], s.draft.main[n - 2],
  ]);
  assert.ok(cpIndexInRange(s));
  const spec = TD.toSpec(s.draft);
  assert.equal(CnA.validateTrackSpec(spec).ok, true, JSON.stringify(CnA.validateTrackSpec(spec).issues));
});

test('B3: setStart rejects roles, locks, CP range and wrapped branches', () => {
  const s = sessionFor(gen('snake', 2));
  assert.ok(s.apply({ op: 'setStart', uid: s.draft.checkpointUid }).issues
    .some((i) => i.code === 'E_START_CP'));
  const n = s.draft.main.length;
  const cp = mainIndex(s, s.draft.checkpointUid);
  const feature = featureUids(s.draft);
  const outOfRange = s.draft.main.find((u, i) => i > 0 && !feature.has(u) &&
    !isHazardType(draftNode(s.draft, u).type) && draftNode(s.draft, u).type !== 'ramp' &&
    (((cp - i + n) % n) < Math.ceil(n * 0.25) || ((cp - i + n) % n) > Math.floor(n * 0.65)));
  assert.ok(outOfRange);
  assert.ok(s.apply({ op: 'setStart', uid: outOfRange }).issues.some((i) => i.code === 'E_START_CP_RANGE'));

  const wrap = sessionFor(gen('snake', 2));
  const scEntry = mainIndex(wrap, wrap.draft.shortcut.entry);
  const scExit = mainIndex(wrap, wrap.draft.shortcut.exit);
  const wrapUid = wrap.draft.main.find((u, i) => i > 0 &&
    (scEntry - i + n) % n >= (scExit - i + n) % n &&
    !featureUids(wrap.draft).has(u) && !isHazardType(draftNode(wrap.draft, u).type));
  assert.ok(wrapUid);
  assert.ok(wrap.apply({ op: 'setStart', uid: wrapUid }).issues.some((i) => i.code === 'E_SHORTCUT_WRAP'));

  const horse = sessionFor(gen('horseshoe', 2));
  assert.ok(horse.apply({ op: 'setStart', uid: horse.draft.main[34] }).issues
    .some((i) => i.code === 'E_GRID_ENTRY'));

  const locked = sessionFor(gen('snake', 2));
  const target = locked.draft.main[5];
  assert.equal(locked.apply({ op: 'setLock', uid: target, flags: { type: true } }).ok, true);
  assert.ok(locked.apply({ op: 'setStart', uid: target }).issues.some((i) => i.code === 'E_LOCKED_TYPE'));
});

test('B3: setCheckpoint moves the CP within 25..65%', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const feature = featureUids(s.draft);
  const uid = s.draft.main.find((u, i) => i > 0 && i / n >= 0.25 && i / n <= 0.65 &&
    !feature.has(u) && !isHazardType(draftNode(s.draft, u).type) && draftNode(s.draft, u).type !== 'ramp');
  assert.ok(uid);
  const oldCp = s.draft.checkpointUid;
  const r = s.apply({ op: 'setCheckpoint', uid });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(s.draft.checkpointUid, uid);
  assert.equal(draftNode(s.draft, oldCp).type, 'straight');
  assert.equal(draftNode(s.draft, uid).type, 'checkpoint');
  assert.deepEqual(TD.toSpec(s.draft).checkpoints, [0, mainIndex(s, uid)]);
  assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);
});

test('B3: setCheckpoint rejects range, grid, start and hazards', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const out = s.draft.main.find((u, i) => i > 0 && i / n < 0.25);
  assert.ok(out);
  assert.ok(s.apply({ op: 'setCheckpoint', uid: out }).issues
    .some((i) => i.code === 'E_CHECKPOINT_RANGE'));
  assert.ok(s.apply({ op: 'setCheckpoint', uid: s.draft.grid[0] }).issues
    .some((i) => i.code === 'E_CHECKPOINT_GRID'));
  assert.ok(s.apply({ op: 'setCheckpoint', uid: s.draft.startUid }).issues
    .some((i) => i.code === 'E_CHECKPOINT_ROLE'));
});

test('B3: setPitTile replaces the tile after confirmation and keeps a shortcut', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const oldPit = s.draft.pit.tile;
  const newPit = paintable(s).find((u) => u !== oldPit);
  assert.ok(newPit);
  const pending = s.apply({ op: 'setPitTile', uid: newPit });
  assert.equal(pending.ok, false);
  assert.equal(pending.requiresConfirm, true);
  const r = s.apply({ op: 'setPitTile', uid: newPit, force: true });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(s.draft.pit.kind, 'tile');
  assert.equal(s.draft.pit.tile, newPit);
  assert.equal(draftNode(s.draft, oldPit).type, 'straight');
  assert.equal(draftNode(s.draft, newPit).type, 'pit');
  const out = TD.toSpec(s.draft);
  assert.equal(out.pit.tile, mainIndex(s, newPit));
  assert.equal(CnA.validateTrackSpec(out).ok, true);

  const snake = sessionFor(gen('snake', 2));
  const uid = paintable(snake)[0];
  const r2 = snake.apply({ op: 'setPitTile', uid, force: true });
  assert.equal(r2.ok, true, JSON.stringify(r2.issues));
  assert.equal(snake.draft.pit.kind, 'tile');
  assert.ok(snake.draft.shortcut);
  assert.equal(CnA.validateTrackSpec(TD.toSpec(snake.draft)).ok, true);
});

test('B3: clearPit then setPitBranch restores the v1 horseshoe pit (33 -> 35)', () => {
  const s = sessionFor(gen('horseshoe', 1));
  assert.equal(s.draft.pit.kind, 'branch');
  const cleared = s.apply({ op: 'clearPit', force: true });
  assert.equal(cleared.ok, true, JSON.stringify(cleared.issues));
  assert.equal(s.draft.pit, null);
  const entry = s.draft.main[33];
  const exit = s.draft.main[35];
  const r = s.apply({ op: 'setPitBranch', entry, exit, force: true });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(s.draft.pit.kind, 'branch');
  assert.ok(s.draft.pit.nodes.length >= 2);
  const out = TD.toSpec(s.draft);
  assert.equal(CnA.validateTrackSpec(out).ok, true, JSON.stringify(CnA.validateTrackSpec(out).issues));
  assert.equal(out.grid[0], out.pit.exit);
  const firstRoute = s.draft.pit.nodes.map((u) => draftNode(s.draft, u)).map((n) => [n.q, n.r]);
  assert.equal(s.apply({ op: 'clearPit', force: true }).ok, true);
  assert.equal(s.apply({ op: 'setPitBranch', entry, exit, force: true }).ok, true);
  const secondRoute = s.draft.pit.nodes.map((u) => draftNode(s.draft, u)).map((n) => [n.q, n.r]);
  assert.deepEqual(secondRoute, firstRoute, 'auto route must be deterministic');
});

test('B3: setPitBranch rejects wrap, distance, CP bypass, grid entry and conflict', () => {
  const s = sessionFor(gen('horseshoe', 1));
  assert.ok(s.apply({ op: 'clearPit', force: true }).ok);
  assert.ok(s.apply({ op: 'setPitBranch', entry: s.draft.main[33], exit: s.draft.main[2], force: true }).issues
    .some((i) => i.code === 'E_PIT_WRAP'));
  assert.ok(s.apply({ op: 'setPitBranch', entry: s.draft.main[5], exit: s.draft.main[20], force: true }).issues
    .some((i) => i.code === 'E_PIT_DISTANCE'));
  assert.ok(s.apply({ op: 'setPitBranch', entry: s.draft.main[12], exit: s.draft.main[16], force: true }).issues
    .some((i) => i.code === 'E_PIT_CP_BYPASS'));
  assert.ok(s.apply({ op: 'setPitBranch', entry: s.draft.main[34], exit: s.draft.main[35], force: true }).issues
    .some((i) => i.code === 'E_GRID_ENTRY'));
  const snake = sessionFor(gen('snake', 2));
  assert.ok(snake.apply({ op: 'setPitBranch', entry: snake.draft.main[5], exit: snake.draft.main[9], force: true }).issues
    .some((i) => i.code === 'E_BRANCH_CONFLICT'));
  assert.equal(s.apply({ op: 'setFeatureLock', feature: 'pit', locked: true }).ok, true);
  assert.ok(s.apply({ op: 'clearPit', force: true }).issues.some((i) => i.code === 'E_LOCKED_FEATURE'));
});

test('B3: setShortcut builds a risky branch and clearShortcut removes it', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const feature = featureUids(s.draft);
  let built = null;
  for (let a = 4; a < n - 3 && !built; a++) {
    for (let b = a + 3; b < n - 3; b++) {
      const entry = s.draft.main[a];
      const exit = s.draft.main[b];
      if (feature.has(entry) || feature.has(exit)) continue;
      const r = s.apply({ op: 'setShortcut', entry, exit, force: true });
      if (r.ok) { built = { entry, exit, warnings: r.warnings }; break; }
    }
  }
  assert.ok(built, 'snake must accept at least one shortcut');
  assert.equal(s.draft.shortcut.entry, built.entry);
  assert.equal(s.draft.shortcut.exit, built.exit);
  assert.ok(s.draft.shortcut.nodes.length >= 1);
  assert.ok(s.draft.shortcut.nodes.some((u) => isHazardType(draftNode(s.draft, u).type)));
  const out = TD.toSpec(s.draft);
  assert.equal(CnA.validateTrackSpec(out).ok, true, JSON.stringify(CnA.validateTrackSpec(out).issues));
  const cleared = s.apply({ op: 'clearShortcut', force: true });
  assert.equal(cleared.ok, true, JSON.stringify(cleared.issues));
  assert.equal(s.draft.shortcut, null);
  assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);
});

test('B3: setShortcut rejects wrap, near-start, saving, conflict and locks', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const n = s.draft.main.length;
  assert.ok(s.apply({ op: 'setShortcut', entry: s.draft.main[n - 4], exit: s.draft.main[3] }).issues
    .some((i) => i.code === 'E_SHORTCUT_WRAP'));
  assert.ok(s.apply({ op: 'setShortcut', entry: s.draft.main[2], exit: s.draft.main[10] }).issues
    .some((i) => i.code === 'E_SHORTCUT_NEAR_START'));
  assert.ok(s.apply({ op: 'setShortcut', entry: s.draft.main[4], exit: s.draft.main[6] }).issues
    .some((i) => i.code === 'E_SHORTCUT_SAVING'));
  const horse = sessionFor(gen('horseshoe', 1));
  assert.ok(horse.apply({ op: 'setShortcut', entry: horse.draft.main[5], exit: horse.draft.main[10] }).issues
    .some((i) => i.code === 'E_BRANCH_CONFLICT'));
  assert.equal(s.apply({ op: 'setFeatureLock', feature: 'shortcut', locked: true }).ok, true);
  assert.ok(s.apply({ op: 'setShortcut', entry: s.draft.main[5], exit: s.draft.main[10] }).issues
    .some((i) => i.code === 'E_LOCKED_FEATURE'));
});

/* ==================================================================== */
/* Stage B — B4: session history, locks, dirty, budget and properties.  */
/* ==================================================================== */

function bruteMaxHazards(n, protectedSet, maxRun) {
  let best = 0;
  for (let mask = 0; mask < (1 << n); mask++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) {
        if (protectedSet.has(i)) { ok = false; break; }
        for (let k = 1; k <= maxRun; k++) {
          if (!((mask >> ((i - k + n) % n)) & 1)) break;
          if (k === maxRun) ok = false;
        }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) count++;
    if (count > best) best = count;
  }
  return best;
}

test('B4: hazard budget DP matches brute force for n=6..12', () => {
  for (let n = 6; n <= 12; n++) {
    for (let t = 0; t < 20; t++) {
      const rng = CnA.mulberry32(n * 101 + t);
      const protectedSet = new Set();
      for (let i = 0; i < n; i++) if (rng() < 0.25) protectedSet.add(i);
      assert.equal(TD.maxPaintHazards(n, protectedSet), bruteMaxHazards(n, protectedSet, 2), 'n=' + n + ' t=' + t);
    }
  }
});

test('B4: generate reports the real hazard budget and warns on underfill', () => {
  const r = E.generate({ archetype: 'club', seed: 5, hazardMin: 6, hazardMax: 6, name: 'Бюджет' });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.budget);
  assert.equal(r.budget.requestedMin, 6);
  assert.equal(r.budget.requestedMax, 6);
  assert.equal(r.budget.actual, r.stats.hazards);
  assert.ok(r.budget.achievable >= r.budget.actual);
  assert.equal(r.budget.achievable, TD.maxGeneratedHazards(r.spec));
  if (r.budget.actual < 6) {
    assert.equal(r.budget.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'W_HAZARD_BUDGET'));
    assert.match(r.issues.find((i) => i.code === 'W_HAZARD_BUDGET').message, /максимум/);
  }
});

test('B4: undo/redo restores draft, selection and lock flags', () => {
  const s = sessionFor(gen('snake', 2));
  const uid = paintable(s)[0];
  const initial = clone(s.draft);
  assert.equal(s.apply({ op: 'paint', uid, type: 'sand' }).ok, true);
  assert.equal(s.apply({ op: 'setLock', uid, flags: { pos: true } }).ok, true);
  assert.deepEqual(s.draft.locks.nodes[uid], { pos: true });
  assert.equal(s.undo().ok, true);
  assert.equal(s.draft.locks.nodes[uid], undefined);
  assert.equal(s.undo().ok, true);
  assert.deepEqual(s.draft, initial);
  assert.equal(s.undo().ok, false);
  assert.ok(s.undo().issues.some((i) => i.code === 'E_UNDO_EMPTY'));
  assert.equal(s.redo().ok, true);
  assert.equal(draftNode(s.draft, uid).type, 'sand');
  assert.equal(s.redo().ok, true);
  assert.equal(s.draft.locks.nodes[uid].pos, true);
  assert.equal(s.redo().ok, false);
  assert.ok(s.redo().issues.some((i) => i.code === 'E_REDO_EMPTY'));
});

test('B4: history is capped at 50 snapshots', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const uid = paintable(s)[0];
  for (let i = 0; i < 60; i++) {
    assert.equal(s.apply({ op: 'setLock', uid, flags: { pos: i % 2 === 0 } }).ok, true);
  }
  assert.equal(s.past.length, 50);
});

test('B4: dirty/unsavedNew follow edits, locks and markSaved', () => {
  const s = sessionFor(gen('snake', 2));
  assert.equal(s.dirty, false);
  assert.equal(s.unsavedNew, true);
  const uid = paintable(s)[0];
  assert.equal(s.apply({ op: 'paint', uid, type: 'sand' }).ok, true);
  assert.equal(s.dirty, true);
  s.undo();
  assert.equal(s.dirty, false);
  const rev = s.revision;
  assert.equal(s.apply({ op: 'setLock', uid, flags: { type: true } }).ok, true);
  assert.equal(s.revision, rev + 1);
  assert.equal(s.dirty, false, 'locks are not part of the exported spec');
  s.markSaved('custom-test');
  assert.equal(s.unsavedNew, false);
  assert.equal(s.dirty, false);
  assert.equal(s.apply({ op: 'paint', uid: paintable(s)[1], type: 'debris' }).ok, true);
  assert.equal(s.dirty, true);
  const reset = s.reset({ force: true });
  assert.equal(reset.ok, true, JSON.stringify(reset.issues));
  assert.equal(s.dirty, false);
  assert.equal(s.past.length, 0);
});

test('B4: reset without force asks for confirmation and returns migrated baseline', () => {
  const spec = gen('horseshoe', 3);
  const expected = legacyHorseshoeExpected(spec);
  const s = sessionFor(spec);
  const uid = paintable(s)[0];
  assert.equal(s.apply({ op: 'paint', uid, type: 'sand' }).ok, true);
  const pending = s.reset();
  assert.equal(pending.ok, false);
  assert.equal(pending.requiresConfirm, true);
  const r = s.reset({ force: true });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(TD.toSpec(s.draft), expected);
  assert.equal(s.dirty, false);
});

test('B4: read-only sessions reject edits but still report', () => {
  const spec = gen('snake', 1);
  for (const n of spec.nodes) if (n.id === 4) n.type = 'fork';
  const created = TD.createSession(spec);
  assert.equal(created.ok, true);
  assert.equal(created.readOnly, true);
  assert.ok(created.session);
  const s = created.session;
  assert.ok(s.apply({ op: 'paint', uid: s.draft.main[3], type: 'sand' }).issues
    .some((i) => i.code === 'E_READONLY'));
  const rep = s.report();
  assert.equal(rep.ok, true);
  assert.equal(rep.readOnly, true);
});

test('B4: remove lock blocks deletion and is undoable', () => {
  const s = sessionFor(gen('snake', 2));
  const feature = featureUids(s.draft);
  const n = s.draft.main.length;
  let bend = null;
  for (let i = 2; i < n - 1 && !bend; i++) {
    const uid = s.draft.main[i];
    if (feature.has(uid)) continue;
    if (isAdj(draftNode(s.draft, s.draft.main[i - 1]), draftNode(s.draft, s.draft.main[i + 1]))) bend = uid;
  }
  assert.ok(bend);
  assert.equal(s.apply({ op: 'setLock', uid: bend, flags: { remove: true } }).ok, true);
  assert.ok(s.apply({ op: 'remove', uid: bend }).issues.some((i) => i.code === 'E_LOCKED_REMOVE'));
  s.undo();
  assert.equal(s.apply({ op: 'remove', uid: bend }).ok, true);
});

test('B4: branch-node removal is atomic and keeps branch metadata consistent', () => {
  const s = sessionFor(gen('horseshoe', 1));
  const branch = s.draft.pit.nodes.slice();
  assert.ok(branch.length >= 3);
  const before = clone(s.draft);
  const last = branch[branch.length - 1];
  const ok = s.apply({ op: 'remove', uid: last });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(s.draft.pit.nodes.length, branch.length - 1);
  assert.ok(!s.draft.pit.nodes.includes(last));
  assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);
  s.undo();
  assert.deepEqual(s.draft, before);
  const middle = branch[branch.length - 2];
  const rejected = s.apply({ op: 'remove', uid: middle });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some((i) => i.code === 'E_REMOVE_GEOMETRY'));
  assert.deepEqual(s.draft, before);
});

/* ==================================================================== */
/* task-12: code-review fixes (P0 first).                               */
/* ==================================================================== */

function expectRejectedEverywhere(spec, code) {
  const from = TD.fromSpec(spec);
  assert.equal(from.ok, false);
  assert.ok(from.issues.some((i) => i.code === code), 'fromSpec: ' + JSON.stringify(from.issues.slice(0, 3)));
  const rep = E.report(spec);
  assert.equal(rep.ok, false);
  assert.ok(rep.issues.some((i) => i.code === code), 'report: ' + JSON.stringify(rep.issues.slice(0, 3)));
  const session = TD.createSession(spec);
  assert.equal(session.ok, false);
  const map = new Map();
  const store = E.createStore({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  });
  const saved = store.save(E.envelope(spec, 'Bad', 'custom-bad'));
  assert.equal(saved.ok, false);
  assert.ok(saved.issues.some((i) => i.code === code), 'save: ' + JSON.stringify(saved.issues.slice(0, 3)));
  const text = JSON.stringify({ kind: 'cna-track', version: 1, track: E.envelope(spec, 'Bad', 'custom-bad2') });
  const imported = store.importJson(text);
  assert.equal(imported.ok, false);
  assert.ok(imported.issues.some((i) => i.code === code), 'import: ' + JSON.stringify(imported.issues.slice(0, 3)));
}

test('B4-fix: inserts on the last three main edges recompute the grid', () => {
  const n = 31;
  for (const edge of [n - 3, n - 2, n - 1]) {
    const s = sessionFor(gen('snake', 2));
    const before = clone(s.draft);
    const from = s.draft.main[edge];
    const to = s.draft.main[(edge + 1) % n];
    const r = s.apply({ op: 'insertBetween', from, to });
    assert.equal(r.ok, true, 'edge ' + edge + ': ' + JSON.stringify(r.issues));
    assert.equal(s.draft.main.length, n + 1);
    const expected = [
      s.draft.main[s.draft.main.length - 1], s.draft.main[s.draft.main.length - 1],
      s.draft.main[s.draft.main.length - 2], s.draft.main[s.draft.main.length - 2],
    ];
    assert.deepEqual(s.draft.grid, expected, 'edge ' + edge);
    assert.deepEqual(TD.toSpec(s.draft).grid, [
      s.draft.main.length - 1, s.draft.main.length - 1, s.draft.main.length - 2, s.draft.main.length - 2,
    ]);
    assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);
    s.undo();
    assert.deepEqual(s.draft, before);
  }
});

test('B4-fix: last-edge removal recomputes the grid', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const feature = featureUids(s.draft);
  const uid = s.draft.main[n - 3];
  assert.ok(!feature.has(uid));
  const r = s.apply({ op: 'remove', uid });
  if (r.ok) {
    assert.equal(s.draft.main.length, n - 1);
    assert.deepEqual(s.draft.grid, [
      s.draft.main[s.draft.main.length - 1], s.draft.main[s.draft.main.length - 1],
      s.draft.main[s.draft.main.length - 2], s.draft.main[s.draft.main.length - 2],
    ]);
    assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);
  } else {
    assert.ok(r.issues.some((i) => i.code === 'E_REMOVE_GEOMETRY' || i.code === 'E_REMOVE_FEATURE'));
  }
});

test('B4-fix: swapped main order is rejected by every entry point', () => {
  const spec = gen('snake', 2);
  const swapped = clone(spec);
  const tmp = swapped.main[3];
  swapped.main[3] = swapped.main[4];
  swapped.main[4] = tmp;
  expectRejectedEverywhere(swapped, 'E_LOOP');
});

test('B4-fix: startNode with a non-start type is rejected by every entry point', () => {
  const spec = gen('snake', 2);
  const broken = clone(spec);
  broken.nodes.find((n) => n.id === broken.startNode).type = 'straight';
  broken.nodes.find((n) => n.id === 5).type = 'start';
  expectRejectedEverywhere(broken, 'E_START_COUNT');
});

test('B4-fix: feature locks block every feature mutation', () => {
  const start = sessionFor(gen('snake', 2));
  assert.equal(start.apply({ op: 'setFeatureLock', feature: 'start', locked: true }).ok, true);
  assert.ok(start.apply({ op: 'setStart', uid: start.draft.main[5] }).issues
    .some((i) => i.code === 'E_LOCKED_FEATURE'));
  const cp = sessionFor(gen('snake', 2));
  assert.equal(cp.apply({ op: 'setFeatureLock', feature: 'checkpoint', locked: true }).ok, true);
  assert.ok(cp.apply({ op: 'setCheckpoint', uid: cp.draft.main[10] }).issues
    .some((i) => i.code === 'E_LOCKED_FEATURE'));

  const grid = sessionFor(gen('snake', 2));
  assert.equal(grid.apply({ op: 'setFeatureLock', feature: 'grid', locked: true }).ok, true);
  const n = grid.draft.main.length;
  assert.ok(grid.apply({ op: 'insertBetween', from: grid.draft.main[n - 1], to: grid.draft.main[0] }).issues
    .some((i) => i.code === 'E_LOCKED_FEATURE'));
  assert.equal(grid.apply({ op: 'insertBetween', from: grid.draft.main[5], to: grid.draft.main[6] }).ok, true);

  const pit = sessionFor(gen('horseshoe', 1));
  assert.equal(pit.apply({ op: 'setFeatureLock', feature: 'pit', locked: true }).ok, true);
  for (const r of [
    pit.apply({ op: 'clearPit', force: true }),
    pit.apply({ op: 'setPitTile', uid: pit.draft.main[5], force: true }),
    pit.apply({ op: 'setPitBranch', entry: pit.draft.main[33], exit: pit.draft.main[35], force: true }),
  ]) assert.ok(r.issues.some((i) => i.code === 'E_LOCKED_FEATURE'));

  const sc = sessionFor(gen('snake', 2));
  assert.equal(sc.apply({ op: 'setFeatureLock', feature: 'shortcut', locked: true }).ok, true);
  assert.ok(sc.apply({ op: 'setShortcut', entry: sc.draft.main[4], exit: sc.draft.main[8], force: true }).issues
    .some((i) => i.code === 'E_LOCKED_FEATURE'));
  assert.ok(sc.apply({ op: 'clearShortcut', force: true }).issues
    .some((i) => i.code === 'E_LOCKED_FEATURE'));
});

test('B4-fix: node type/remove locks protect branch tools', () => {
  const club = sessionFor(gen('club', 1, [0, 0]));
  const pitTile = club.draft.pit.tile;
  assert.equal(club.apply({ op: 'setLock', uid: pitTile, flags: { type: true } }).ok, true);
  assert.ok(club.apply({ op: 'clearPit', force: true }).issues.some((i) => i.code === 'E_LOCKED_TYPE'));
  assert.ok(club.apply({ op: 'setPitBranch', entry: club.draft.main[5], exit: club.draft.main[8], force: true }).issues
    .some((i) => i.code === 'E_LOCKED_TYPE'));

  const horse = sessionFor(gen('horseshoe', 1));
  const branchUid = horse.draft.pit.nodes[0];
  assert.equal(horse.apply({ op: 'setLock', uid: branchUid, flags: { remove: true } }).ok, true);
  assert.ok(horse.apply({ op: 'clearPit', force: true }).issues.some((i) => i.code === 'E_LOCKED_REMOVE'));
  assert.ok(horse.apply({ op: 'setPitTile', uid: horse.draft.main[5], force: true }).issues
    .some((i) => i.code === 'E_LOCKED_REMOVE'));
  assert.ok(horse.apply({ op: 'setPitBranch', entry: horse.draft.main[33], exit: horse.draft.main[35], force: true }).issues
    .some((i) => i.code === 'E_LOCKED_REMOVE'));

  const snake = sessionFor(gen('snake', 2));
  const scUid = snake.draft.shortcut.nodes[0];
  assert.equal(snake.apply({ op: 'setLock', uid: scUid, flags: { remove: true } }).ok, true);
  assert.ok(snake.apply({ op: 'clearShortcut', force: true }).issues.some((i) => i.code === 'E_LOCKED_REMOVE'));
  assert.ok(snake.apply({ op: 'setShortcut', entry: snake.draft.main[4], exit: snake.draft.main[13], force: true }).issues
    .some((i) => i.code === 'E_LOCKED_REMOVE'));
});

test('B4-fix: insertBetween recognises the branch exit edge', () => {
  const s = sessionFor(gen('snake', 2));
  const built = s.apply({ op: 'setShortcut', entry: s.draft.main[4], exit: s.draft.main[13], force: true });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  const sc = s.draft.shortcut;
  const last = sc.nodes[sc.nodes.length - 1];
  const r = s.apply({ op: 'insertBetween', from: last, to: sc.exit });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(s.draft.shortcut.nodes.length, sc.nodes.length + 1);
  assert.equal(CnA.validateTrackSpec(TD.toSpec(s.draft)).ok, true);

  const horse = sessionFor(gen('horseshoe', 1));
  const pitLast = horse.draft.pit.nodes[horse.draft.pit.nodes.length - 1];
  const pitExit = horse.draft.pit.exit;
  const pitR = horse.apply({ op: 'insertBetween', from: pitLast, to: pitExit });
  assert.notEqual(pitR.issues[0] && pitR.issues[0].code, 'E_INSERT_EDGE');
});

test('B4-fix: pit cannot be both tile and branch and pit ends are protected', () => {
  const both = gen('horseshoe', 1);
  both.pit.tile = 2;
  assert.ok(TD.validateStructural(both).issues.some((i) => i.code === 'E_PIT'));
  expectRejectedEverywhere(both, 'E_PIT');

  const hazardEntry = gen('horseshoe', 1);
  hazardEntry.nodes.find((n) => n.id === hazardEntry.pit.entry).type = 'sand';
  assert.ok(TD.validateStructural(hazardEntry).issues.some((i) => i.code === 'E_HAZARD_ZONE'));
  assert.equal(E.report(hazardEntry).ok, false);

  const rampExit = gen('horseshoe', 1);
  rampExit.nodes.find((n) => n.id === rampExit.pit.exit).type = 'ramp';
  assert.ok(TD.validateStructural(rampExit).issues.some((i) => i.code === 'E_RAMP_ZONE'));
  assert.equal(E.report(rampExit).ok, false);
});

test('B4-fix: setStart rejects hazards/ramps in the new start zone', () => {
  const s = sessionFor(gen('snake', 2));
  const n = s.draft.main.length;
  const cp = mainIndex(s, s.draft.checkpointUid);
  let uid = null;
  for (let i = 1; i < n; i++) {
    const u = s.draft.main[i];
    const node = draftNode(s.draft, u);
    const g1 = draftNode(s.draft, s.draft.main[(i - 1 + n) % n]);
    const g2 = draftNode(s.draft, s.draft.main[(i - 2 + n) % n]);
    if (!node || isHazardType(node.type) || node.type === 'ramp') continue;
    if (isHazardType(g1.type) || isHazardType(g2.type) || g1.type === 'ramp' || g2.type === 'ramp') { uid = u; break; }
    const newCp = (cp - i + n) % n;
    if (newCp < Math.ceil(n * 0.25) || newCp > Math.floor(n * 0.65)) continue;
    g1.type = 'sand';
    uid = u;
    break;
  }
  assert.ok(uid);
  assert.ok(s.apply({ op: 'setStart', uid }).issues.some((i) => i.code === 'E_START_ZONE'));
});

test('B4-fix: store/import reject wrapped, both, unknown and grid-entry specs', () => {
  const wrapped = gen('snake', 2);
  wrapped.shortcut.entry = 28;
  wrapped.shortcut.exit = 2;
  expectRejectedEverywhere(wrapped, 'E_SHORTCUT_WRAP');

  const unknown = gen('snake', 2);
  unknown.nodes.find((n) => n.id === 4).type = 'portal';
  expectRejectedEverywhere(unknown, 'E_TYPE');

  const gridEntry = gen('horseshoe', 1);
  gridEntry.grid = [33, 33, 35, 35];
  expectRejectedEverywhere(gridEntry, 'E_GRID_ENTRY');

  const both = gen('snake', 2);
  both.pit = { entry: 3, exit: 5, nodes: [both.shortcut.nodes[0]] };
  assert.ok(TD.validateStructural(both).issues.some((i) => i.code === 'E_BRANCH_CONFLICT'));
  const map = new Map();
  const store = E.createStore({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  });
  assert.equal(store.save(E.envelope(both, 'Both', 'custom-both')).ok, false);
  const text = JSON.stringify({ kind: 'cna-track', version: 1, track: E.envelope(both, 'Both', 'custom-both2') });
  assert.equal(store.importJson(text).ok, false);
});

test('B4-fix: save/export/import store the canonical (migrated) spec', () => {
  const map = new Map();
  const store = E.createStore({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  });
  const legacy = gen('horseshoe', 1);
  const env = E.envelope(legacy, 'Legacy', 'custom-legacy');
  const saved = store.save(env);
  assert.equal(saved.ok, true, JSON.stringify(saved.issues));
  assert.equal(store.get('custom-legacy').spec.nodes.find((n) => n.id === 4).q, 8);
  assert.equal(store.get('custom-legacy').spec.nodes.find((n) => n.id === 4).r, 0);
  const text = store.exportJson(env);
  const parsed = JSON.parse(text);
  assert.equal(parsed.track.spec.nodes.find((n) => n.id === 4).r, 0);
  const imported = store.importJson(text);
  assert.equal(imported.ok, true);
  assert.equal(imported.track.spec.nodes.find((n) => n.id === 4).q, 8);
  const club = gen('club', 1);
  assert.deepEqual(store.importJson(store.exportJson(E.envelope(club, 'C', 'custom-c'))).track.spec, club);
});

test('B4-fix: redo keeps the past stack capped at 50', () => {
  const s = sessionFor(gen('club', 1, [0, 0]));
  const uid = paintable(s)[0];
  for (let i = 0; i < 60; i++) {
    assert.equal(s.apply({ op: 'paint', uid, type: i % 2 === 0 ? 'sand' : 'straight' }).ok, true);
  }
  while (s.past.length) s.undo();
  assert.equal(s.future.length, 50);
  for (let i = 0; i < 60; i++) {
    const r = s.redo();
    if (!r.ok) break;
    assert.ok(s.past.length <= 50);
  }
  assert.equal(s.past.length, 50);
  assert.equal(s.future.length, 0);
});

test('B4-fix: generate budget achievable is truthful for club seed 5 [6,6]', () => {
  const r = E.generate({ archetype: 'club', seed: 5, hazardMin: 6, hazardMax: 6, name: 'Truth' });
  assert.ok(r.budget);
  const spec = r.spec;
  const main = spec.main;
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const protectedIds = new Set([spec.startNode, ...spec.grid, ...spec.checkpoints]);
  (spec.pit.nodes || []).forEach((id) => protectedIds.add(id));
  [spec.pit.entry, spec.pit.exit, spec.pit.tile].forEach((id) => { if (id != null) protectedIds.add(id); });
  (spec.shortcut && spec.shortcut.nodes || []).forEach((id) => protectedIds.add(id));
  if (spec.shortcut) { protectedIds.add(spec.shortcut.entry); protectedIds.add(spec.shortcut.exit); }
  const protectAround = (id, radius) => {
    const idx = main.indexOf(id);
    if (idx >= 0) for (let d = -radius; d <= radius; d++) protectedIds.add(main[(idx + d + main.length) % main.length]);
  };
  protectAround(spec.startNode, 3);
  spec.checkpoints.forEach((id) => protectAround(id, 2));
  const allowed = main.map((id) => {
    const node = byId.get(id);
    return !protectedIds.has(id) && (node.type === 'straight' || node.type === 'turn' || CnA.HAZARD_TILES.includes(node.type));
  });
  const brute = (() => {
    let best = 0;
    const n = main.length;
    for (let mask = 0; mask < (1 << n); mask++) {
      let ok = true, count = 0;
      for (let i = 0; i < n && ok; i++) {
        if (!((mask >> i) & 1)) continue;
        if (!allowed[i]) { ok = false; break; }
        count++;
        if ((mask >> ((i + 1) % n)) & 1) ok = false;
        if ((mask >> ((i - 1 + n) % n)) & 1) ok = false;
      }
      if (ok && count > best) best = count;
    }
    return best;
  })();
  assert.equal(r.budget.achievable, TD.maxGeneratedHazards(spec));
  assert.ok(r.budget.actual <= r.budget.achievable);
  assert.ok(r.budget.achievable >= brute, 'dp must not be below brute force');
  if (r.budget.actual < 6) {
    const w = r.issues.find((i) => i.code === 'W_HAZARD_BUDGET');
    assert.ok(w);
    assert.match(w.message, new RegExp('максимум — ' + r.budget.achievable));
  }
});

test('B4-fix: undo restores selection and focus snapshots', () => {
  const s = sessionFor(gen('snake', 2));
  const [a, b, c] = paintable(s);
  s.select(a);
  s.apply({ op: 'paint', uid: b, type: 'sand' });
  s.select(c);
  assert.equal(s.selectionUid, c);
  s.undo();
  assert.equal(s.selectionUid, a);
  assert.equal(s.focusUid, a);
  s.redo();
  assert.equal(s.selectionUid, c);
  assert.equal(s.focusUid, c);
});

test('B4: structural validation gates store save/import', () => {
  const map = new Map();
  const store = E.createStore({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  });
  const spec = gen('snake', 3);
  spec.shortcut.nodes.forEach((id) => { spec.nodes.find((n) => n.id === id).type = 'straight'; });
  const env = E.envelope(spec, 'Плохой срез', 'custom-bad');
  const saved = store.save(env);
  assert.equal(saved.ok, false);
  assert.ok(saved.issues.some((i) => i.code === 'E_SHORTCUT_RISK'));
  const text = JSON.stringify({ kind: 'cna-track', version: 1, track: env });
  const imported = store.importJson(text);
  assert.equal(imported.ok, false);
  assert.ok(imported.issues.some((i) => i.code === 'E_SHORTCUT_RISK'));
});

test('B4: random operations are atomic, valid, dense and fully undoable', () => {
  const s = sessionFor(gen('snake', 6));
  const initial = clone(s.draft);
  const rng = CnA.mulberry32(424242);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  let accepted = 0;
  for (let iter = 0; iter < 500; iter++) {
    const roll = rng();
    let op;
    if (roll < 0.34) {
      op = { op: 'paint', uid: pick(s.draft.nodes).uid, type: pick(TD.PAINT_TYPES) };
    } else if (roll < 0.52) {
      const uid = pick(s.draft.main);
      const node = draftNode(s.draft, uid);
      const dir = pick([[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]);
      op = { op: 'move', uid, q: node.q + dir[0], r: node.r + dir[1] };
    } else if (roll < 0.64) {
      const i = Math.floor(rng() * s.draft.main.length);
      op = { op: 'insertBetween', from: s.draft.main[i], to: s.draft.main[(i + 1) % s.draft.main.length] };
    } else if (roll < 0.74) {
      op = { op: 'remove', uid: pick(s.draft.nodes).uid };
    } else if (roll < 0.82) {
      op = { op: 'setStart', uid: pick(s.draft.main) };
    } else if (roll < 0.90) {
      op = { op: 'setCheckpoint', uid: pick(s.draft.main) };
    } else if (roll < 0.94) {
      op = { op: 'setPitTile', uid: pick(s.draft.main), force: true };
    } else if (roll < 0.97) {
      op = { op: 'setShortcut', entry: pick(s.draft.main), exit: pick(s.draft.main), force: true };
    } else {
      op = { op: rng() < 0.5 ? 'clearPit' : 'clearShortcut', force: true };
    }
    const before = clone(s.draft);
    const r = s.apply(op);
    if (r.ok) {
      accepted++;
      const check = TD.validateDraft(s.draft);
      assert.equal(check.ok, true, iter + ' ' + JSON.stringify(op) + ': ' + JSON.stringify(check.issues.slice(0, 3)));
      const out = TD.toSpec(s.draft);
      out.nodes.forEach((n, i) => assert.equal(n.id, i, 'dense ids at op ' + iter));
      assert.equal(CnA.validateTrackSpec(out).ok, true, 'stage A at op ' + iter);
    } else {
      assert.deepEqual(s.draft, before, 'rejected op must not mutate at ' + iter);
    }
  }
  assert.ok(accepted > 0);
  const beforeUndo = clone(s.draft);
  while (s.past.length) s.undo();
  assert.equal(s.past.length, 0);
  assert.equal(s.future.length, Math.min(accepted, 50));
  while (s.future.length) assert.equal(s.redo().ok, true);
  assert.deepEqual(s.draft, beforeUndo);
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
