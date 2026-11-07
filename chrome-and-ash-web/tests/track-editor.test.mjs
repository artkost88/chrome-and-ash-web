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
