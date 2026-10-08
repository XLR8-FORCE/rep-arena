import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLocalArena} from '../dev/local-server.mjs';
import {LiveSession} from '../dist/live-session.js';

const JOIN_CODE = '12345678';
const events = count => Array.from({length: count}, (_, index) => ({t: (index + 1) * 1500, low: 85, high: 170, duration: 950}));

async function fixture(t, options = {}) {
  const arena = await createLocalArena({port: 0, dbPath: ':memory:', joinCode: JOIN_CODE, ...options});
  t.after(async () => {
    await arena.close();
    assert.equal(arena.server.listening, false, 'test server must stop listening');
    assert.equal(arena.sqlite.isOpen, false, 'test database must close');
  });
  return arena;
}

function request(arena, path, {method = 'GET', body, headers = {}} = {}) {
  const url = new URL(path, arena.origin);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      agent: false,
      headers: {
        ...(payload === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({status: res.statusCode, headers: res.headers, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function browser(arena, origin = arena.origin) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(path, body, extraHeaders = {}) {
      const result = await request(arena, path, {
        method: body === undefined ? 'GET' : 'POST',
        body,
        headers: {host: new URL(origin).host, ...(body === undefined ? {} : {origin}), ...(cookie ? {cookie} : {}), ...extraHeaders},
      });
      for (const value of result.headers['set-cookie'] || []) {
        if (value.startsWith('rep_arena_local=')) cookie = value.split(';', 1)[0];
      }
      return result;
    },
  };
}

test('two phone clients share countdown, live scores and final results over authenticated HTTP', async t => {
  let now=1800000000000;
  t.mock.method(Date,'now',()=>now);
  const arena=await fixture(t),a=browser(arena),b=browser(arena);
  await a.call('/local/join',{code:JOIN_CODE,name:'Live Phone A'});
  await b.call('/local/join',{code:JOIN_CODE,name:'Live Phone B'});
  const makeClient=(phone,max)=>{
    const c=new LiveSession({
      request:async(path,body)=>{const r=await phone.call('/api/'+path,body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;},
      onState:()=>{},onError:()=>{},
      evidence:()=>events(Math.min(max,Math.max(0,Math.floor((now-c.room.startsAt)/1500)))),
    });
    c.schedule=()=>{};t.after(()=>c.stop());return c;
  };
  const ca=makeClient(a,8),cb=makeClient(b,5);
  ca.open((await a.call('/api/live/queue',{exercise:'pushup'})).data.room);
  cb.open((await b.call('/api/live/queue',{exercise:'pushup'})).data.room);
  assert.equal(ca.room.id,cb.room.id);
  await ca.sync({ready:true});await cb.sync({ready:true});await ca.sync();
  assert.equal(ca.room.startsAt,cb.room.startsAt);
  assert.equal(ca.room.phase,'countdown');
  for(let i=0;i<65;i++){now+=1000;await ca.sync();await cb.sync();}
  assert.equal(ca.room.opponentReps,5);assert.equal(cb.room.opponentReps,8);
  await ca.sync({finished:true});await cb.sync({finished:true});await ca.sync();
  assert.equal(ca.room.result.outcome,'win');assert.equal(cb.room.result.outcome,'loss');
  const state=(await a.call('/api/state')).data;
  assert.equal(state.ladders.find(l=>l.exercise==='pushup').rating,612);
  assert.equal(state.ladders.find(l=>l.exercise==='squat').rating,600);
});

test('two phone cookie jars compete in one arena with private scores and separate exercise ratings', async t => {
  const arena = await fixture(t);
  const alice = browser(arena), bob = browser(arena);
  assert.equal((await alice.call('/local/join', {code: JOIN_CODE, name: 'Alice Phone'})).status, 200);
  assert.equal((await bob.call('/local/join', {code: JOIN_CODE, name: 'Bob Phone'})).status, 200);
  assert.notEqual(alice.cookie, bob.cookie);
  const initialAlice = (await alice.call('/api/state')).data;
  const initialBob = (await bob.call('/api/state')).data;
  assert.equal(initialAlice.me.name, 'Alice Phone');
  assert.equal(initialBob.me.name, 'Bob Phone');
  assert.notEqual(initialAlice.me.handle, initialBob.me.handle);

  const [firstQueue, secondQueue] = await Promise.all([
    alice.call('/api/matches/queue', {exercise: 'pushup'}),
    bob.call('/api/matches/queue', {exercise: 'pushup'}),
  ]);
  assert.equal(firstQueue.status, 200);
  assert.equal(secondQueue.status, 200);
  assert.equal(firstQueue.data.id, secondQueue.data.id);
  const match = firstQueue.data.id;
  const aSession = await alice.call('/api/sessions/start', {exercise: 'pushup', match});
  const bSession = await bob.call('/api/sessions/start', {exercise: 'pushup', match});
  assert.equal(aSession.status, 200);
  assert.equal(bSession.status, 200);
  // Advance only the isolated test database; real phones must complete the clock.
  arena.sqlite.prepare('UPDATE sessions SET started=? WHERE id IN (?,?)').run(Date.now() - 60010, aSession.data.id, bSession.data.id);
  assert.equal((await alice.call('/api/sessions/finish', {id: aSession.data.id, events: events(8)})).status, 200);
  const hidden = (await bob.call('/api/state')).data.matches.find(item => item.id === match);
  assert.equal(hidden.status, 'active');
  assert.equal(hidden.opponentSubmitted, true);
  assert.equal(hidden.opponentScore, null);
  assert.equal((await bob.call('/api/sessions/finish', {id: bSession.data.id, events: events(5)})).status, 200);

  const finalAlice = (await alice.call('/api/state')).data;
  const finalBob = (await bob.call('/api/state')).data;
  assert.equal(finalAlice.matches[0].status, 'complete');
  assert.equal(finalAlice.matches[0].ownScore, 8);
  assert.equal(finalAlice.matches[0].opponentScore, 5);
  assert.equal(finalAlice.matches[0].delta, 12);
  assert.equal(finalBob.matches[0].delta, -12);
  assert.equal(finalAlice.ladders.find(item => item.exercise === 'pushup').rating, 612);
  assert.equal(finalBob.ladders.find(item => item.exercise === 'pushup').rating, 588);
  assert.equal(finalAlice.ladders.find(item => item.exercise === 'pushup').wins, 1);
  assert.equal(finalBob.ladders.find(item => item.exercise === 'pushup').losses, 1);
  assert.equal(finalAlice.ladders.find(item => item.exercise === 'squat').rating, 600);
  assert.equal(finalBob.ladders.find(item => item.exercise === 'squat').rating, 600);
  assert.equal(arena.sqlite.prepare('SELECT COUNT(*) n FROM slots').get().n, 0);
});

test('local APIs require a cookie and ignore forged hosted identity headers', async t => {
  const arena = await fixture(t);
  assert.equal((await request(arena, '/api/state')).status, 401);
  assert.equal((await request(arena, '/api/state', {headers: {'oai-authenticated-user-id': 'forged-player', 'oai-authenticated-user-email': 'forged@example.test'}})).status, 401);
  assert.equal(arena.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  const alice = browser(arena), bob = browser(arena);
  await alice.call('/local/join', {code: JOIN_CODE, name: 'Alice Phone'});
  await bob.call('/local/join', {code: JOIN_CODE, name: 'Bob Phone'});
  const bobId = arena.sqlite.prepare('SELECT id FROM users WHERE name=?').get('Bob Phone').id;
  const spoofed = await alice.call('/api/state', undefined, {'oai-authenticated-user-id': bobId});
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.data.me.name, 'Alice Phone');
  assert.equal((await request(arena, '/local/health', {headers: {host: 'untrusted.example'}})).status, 421);
});

test('cross-origin joins and API writes are rejected before changing state', async t => {
  const arena = await fixture(t);
  assert.equal((await request(arena, '/local/join', {method: 'POST', body: {code: JOIN_CODE, name: 'Cross site'}, headers: {origin: 'https://other.example'}})).status, 403);
  assert.equal((await request(arena, '/local/join', {method: 'POST', body: {code: JOIN_CODE, name: 'Cross site'}, headers: {'sec-fetch-site': 'cross-site'}})).status, 403);
  assert.equal(arena.sqlite.prepare('SELECT COUNT(*) n FROM _local_phone_sessions').get().n, 0);
  const alice = browser(arena);
  await alice.call('/local/join', {code: JOIN_CODE, name: 'Alice Phone'});
  const initial = (await alice.call('/api/state')).data;
  assert.equal((await alice.call('/api/profile', {name: 'Changed name', handle: initial.me.handle}, {origin: 'https://other.example'})).status, 403);
  assert.equal((await alice.call('/api/matches/queue', {exercise: 'squat'}, {'sec-fetch-site': 'cross-site'})).status, 403);
  assert.equal((await alice.call('/api/state')).data.me.name, 'Alice Phone');
  assert.equal(arena.sqlite.prepare('SELECT COUNT(*) n FROM matches').get().n, 0);
});

test('joining again with an existing cookie preserves the same identity and signout revokes it', async t => {
  const arena = await fixture(t);
  const phone = browser(arena);
  await phone.call('/local/join', {code: JOIN_CODE, name: 'Original phone'});
  const firstCookie = phone.cookie;
  const firstState = (await phone.call('/api/state')).data;
  const again = await phone.call('/local/join', {code: 'wrong', name: 'Accidental duplicate'});
  assert.equal(again.status, 200);
  assert.equal(again.data.name, 'Original phone');
  assert.equal(phone.cookie, firstCookie);
  assert.equal((await phone.call('/api/state')).data.me.handle, firstState.me.handle);
  assert.equal(arena.sqlite.prepare('SELECT COUNT(*) n FROM _local_phone_sessions').get().n, 1);
  assert.equal(arena.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  const leave = await phone.call('/local/leave', {});
  assert.equal(leave.status, 200);
  assert.match(leave.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await request(arena, '/api/state', {headers: {cookie: firstCookie}})).status, 401);
});

test('configured HTTPS origins receive secure cookies through the loopback HTTP proxy', async t => {
  const publicOrigin = 'https://arena-testing.example';
  const arena = await fixture(t, {publicOrigin});
  const phone = browser(arena, publicOrigin);
  const joined = await phone.call('/local/join', {code: JOIN_CODE, name: 'HTTPS phone'});
  assert.equal(joined.status, 200);
  const secureCookie = joined.headers['set-cookie'][0];
  assert.match(secureCookie, /; HttpOnly(?:;|$)/);
  assert.match(secureCookie, /; SameSite=Lax(?:;|$)/);
  assert.match(secureCookie, /; Secure(?:;|$)/);
  assert.match(secureCookie, /; Path=\/(?:;|$)/);
  assert.equal((await phone.call('/api/state')).data.me.name, 'HTTPS phone');
  assert.equal((await phone.call('/api/matches/queue', {exercise: 'pushup'}, {origin: arena.origin})).status, 403);
  const leave = await phone.call('/local/leave', {});
  assert.match(leave.headers['set-cookie'][0], /; Secure(?:;|$)/);
  assert.equal((await phone.call('/api/state')).status, 401);

  const local = browser(arena);
  const localJoin = await local.call('/local/join', {code: JOIN_CODE, name: 'PC browser'});
  assert.equal(localJoin.status, 200);
  assert.equal(localJoin.headers['set-cookie'][0].includes('; Secure'), false);
});
