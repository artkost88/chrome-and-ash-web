import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { report, prepareSpec, prepareLibrarySpec, cleanName, validateTrackSpec } from '../src/track-spec.js';

test('C1: track-spec loads client code in an isolated VM context', () => {
  assert.equal(typeof globalThis.CnA, 'undefined', 'VM must not leak CnA into the server process');
});

const clientDir = new URL('../../chrome-and-ash-web/js/', import.meta.url);
let CnA = null;
function ensureClient() {
  if (CnA) return CnA;
  (0, eval)(readFileSync(new URL('data.js', clientDir), 'utf8'));
  (0, eval)(readFileSync(new URL('track-gen.js', clientDir), 'utf8'));
  CnA = globalThis.CnA;
  return CnA;
}

function sample(archetype, seed) {
  ensureClient();
  return CnA.generateTrackSpec(seed, {
    archetype,
    size: CnA.TRACK_ARCHETYPES[archetype].defaultSize,
  });
}

test('C1: report/prepareSpec expose the shared client validator', () => {
  const spec = sample('snake', 7);
  assert.equal(report(spec).ok, true, JSON.stringify(report(spec).issues));
  assert.equal(validateTrackSpec(spec).ok, true);
  const prepared = prepareSpec(spec);
  assert.equal(prepared.ok, true);
  assert.ok(prepared.canonical);
  assert.equal(prepared.canonical.layout, 'axial');
});

test('C1: prepareLibrarySpec stores dense canonical editable specs', () => {
  for (const archetype of ['club', 'snake', 'clover', 'rift']) {
    const spec = sample(archetype, 3);
    const res = prepareLibrarySpec(spec);
    assert.equal(res.ok, true, archetype + ': ' + JSON.stringify(res.issues));
    assert.equal(res.readOnly, false);
    assert.ok(res.spec);
    res.spec.nodes.forEach((n, i) => assert.equal(n.id, i));
    assert.equal(res.spec.main[0], 0);
    assert.equal(res.spec.startNode, 0);
    assert.equal(validateTrackSpec(res.spec).ok, true);
    assert.equal(Number.isFinite(res.spec.hexSize), true);
    assert.equal(res.spec.levels, 1);
  }
});

test('C1: legacy horseshoe is accepted only in migrated canonical form', () => {
  const legacy = sample('horseshoe', 3);
  assert.equal(legacy.nodes.find((n) => n.id === 4).r, -1);
  const res = prepareLibrarySpec(legacy);
  assert.equal(res.ok, true, JSON.stringify(res.issues));
  assert.equal(res.spec.nodes.find((n) => n.id === 4).q, 8);
  assert.equal(res.spec.nodes.find((n) => n.id === 4).r, 0);
  assert.equal(res.spec.nodes.find((n) => n.id === 5).q, 9);
  assert.equal(res.spec.nodes.find((n) => n.id === 5).r, 0);
});

test('C1: read-only geometry is rejected by the library validator', () => {
  const polar = sample('club', 1);
  polar.layout = 'polar';
  let res = prepareLibrarySpec(polar);
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.code === 'E_LAYOUT' || i.code === 'E_READONLY'));
  assert.equal(report(polar).readOnly, true);

  const fork = sample('snake', 1);
  fork.nodes.find((n) => n.id === 4).type = 'fork';
  res = prepareLibrarySpec(fork);
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.code === 'E_READONLY' || i.code === 'E_TYPE'));

  const decor = sample('club', 1);
  decor.decor = (decor.decor || []).concat([{ q: 20, r: -20, type: 'building' }]);
  res = prepareLibrarySpec(decor);
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.code === 'E_READONLY' || i.code === 'E_DECOR'));
});

test('C1: broken and unknown TrackSpecs are rejected with issue codes', () => {
  const unknown = sample('snake', 1);
  unknown.nodes.find((n) => n.id === 4).type = 'portal';
  let res = prepareLibrarySpec(unknown);
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.code === 'E_TYPE'), JSON.stringify(res.issues));

  res = prepareLibrarySpec({ schemaVersion: 1, layout: 'polar', levels: 1, hexSize: 34, nodes: [] });
  assert.equal(res.ok, false);

  res = prepareLibrarySpec(null);
  assert.equal(res.ok, false);
  assert.ok(res.issues.length > 0);
});

test('C1: cleanName strips markup and trims', () => {
  assert.equal(cleanName('  <b>Моя</b> трасса  '), 'Моя трасса');
  assert.equal(cleanName('<script>x</script>'), 'x');
});
