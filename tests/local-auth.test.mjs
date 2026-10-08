import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAuth, LOCAL_COOKIE_NAME} from '../dev/local-auth.mjs';

const JOIN_CODE = '00213456';
const header = token => `${LOCAL_COOKIE_NAME}=${token}`;
function fixture(options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const auth = createLocalAuth(sqlite, {joinCode: JOIN_CODE, secure: true, ...options});
  const enter = (name = 'Player One', peer = 'phone-one') => auth.join({code: JOIN_CODE, name}, peer);
  return {sqlite, auth, enter};
}

test('phones receive independent opaque identities and only hashed tokens are stored', t => {
  const {sqlite, auth, enter} = fixture();
  t.after(() => sqlite.close());
  const one = enter('First phone');
  const two = enter('Second phone', 'phone-two');
  assert.notEqual(one.token, two.token);
  assert.notEqual(one.userId, two.userId);
  assert.match(one.userId, /^local-phone-[a-f0-9-]{36}$/);
  assert.deepEqual(auth.authenticate(`other=cookie; ${header(one.token)}`), {userId: one.userId, name: 'First phone'});
  assert.deepEqual(auth.authenticate(header(two.token)), {userId: two.userId, name: 'Second phone'});
  const rows = sqlite.prepare('SELECT * FROM _local_phone_sessions').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].token_hash, createHash('sha256').update(one.token).digest('hex'));
  assert.equal(JSON.stringify(rows).includes(one.token), false);
  assert.equal(JSON.stringify(rows).includes(two.token), false);
  assert.deepEqual(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['_local_phone_sessions']);
  assert.equal(auth.authenticate(header('x'.repeat(43))), null);
  assert.equal(auth.authenticate(`${header(one.token)}; ${header(two.token)}`), null);
  assert.equal(auth.authenticate('rep_arena_local=bad'), null);
});

test('sessions survive closing and reopening the local database with a new launch code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rep-arena-local-auth-'));
  const path = join(directory, 'sessions.sqlite');
  let sqlite;
  try {
    sqlite = new DatabaseSync(path);
    const first = createLocalAuth(sqlite, {joinCode: JOIN_CODE});
    const player = first.join({code: JOIN_CODE, name: 'Persisted phone'}, 'phone-one');
    sqlite.close();
    sqlite = new DatabaseSync(path);
    const restarted = createLocalAuth(sqlite, {joinCode: '98765432'});
    assert.deepEqual(restarted.authenticate(header(player.token)), {userId: player.userId, name: player.name});
    assert.throws(() => restarted.join({code: JOIN_CODE, name: 'New phone'}, 'phone-two'), {status: 401});
    const next = restarted.join({code: '98765432', name: 'New phone'}, 'phone-two');
    assert.notEqual(next.userId, player.userId);
  } finally {
    if (sqlite?.isOpen) sqlite.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('session cookies are HttpOnly, same-origin and Secure for HTTPS only', t => {
  const {sqlite, auth, enter} = fixture();
  t.after(() => sqlite.close());
  const {token} = enter();
  assert.equal(auth.cookie(token), `${header(token)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(auth.clearCookie(), `${LOCAL_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
  const http = createLocalAuth(sqlite, {joinCode: JOIN_CODE, secure: false});
  assert.equal(http.cookie(token).includes('Secure'), false);
  assert.equal(http.clearCookie().includes('Secure'), false);
  assert.throws(() => auth.cookie('bad\r\nInjected: yes'), TypeError);
});

test('incorrect join codes are throttled per peer for five minutes', t => {
  let now = 1000;
  const {sqlite, auth, enter} = fixture({clock: () => now});
  t.after(() => sqlite.close());
  for (let i = 0; i < 5; i++) {
    assert.throws(() => auth.join({code: '00000000', name: 'Bad code'}, 'phone-one'), {status: 401, code: 'INVALID_JOIN_CODE'});
  }
  assert.throws(() => enter(), {status: 429, code: 'JOIN_THROTTLED', retryAfter: 300});
  assert.ok(enter('Other phone', 'phone-two').token);
  now += 300000;
  assert.ok(enter().token);
});

test('successful joins clear mistakes, and malformed join values never create sessions', t => {
  const {sqlite, auth, enter} = fixture();
  t.after(() => sqlite.close());
  for (const data of [null, {}, {code: 213456}, {code: JOIN_CODE + ' '}]) {
    assert.throws(() => auth.join(data, 'mistyped-code'), {status: 401});
  }
  for (const name of ['', 'a', 'a'.repeat(31), 'Bad\nname', {}, null]) {
    assert.throws(() => auth.join({code: JOIN_CODE, name}, 'phone-one'), {status: 400, code: 'INVALID_NAME'});
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _local_phone_sessions').get().n, 0);
  assert.equal(enter('  Valid player  ', 'mistyped-code').name, 'Valid player');
  for (let i = 0; i < 5; i++) assert.throws(() => auth.join({code: '99999999', name: 'Player'}, 'mistyped-code'), {status: 401});
});

test('expiry and revocation invalidate only the affected phone and free capacity', t => {
  let now = 1000;
  const {sqlite, auth, enter} = fixture({clock: () => now, maxSessions: 2});
  t.after(() => sqlite.close());
  const first = enter();
  now += 100;
  const second = enter('Second phone', 'phone-two');
  assert.throws(() => enter('Third phone', 'phone-three'), {status: 429, code: 'SESSION_LIMIT'});
  now = 1000 + 30 * 86400000;
  assert.equal(auth.authenticate(header(first.token)), null);
  assert.ok(auth.authenticate(header(second.token)));
  const third = enter('Third phone', 'phone-three');
  auth.revoke(header(second.token));
  auth.revoke(header(second.token));
  assert.equal(auth.authenticate(header(second.token)), null);
  assert.ok(auth.authenticate(header(third.token)));
  assert.ok(enter('Fourth phone', 'phone-four').token);
});

test('local auth never permits more than 100 active device sessions', t => {
  const {sqlite, auth, enter} = fixture();
  t.after(() => sqlite.close());
  for (let i = 0; i < 100; i++) enter(`Phone ${i}`, `phone-${i}`);
  assert.throws(() => enter('Overflow phone'), {status: 429, code: 'SESSION_LIMIT'});
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _local_phone_sessions').get().n, 100);
  assert.throws(() => createLocalAuth(sqlite, {maxSessions: 101}), TypeError);
  assert.throws(() => createLocalAuth(sqlite, {joinCode: 'short'}), TypeError);
  assert.match(auth.joinCode, /^\d{8}$/);
});

test('throttle bookkeeping is bounded without evicting still-blocked peers', t => {
  let now = 1000;
  const {sqlite, auth} = fixture({clock: () => now});
  t.after(() => sqlite.close());
  for (let i = 0; i < 1000; i++) {
    assert.throws(() => auth.join({code: '99999999', name: 'Phone'}, `peer-${i}`), {status: 401});
  }
  assert.throws(() => auth.join({code: '99999999', name: 'Phone'}, 'overflow-peer'), {status: 429});
  now += 300000;
  assert.throws(() => auth.join({code: '99999999', name: 'Phone'}, 'overflow-peer'), {status: 401});
});
