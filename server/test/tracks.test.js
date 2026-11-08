import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prepareLibrarySpec } from '../src/track-spec.js';
import { sha256Hex, uuidv7 } from '../src/util.js';

/* --- client-side generator only for test fixtures --- */
const clientDir = new URL('../../chrome-and-ash-web/js/', import.meta.url);
(0, eval)(readFileSync(new URL('data.js', clientDir), 'utf8'));
(0, eval)(readFileSync(new URL('track-gen.js', clientDir), 'utf8'));
const CnA = globalThis.CnA;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sampleSpec(archetype = 'snake', seed = 7) {
  return CnA.generateTrackSpec(seed, {
    archetype,
    size: CnA.TRACK_ARCHETYPES[archetype].defaultSize,
  });
}
function canonical(spec) {
  const r = prepareLibrarySpec(spec);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  return r.spec;
}
function cookieHeader(token) { return { cookie: 'cna_session=' + token }; }
function jsonHeaders(token) {
  return Object.assign({ 'content-type': 'application/json' }, cookieHeader(token));
}

async function setup(t) {
  const db = openDb(':memory:');
  const app = createApp({ db, config });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => db.close());
  return { db, base };
}
function tokenFrom(res) {
  const m = /cna_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
  return m ? m[1] : null;
}
async function register(base, name) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'password123' }),
  });
  assert.equal(res.status, 201, await res.text());
  return tokenFrom(res);
}
async function createTrack(base, token, name, spec) {
  return fetch(base + '/api/tracks', {
    method: 'POST', headers: jsonHeaders(token),
    body: JSON.stringify({ name, spec }),
  });
}
async function listTracks(base, token, query) {
  return fetch(base + '/api/tracks' + (query || ''), { headers: cookieHeader(token) });
}

test('C2: tracks require auth and list only own metadata', async (t) => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/api/tracks')).status, 401);
  const a = await register(base, 'tracks_a1');
  const b = await register(base, 'tracks_b1');
  const spec = canonical(sampleSpec('snake', 1));
  const created = await createTrack(base, a, 'A track', spec);
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const body = JSON.parse(createdText);
  assert.match(body.track.id, UUID_RE);
  assert.equal(body.track.revision, 0);
  assert.equal(body.track.name, 'A track');
  assert.equal((await listTracks(base, b)).status, 200);
  const bList = await (await listTracks(base, b)).json();
  assert.deepEqual(bList.tracks, []);
  const aList = await (await listTracks(base, a)).json();
  assert.equal(aList.tracks.length, 1);
  assert.equal(aList.tracks[0].id, body.track.id);
  assert.equal(aList.tracks[0].share.active, false);
  assert.equal(aList.tracks[0].spec, undefined);
  const got = await fetch(base + '/api/tracks/' + body.track.id, { headers: cookieHeader(a) });
  assert.equal(got.status, 200);
  const gotBody = await got.json();
  assert.equal(JSON.stringify(gotBody.track.spec), JSON.stringify(spec));
});

test('C2: GET/PUT/DELETE are IDOR-safe and malformed ids are 404', async (t) => {
  const { base } = await setup(t);
  const a = await register(base, 'tracks_a2');
  const b = await register(base, 'tracks_b2');
  const created = await (await createTrack(base, a, 'A', canonical(sampleSpec('club', 2)))).json();
  const id = created.track.id;
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(base + '/api/tracks/' + id, { method, headers: cookieHeader(b) });
    assert.equal(res.status, 404, method);
  }
  const putForeign = await fetch(base + '/api/tracks/' + id, {
    method: 'PUT', headers: jsonHeaders(b),
    body: JSON.stringify({ revision: 0, name: 'B', spec: canonical(sampleSpec('club', 2)) }),
  });
  assert.equal(putForeign.status, 404);
  assert.equal((await fetch(base + '/api/tracks/not-a-uuid', { headers: cookieHeader(a) })).status, 404);
  assert.equal((await fetch(base + '/api/tracks/' + uuidv7(), { headers: cookieHeader(a) })).status, 404);
});

test('C2: PUT uses revision and rejects stale updates', async (t) => {
  const { base } = await setup(t);
  const a = await register(base, 'tracks_a3');
  const created = await (await createTrack(base, a, 'Rev', canonical(sampleSpec('snake', 3)))).json();
  const id = created.track.id;
  const spec2 = canonical(sampleSpec('snake', 4));
  const put = await fetch(base + '/api/tracks/' + id, {
    method: 'PUT', headers: jsonHeaders(a),
    body: JSON.stringify({ revision: 0, name: 'Rev2', spec: spec2 }),
  });
  const putText = await put.text();
  assert.equal(put.status, 200, putText);
  const updated = JSON.parse(putText);
  assert.equal(updated.track.revision, 1);
  assert.equal(updated.track.name, 'Rev2');
  const stale = await fetch(base + '/api/tracks/' + id, {
    method: 'PUT', headers: jsonHeaders(a),
    body: JSON.stringify({ revision: 0, name: 'Stale', spec: spec2 }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'stale_revision');
  const missingRev = await fetch(base + '/api/tracks/' + id, {
    method: 'PUT', headers: jsonHeaders(a),
    body: JSON.stringify({ name: 'No rev', spec: spec2 }),
  });
  assert.equal(missingRev.status, 400);
});

test('C2: concurrent PUTs on the same revision yield exactly one winner', async (t) => {
  const { base } = await setup(t);
  const a = await register(base, 'tracks_a3b');
  const created = await (await createTrack(base, a, 'Race', canonical(sampleSpec('snake', 12)))).json();
  const id = created.track.id;
  const specA = canonical(sampleSpec('snake', 13));
  const specB = canonical(sampleSpec('snake', 14));
  const put = (name, spec) => fetch(base + '/api/tracks/' + id, {
    method: 'PUT', headers: jsonHeaders(a),
    body: JSON.stringify({ revision: 0, name, spec }),
  });
  const [r1, r2] = await Promise.all([put('One', specA), put('Two', specB)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const final = await (await fetch(base + '/api/tracks/' + id, { headers: cookieHeader(a) })).json();
  assert.equal(final.track.revision, 1);
});

test('C2: quota of 40 is transactional', async (t) => {
  const { db, base } = await setup(t);
  const a = await register(base, 'tracks_a4');
  const spec = canonical(sampleSpec('club', 5));
  const account = db.prepare("SELECT id FROM accounts WHERE username='tracks_a4'").get().id;
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO tracks (id, account_id, name, spec_json, spec_schema, revision, created_at, updated_at) VALUES (?,?,?,?,1,0,?,?)');
  for (let i = 0; i < 39; i++) insert.run(uuidv7(), account, 'seed ' + i, JSON.stringify(spec), now, now);
  const [r1, r2] = await Promise.all([
    createTrack(base, a, 'q40', spec),
    createTrack(base, a, 'q41', spec),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 422]);
  const fail = await (r1.status === 422 ? r1 : r2).json();
  assert.equal(fail.error.code, 'quota_exceeded');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tracks WHERE account_id=?').get(account).c, 40);
});

test('C2: cursor pagination is ordered by (updated_at,id) and handles equal timestamps', async (t) => {
  const { db, base } = await setup(t);
  const a = await register(base, 'tracks_a5');
  const spec = canonical(sampleSpec('club', 6));
  const account = db.prepare("SELECT id FROM accounts WHERE username='tracks_a5'").get().id;
  const same = '2026-02-03T04:05:06.000Z';
  const ids = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003'];
  const insert = db.prepare('INSERT INTO tracks (id, account_id, name, spec_json, spec_schema, revision, created_at, updated_at) VALUES (?,?,?,?,1,0,?,?)');
  ids.forEach((id, i) => insert.run(id, account, 'p' + i, JSON.stringify(spec), same, same));
  const first = await (await listTracks(base, a, '?limit=2')).json();
  assert.equal(first.tracks.length, 2);
  assert.deepEqual(first.tracks.map((x) => x.id), [ids[2], ids[1]]);
  assert.ok(first.nextCursor);
  const second = await (await listTracks(base, a, '?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json();
  assert.deepEqual(second.tracks.map((x) => x.id), [ids[0]]);
  assert.equal(second.nextCursor, null);
});

test('C2: invalid names/specs and oversized specs are rejected', async (t) => {
  const { base } = await setup(t);
  const a = await register(base, 'tracks_a6');
  const spec = canonical(sampleSpec('snake', 8));
  assert.equal((await createTrack(base, a, '', spec)).status, 422);
  assert.equal((await createTrack(base, a, 'x'.repeat(41), spec)).status, 422);
  const xss = await createTrack(base, a, '<b>XSS</b>', spec);
  assert.equal(xss.status, 201);
  assert.equal((await xss.json()).track.name, 'XSS');
  const bad = JSON.parse(JSON.stringify(spec));
  bad.nodes[3].type = 'portal';
  const badRes = await createTrack(base, a, 'Bad', bad);
  assert.equal(badRes.status, 422);
  assert.equal((await badRes.json()).error.code, 'invalid_track');
  const oversized = Object.assign({}, spec, { pad: 'x'.repeat(110 * 1024) });
  const bigRes = await createTrack(base, a, 'Big', oversized);
  assert.equal(bigRes.status, 413);
  assert.equal((await bigRes.json()).error.code, 'payload_too_large');
});

test('C2: share lifecycle is single-link, hashed, rotating and revokable', async (t) => {
  const { db, base } = await setup(t);
  const a = await register(base, 'tracks_a7');
  const b = await register(base, 'tracks_b7');
  const created = await (await createTrack(base, a, 'Share', canonical(sampleSpec('snake', 9)))).json();
  const id = created.track.id;
  const status0 = await (await fetch(base + '/api/tracks/' + id + '/share', { headers: cookieHeader(a) })).json();
  assert.deepEqual(status0.share, { active: false, createdAt: null, updatedAt: null });
  assert.equal((await fetch(base + '/api/tracks/' + id + '/share', { headers: cookieHeader(b) })).status, 404);
  assert.equal((await fetch(base + '/api/tracks/' + id + '/share', { method: 'POST', headers: cookieHeader(b) })).status, 404);

  const first = await fetch(base + '/api/tracks/' + id + '/share', { method: 'POST', headers: cookieHeader(a) });
  assert.equal(first.status, 201);
  const token = (await first.json()).share.token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT * FROM track_shares WHERE track_id=?').get(id);
  assert.equal(row.token_hash, sha256Hex(token));
  assert.notEqual(row.token_hash, token);
  const status1 = await (await fetch(base + '/api/tracks/' + id + '/share', { headers: cookieHeader(a) })).json();
  assert.equal(status1.share.active, true);
  assert.ok(status1.share.createdAt);
  assert.equal(JSON.stringify(status1).includes(token), false);

  const shell = await fetch(base + '/?track=' + token);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.equal(shell.headers.get('x-robots-tag'), 'noindex');
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
  const pub = await fetch(base + '/api/share/' + token);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('cache-control'), 'no-store');
  assert.equal(pub.headers.get('x-robots-tag'), 'noindex');
  assert.equal(pub.headers.get('referrer-policy'), 'no-referrer');
  const pubBody = await pub.json();
  assert.equal(pubBody.track.name, 'Share');
  assert.deepEqual(pubBody.track.spec, created.track.spec);
  assert.equal(pubBody.track.author.displayName, 'tracks_a7');
  const pii = JSON.stringify(pubBody);
  assert.equal(pii.includes('account'), false);
  assert.equal(pii.includes('email'), false);
  assert.equal(pii.includes('token_hash'), false);

  const rotate = await fetch(base + '/api/tracks/' + id + '/share', { method: 'POST', headers: cookieHeader(a) });
  assert.equal(rotate.status, 200);
  const token2 = (await rotate.json()).share.token;
  assert.notEqual(token2, token);
  assert.equal((await fetch(base + '/api/share/' + token)).status, 404);
  assert.equal((await fetch(base + '/api/share/' + token2)).status, 200);

  assert.equal((await fetch(base + '/api/tracks/' + id + '/share', { method: 'DELETE', headers: cookieHeader(a) })).status, 204);
  assert.equal((await fetch(base + '/api/share/' + token2)).status, 404);
  assert.equal((await fetch(base + '/api/tracks/' + id + '/share', { method: 'DELETE', headers: cookieHeader(a) })).status, 204);
  const status2 = await (await fetch(base + '/api/tracks/' + id + '/share', { headers: cookieHeader(a) })).json();
  assert.deepEqual(status2.share, { active: false, createdAt: null, updatedAt: null });
});

test('C2: deleting a track cascades its share', async (t) => {
  const { db, base } = await setup(t);
  const a = await register(base, 'tracks_a8');
  const created = await (await createTrack(base, a, 'Cascade', canonical(sampleSpec('club', 10)))).json();
  const id = created.track.id;
  const token = (await (await fetch(base + '/api/tracks/' + id + '/share', { method: 'POST', headers: cookieHeader(a) })).json()).share.token;
  assert.equal((await fetch(base + '/api/tracks/' + id, { method: 'DELETE', headers: cookieHeader(a) })).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM track_shares WHERE track_id=?').get(id).c, 0);
  assert.equal((await fetch(base + '/api/share/' + token)).status, 404);
});

test('C2: public share rejects invalid tokens and throttles failures', async (t) => {
  const { base } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(base + '/api/share/bad-token-same')).status, 404);
  assert.equal((await fetch(base + '/api/share/bad-token-same')).status, 429);
});

test('C2: public read is no-auth and total per-IP limited', async (t) => {
  const { base } = await setup(t);
  const a = await register(base, 'tracks_a9');
  const created = await (await createTrack(base, a, 'Public', canonical(sampleSpec('snake', 11)))).json();
  const token = (await (await fetch(base + '/api/tracks/' + created.track.id + '/share', { method: 'POST', headers: cookieHeader(a) })).json()).share.token;
  for (let i = 0; i < 60; i++) assert.equal((await fetch(base + '/api/share/' + token)).status, 200, 'request ' + i);
  assert.equal((await fetch(base + '/api/share/' + token)).status, 429);
});

test('C2: authenticated library is rate limited per account', async (t) => {
  const { base } = await setup(t);
  const a = await register(base, 'tracks_a10');
  for (let i = 0; i < 30; i++) assert.equal((await listTracks(base, a)).status, 200, 'request ' + i);
  assert.equal((await listTracks(base, a)).status, 429);
});
