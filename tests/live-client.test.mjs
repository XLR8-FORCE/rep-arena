import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveSession} from '../dist/live-session.js';

const room = phase => ({id:'duel', phase, serverTime:Date.now()});
function client(request, evidence=()=>[]) {
  const live=new LiveSession({request,evidence,onState:()=>{},onError:()=>{}});
  live.schedule=()=>{};
  return live;
}

test('rep sync starts immediately, coalesces bursts and recovers after a failure',async()=>{
  let finish,calls=0;
  const live=client(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  live.open(room('running'));
  const first=live.pushEvidence(),again=live.pushEvidence();
  assert.equal(first,again);await Promise.resolve();assert.equal(calls,1);
  finish({room:room('running')});await first;
  const second=live.pushEvidence();await Promise.resolve();assert.equal(calls,2);
  finish({room:room('running')});await second;live.stop();
  const failed=client(async()=>{throw new Error('offline');});failed.open(room('running'));
  await failed.pushEvidence();assert.equal(failed.repSyncPending,null);failed.stop();
});

test('countdown heartbeats omit evidence; running heartbeats include the cumulative score',async()=>{
  const sent=[];
  const live=client(async(_,payload)=>{sent.push(payload);return {room:room(sent.length===1?'running':'finishing')};});
  live.open(room('countdown'));
  await live.sync();
  assert.equal('events' in sent[0],false);
  await live.sync();
  assert.deepEqual(sent[1].events,[]);
  live.stop();
});

test('finish intent survives a failed request and is retried by the next heartbeat',async()=>{
  const sent=[];
  const live=client(async(_,payload)=>{sent.push(payload);if(sent.length===1)throw new Error('Temporary outage');return {room:room('complete')};});
  live.open(room('finishing'));
  await assert.rejects(live.sync({finished:true}));
  await live.sync();
  assert.equal(sent[1].finished,true);
  assert.equal(live.terminal(),true);
  live.open(room('preparing'));
  assert.equal(live.finishRequested,false);
  live.stop();
});

test('a late response from a closed room cannot overwrite a new room',async()=>{
  let resolveRequest;
  const live=client(()=>new Promise(resolve=>{resolveRequest=resolve;}));
  live.open(room('running'));
  const pending=live.sync();
  await Promise.resolve();
  live.open({...room('preparing'),id:'new-duel'});
  resolveRequest({room:room('complete')});
  await pending;
  assert.equal(live.room.id,'new-duel');
  assert.equal(live.room.phase,'preparing');
  live.stop();
});
