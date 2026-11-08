import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.join(here, '..', 'js');
for (const f of ['data.js', 'track-gen.js', 'track-editor.js', 'track-editor-ui.js']) require(path.join(js, f));
const UI = globalThis.CnA.TrackEditorUI;

test('C3: parseSharedToken accepts only opaque track tokens', () => {
  const token = 'a'.repeat(43);
  assert.equal(UI.parseSharedToken('?track=' + token), token);
  assert.equal(UI.parseSharedToken('?foo=1&track=' + token), token);
  assert.equal(UI.parseSharedToken('?track=short'), null);
  assert.equal(UI.parseSharedToken('?track='), null);
  assert.equal(UI.parseSharedToken('?track=' + 'a'.repeat(129)), null);
  assert.equal(UI.parseSharedToken(''), null);
});

test('C3: serverTrackMap key is account-scoped with legacy fallback key', () => {
  assert.equal(UI.serverMapKey('acc-1'), 'cna.serverTrackMap.v1.acc-1');
  assert.equal(UI.serverMapKey('acc-1') !== UI.serverMapKey('acc-2'), true);
  assert.equal(UI.serverMapKey(null), 'cna.serverTrackMap.v1');
});

test('C3: shared-route action gates', () => {
  assert.deepEqual(UI.sharedActionAllowed('export', { sharedPreview: false }), { allowed: true, reason: null });
  assert.deepEqual(UI.sharedActionAllowed('local-save', { sharedPreview: false }), { allowed: true, reason: null });
  assert.deepEqual(UI.sharedActionAllowed('local-save', { sharedPreview: true }), { allowed: false, reason: 'shared' });
  assert.deepEqual(UI.sharedActionAllowed('local-copy', { sharedPreview: true }), { allowed: false, reason: 'shared' });
  assert.deepEqual(UI.sharedActionAllowed('export', { sharedPreview: true }), { allowed: true, reason: null });
  assert.deepEqual(UI.sharedActionAllowed('test', { sharedPreview: true }), { allowed: false, reason: 'login' });
  assert.deepEqual(UI.sharedActionAllowed('import', { sharedPreview: true }), { allowed: false, reason: 'login' });
  assert.deepEqual(UI.sharedActionAllowed('test', { sharedPreview: true, accountId: 'acc-1' }), { allowed: true, reason: null });
  assert.deepEqual(UI.sharedActionAllowed('import', { sharedPreview: true, accountId: 'acc-1' }), { allowed: true, reason: null });
});
