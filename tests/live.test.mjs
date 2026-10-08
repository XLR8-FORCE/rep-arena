import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../dev/database.mjs';
import {handleAPI} from '../src/api.js';

const events=n=>Array.from({length:n},(_,i)=>({t:1500*(i+1),low:85,high:170,duration:900}));
async function fixture(t){
 const clock={now:1800000000000};t.mock.method(Date,'now',()=>clock.now);
 const {DB,sqlite}=await database();t.after(()=>sqlite.close());
 const call=async(user,path,body)=>{const response=await handleAPI(new Request('https://arena.test/api/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','oai-authenticated-user-id':user},body:body?JSON.stringify(body):undefined}),{DB});return {status:response.status,data:await response.json()};};
 for(const user of ['alice','bob','charlie'])await call(user,'state');
 const sync=(user,id,more={})=>call(user,'live/sync',{id,...more});
 const room=async(exercise='pushup')=>{const a=await call('alice','live/queue',{exercise});assert.equal(a.status,200,JSON.stringify(a));const b=await call('bob','live/queue',{exercise});assert.equal(b.status,200,JSON.stringify(b));assert.equal(a.data.room.id,b.data.room.id);return a.data.room.id;};
 const start=async(id)=>{await sync('alice',id,{ready:true});const b=await sync('bob',id,{ready:true});assert.equal(b.status,200,JSON.stringify(b));assert.equal(b.data.room.phase,'countdown');clock.now=b.data.room.startsAt;await sync('alice',id);await sync('bob',id);return b.data.room;};
 const advance=async(id,ms)=>{const end=clock.now+ms;while(clock.now<end){clock.now=Math.min(end,clock.now+5000);await sync('alice',id);await sync('bob',id);}};
 return {clock,DB,sqlite,call,sync,room,start,advance};
}

test('two concurrent queue requests pair into the same live room',async t=>{
 const f=await fixture(t);
 const [a,b]=await Promise.all([f.call('alice','live/queue',{exercise:'pushup'}),f.call('bob','live/queue',{exercise:'pushup'})]);
 assert.equal(a.status,200,JSON.stringify(a));assert.equal(b.status,200,JSON.stringify(b));
 const aState=(await f.call('alice','state')).data.liveRooms.find(r=>r.phase==='preparing');
 const bState=(await f.call('bob','state')).data.liveRooms.find(r=>r.phase==='preparing');
 assert.equal(aState.id,bState.id);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM slots').get().n,2);
});

test('both players ready before one authoritative countdown and exactly one attempt',async t=>{
 const f=await fixture(t),id=await f.room();
 assert.equal((await f.sync('alice',id,{ready:true})).data.room.phase,'preparing');
 assert.equal((await f.call('charlie','live/sync',{id,ready:true})).status,404);
 const responses=await Promise.all([f.sync('alice',id,{ready:true}),f.sync('bob',id,{ready:true})]);
 assert.ok(responses.every(r=>r.status===200));
 const a=(await f.sync('alice',id)).data.room,b=(await f.sync('bob',id)).data.room;
 assert.equal(a.phase,'countdown');assert.equal(a.startsAt,b.startsAt);assert.equal(a.endsAt-a.startsAt,60000);assert.equal(a.startsAt-f.clock.now,5000);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sessions WHERE match=?').get(id).n,2);
 await f.sync('alice',id,{ready:false});assert.equal((await f.sync('alice',id)).data.room.startsAt,a.startsAt);
 assert.equal((await f.call('alice','sessions/start',{exercise:'pushup',match:id})).status,409);
 assert.equal((await f.call('alice','sessions/finish',{id:a.sessionId,events:[]})).status,409);
});

test('live scores are visible, monotonic, and bound to server elapsed time',async t=>{
 const f=await fixture(t),id=await f.room();await f.start(id);await f.advance(id,5000);
 assert.equal((await f.sync('alice',id,{events:events(2)})).data.room.ownReps,2);
 const bob=(await f.sync('bob',id)).data.room;assert.equal(bob.opponentReps,2);
 assert.equal((await f.sync('alice',id,{events:events(1)})).status,409);
 const changed=events(2);changed[0].low=90;assert.equal((await f.sync('alice',id,{events:changed})).status,409);
 assert.equal((await f.sync('alice',id,{events:events(10)})).status,400);
 assert.equal((await f.sync('alice',id,{finished:true})).status,400);
 assert.deepEqual((await f.sync('alice',id)).data.room.ownEvents,events(2));
});

test('motion evidence survives live persistence and cannot be altered on retries',async t=>{
 const f=await fixture(t),id=await f.room();await f.start(id);await f.advance(id,5000);
 const event={v:2,t:1500,duration:750,low:119,high:150,drop:.8,bend:35,topDrop:.06,range:.8};
 const accepted=await f.sync('alice',id,{events:[event]});assert.equal(accepted.status,200,JSON.stringify(accepted));
 assert.deepEqual(accepted.data.room.ownEvents,[event]);
 assert.equal((await f.sync('bob',id)).data.room.opponentReps,1);
 assert.equal((await f.sync('alice',id,{events:[{...event,drop:.9}]})).status,409);
 assert.equal((await f.sync('alice',id,{events:[event]})).status,200);
 await f.advance(id,55000);await f.sync('alice',id,{events:[event],finished:true});await f.sync('bob',id,{events:[],finished:true});
 const result=(await f.sync('alice',id)).data.room;assert.equal(result.phase,'complete');assert.equal(result.ownReps,1);
 assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT evidence FROM sessions WHERE id=?').get(result.sessionId).evidence),[event]);
});

test('shared round settles once after both finish, preserves separate ladder and grants real activity',async t=>{
 const f=await fixture(t),id=await f.room();f.sqlite.prepare("UPDATE ladders SET shields=1 WHERE user='bob' AND exercise='pushup'").run();await f.start(id);await f.advance(id,55000);
 await f.sync('alice',id,{events:events(8)});await f.sync('bob',id,{events:events(5)});await f.advance(id,5000);
 const results=await Promise.all([f.sync('alice',id,{events:events(8),finished:true}),f.sync('bob',id,{events:events(5),finished:true})]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
 const a=(await f.sync('alice',id)).data.room,b=(await f.sync('bob',id)).data.room;
 assert.equal(a.phase,'complete');assert.equal(a.result.outcome,'win');assert.equal(a.result.delta,12);assert.equal(b.result.outcome,'loss');assert.equal(b.result.delta,-6);assert.equal(b.result.saved,6);
 const state=(await f.call('alice','state')).data;assert.equal(state.ladders.find(l=>l.exercise==='pushup').rating,612);assert.equal(state.ladders.find(l=>l.exercise==='squat').rating,600);assert.equal(state.matches[0].isLive,true);assert.equal(state.stats.sessions,1);assert.equal(state.activity.length,1);
 await f.sync('alice',id,{events:events(12),finished:true});await f.sync('bob',id,{leave:true});
 assert.equal(f.sqlite.prepare("SELECT rating FROM ladders WHERE user='alice' AND exercise='pushup'").get().rating,612);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM slots').get().n,0);
});

test('leaving after start forfeits without spending shields or granting activity',async t=>{
 const f=await fixture(t),id=await f.room();f.sqlite.prepare("UPDATE ladders SET shields=1 WHERE exercise='pushup'").run();await f.start(id);await f.advance(id,10000);await f.sync('alice',id,{events:events(5)});
 const left=(await f.sync('alice',id,{leave:true})).data.room;assert.equal(left.result.outcome,'loss');assert.equal(left.result.delta,-12);assert.equal(left.result.saved,0);
 assert.equal((await f.sync('bob',id)).data.room.result.outcome,'win');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM activity').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT shields FROM ladders WHERE user='alice' AND exercise='pushup'").get().shields,1);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sessions WHERE status='complete'").get().n,0);
});

test('one disconnect forfeits; both disconnected void; reconnect before grace keeps one attempt',async t=>{
 const f=await fixture(t),id=await f.room();await f.start(id);
 f.clock.now+=6000;await f.sync('bob',id);f.clock.now+=3000;
 assert.equal((await f.sync('alice',id)).data.room.phase,'running');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sessions WHERE match=?').get(id).n,2);
 f.clock.now+=6000;await f.sync('bob',id);f.clock.now+=5000;
 assert.equal((await f.sync('bob',id)).data.room.result.outcome,'win');
 const squat=await f.room('squat');await f.start(squat);f.clock.now+=11000;
 const voided=(await f.sync('alice',squat)).data.room;assert.equal(voided.phase,'void');assert.equal(voided.result.delta,0);
 assert.equal(f.sqlite.prepare("SELECT rating FROM ladders WHERE user='alice' AND exercise='squat'").get().rating,600);
});

test('GET state does not keep an abandoned search alive and preparation cancellation does not change rank',async t=>{
 const f=await fixture(t);const q=(await f.call('alice','live/queue',{exercise:'pushup'})).data.room;
 f.clock.now+=10000;await f.call('alice','state');f.clock.now+=6000;
 assert.equal((await f.call('alice','state')).data.liveRooms.find(r=>r.id===q.id).phase,'cancelled');
 const id=await f.room();await f.sync('alice',id,{leave:true});assert.equal((await f.sync('bob',id)).data.room.phase,'cancelled');
 assert.equal(f.sqlite.prepare("SELECT rating FROM ladders WHERE user='alice' AND exercise='pushup'").get().rating,600);
});

test('friend duel requires recipient acceptance and cannot be accepted through legacy API',async t=>{
 const f=await fixture(t);await f.call('bob','profile',{name:'Bob',handle:'bob'});await f.call('alice','friends/request',{handle:'bob'});const friend=(await f.call('bob','state')).data.friends[0];await f.call('bob','friends/respond',{id:friend.id,action:'accept'});
 const invite=await f.call('alice','live/invite',{exercise:'squat',friend:friend.id});assert.equal(invite.status,200,JSON.stringify(invite));const id=invite.data.room.id;
 assert.equal((await f.call('bob','matches/respond',{id,action:'accept'})).status,409);
 assert.equal((await f.call('alice','live/respond',{id,accept:true})).status,403);
 assert.equal((await f.call('bob','live/respond',{id,accept:true})).data.room.phase,'preparing');
 assert.equal((await f.call('bob','live/respond',{id,accept:true})).data.room.phase,'preparing');
 await f.start(id);assert.equal(f.sqlite.prepare('SELECT exercise FROM sessions WHERE match=? LIMIT 1').get(id).exercise,'squat');
});

test('a stale ready player cannot start the clock until both heartbeats are fresh',async t=>{
 const f=await fixture(t),id=await f.room();await f.sync('alice',id,{ready:true});f.clock.now+=6000;
 assert.equal((await f.sync('bob',id,{ready:true})).data.room.phase,'preparing');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
 assert.equal((await f.sync('alice',id)).data.room.phase,'countdown');
});

test('final delivery grace accepts late valid evidence and settles automatically without duplicate rewards',async t=>{
 const f=await fixture(t),id=await f.room('squat');await f.start(id);await f.advance(id,60000);
 assert.equal((await f.sync('alice',id,{events:events(5),finished:true})).data.room.phase,'finishing');
 f.clock.now+=5000;assert.equal((await f.sync('bob',id,{events:events(6)})).data.room.ownReps,6);
 f.clock.now+=5000;const final=(await f.sync('alice',id)).data.room;assert.equal(final.phase,'complete');assert.equal(final.result.outcome,'loss');
 const bob=(await f.sync('bob',id,{events:events(9),finished:true})).data.room;assert.equal(bob.ownReps,6);assert.equal(bob.result.delta,12);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM activity').get().n,2);
});
