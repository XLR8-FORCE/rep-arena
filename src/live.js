import {EXERCISES, elo, protect, validateEvidence} from '../dist/rules.js';

const DAY=86400000, COUNTDOWN=5000, DURATION=60000, DISCONNECT=10000, DELIVERY_GRACE=10000;
const terminal=new Set(['complete','cancelled','void']);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const day=t=>new Date(t).toISOString().slice(0,10);
const week=t=>{const d=new Date(t);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return day(+d);};
const roomSQL=`SELECT l.*,m.exercise,m.a,m.b,m.status,m.ra,m.rb,m.created,m.delta_a,m.delta_b,m.saved_a,m.saved_b,
 ua.name name_a,ua.handle handle_a,ub.name name_b,ub.handle handle_b
 FROM live_rooms l JOIN matches m ON m.id=l.id JOIN users ua ON ua.id=m.a LEFT JOIN users ub ON ub.id=m.b`;
const read=(db,id)=>db.one(roomSQL+' WHERE l.id=?',id);
const guard=(r)=>[r.id,r.version];
const liveGuard="EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND version=? AND phase NOT IN ('complete','cancelled','void'))";

function snapshot(r,user,now){
 const own=r.a===user,s=own?'a':'b',other=own?'b':'a';
 let phase=r.phase;if(phase==='countdown'&&now>=r.starts_at)phase=now>=r.ends_at?'finishing':'running';
 const opponent=r[other]?{name:r['name_'+other],handle:r['handle_'+other]}:null;
 return {id:r.id,exercise:r.exercise,phase,opponent,isHost:own,ownReady:!!r['ready_'+s],opponentReady:!!r['ready_'+other],
  ownReps:r['reps_'+s],opponentReps:r['reps_'+other],ownEvents:JSON.parse(r['events_'+s]),
  ownConnected:now-r['seen_'+s]<DISCONNECT,opponentConnected:!!opponent&&r['seen_'+other]!==null&&now-r['seen_'+other]<DISCONNECT,
  startsAt:r.starts_at,endsAt:r.ends_at,serverTime:now,sessionId:r['sid_'+s],canReady:phase==='preparing',
  result:terminal.has(phase)?{outcome:phase!=='complete'?'void':r.winner==='draw'?'draw':r.winner===s?'win':'loss',delta:r['delta_'+s]||0,saved:r['saved_'+s]||0,reason:r.reason}:null};
}

async function closeRoom(db,r,phase,reason,now){
 const changes=await db.batch([
  db.q(`UPDATE matches SET status=?,completed=? WHERE id=? AND ${liveGuard}`,phase==='void'?'expired':'cancelled',now,r.id,...guard(r)),
  db.q(`UPDATE sessions SET status='abandoned',finished=? WHERE match=? AND status='running' AND ${liveGuard}`,now,r.id,...guard(r)),
  db.q(`DELETE FROM slots WHERE match=? AND ${liveGuard}`,r.id,...guard(r)),
  db.q("UPDATE live_rooms SET phase=?,reason=?,updated=?,version=version+1 WHERE id=? AND version=? AND phase NOT IN ('complete','cancelled','void')",phase,reason,now,...guard(r)),
 ]);
 return !!changes.at(-1).meta.changes;
}

// Every side effect shares a version guard and runs in one database transaction.
// Two simultaneous result/heartbeat requests can therefore never settle twice.
async function settleRoom(db,r,winner,reason,now,{forfeit=false}={}){
 const [a,b]=await Promise.all([db.one('SELECT * FROM ladders WHERE user=? AND exercise=?',r.a,r.exercise),db.one('SELECT * FROM ladders WHERE user=? AND exercise=?',r.b,r.exercise)]);
 const result=winner==='draw'?.5:winner==='a'?1:0,today=day(now);
 const pa=protect(elo(r.ra,r.rb,result),!forfeit&&result===0?a.shields:0,a.shield_day===today);
 const pb=protect(elo(r.rb,r.ra,1-result),!forfeit&&result===1?b.shields:0,b.shield_day===today);
 const queries=[];
 for(const [user,p,res,s] of [[r.a,pa,result,'a'],[r.b,pb,1-result,'b']]){
  queries.push(db.q(`UPDATE ladders SET rating=MAX(0,rating+?),wins=wins+?,losses=losses+?,draws=draws+?,shields=shields-?,shield_day=CASE WHEN ?>0 THEN ? ELSE shield_day END WHERE user=? AND exercise=? AND ${liveGuard}`,
   p.delta,res===1?1:0,res===0?1:0,res===.5?1:0,p.saved?1:0,p.saved,today,user,r.exercise,...guard(r)));
  if(!forfeit){
   queries.push(db.q(`UPDATE ladders SET best=MAX(best,?) WHERE user=? AND exercise=? AND ${liveGuard}`,r['reps_'+s],user,r.exercise,...guard(r)));
   if(r['reps_'+s]>=5)queries.push(db.q(`INSERT OR IGNORE INTO activity(user,exercise,day) SELECT ?,?,? WHERE ${liveGuard}`,user,r.exercise,today,...guard(r)));
   queries.push(db.q(`UPDATE ladders SET shields=MIN(2,shields+1),earned=earned+1,shield_week=? WHERE user=? AND exercise=? AND shields<2 AND earned<(SELECT COUNT(*)/5 FROM activity WHERE user=? AND exercise=?) AND shield_week<>? AND ${liveGuard}`,week(now),user,r.exercise,user,r.exercise,week(now),...guard(r)));
  }
  queries.push(db.q(`UPDATE sessions SET status=?,finished=?,reps=?,evidence=? WHERE id=? AND status='running' AND ${liveGuard}`,forfeit?'abandoned':'complete',now,r['reps_'+s],r['events_'+s],r['sid_'+s],...guard(r)));
 }
 queries.push(db.q(`UPDATE matches SET status='complete',score_a=?,score_b=?,delta_a=?,delta_b=?,saved_a=?,saved_b=?,completed=? WHERE id=? AND ${liveGuard}`,r.reps_a,r.reps_b,pa.delta,pb.delta,pa.saved,pb.saved,now,r.id,...guard(r)));
 queries.push(db.q(`DELETE FROM slots WHERE match=? AND ${liveGuard}`,r.id,...guard(r)));
 queries.push(db.q("UPDATE live_rooms SET phase='complete',winner=?,reason=?,updated=?,version=version+1 WHERE id=? AND version=? AND phase NOT IN ('complete','cancelled','void')",winner,reason,now,...guard(r)));
 const changes=await db.batch(queries);return !!changes.at(-1).meta.changes;
}

async function reconcile(db,id,now){
 let r=await read(db,id);if(!r||terminal.has(r.phase))return r;
 if(r.phase==='queued'&&now-r.seen_a>15000)await closeRoom(db,r,'cancelled','Search ended because the player disconnected.',now);
 else if(r.phase==='invited'&&now-r.updated>120000)await closeRoom(db,r,'cancelled','The invitation expired.',now);
 else if(r.phase==='preparing'&&now-r.updated>120000)await closeRoom(db,r,'cancelled','Preparation timed out. Neither rank changed.',now);
 else if(['countdown','running','finishing'].includes(r.phase)){
  // Connectivity at round end is what matters. Delivery grace cannot turn an
  // already completed 60-second effort into a disconnect forfeit.
  const cutoff=Math.min(now,r.ends_at),goneA=cutoff-r.seen_a>DISCONNECT,goneB=cutoff-r.seen_b>DISCONNECT;
  if(goneA&&goneB)await closeRoom(db,r,'void','Both players disconnected. Neither rank changed.',now);
  else if(goneA||goneB){
   if(now<r.starts_at)await closeRoom(db,r,'cancelled','A player disconnected before the start.',now);
   else await settleRoom(db,r,goneA?'b':'a','A player disconnected for more than 10 seconds.',now,{forfeit:true});
  }else if(now>=r.ends_at&&((r.finished_a&&r.finished_b)||now>=r.ends_at+DELIVERY_GRACE)){
   await settleRoom(db,r,r.reps_a===r.reps_b?'draw':r.reps_a>r.reps_b?'a':'b','The 60-second round is complete.',now);
  }else{
   const phase=now>=r.ends_at?'finishing':now>=r.starts_at?'running':'countdown';
   if(phase!==r.phase)await db.q('UPDATE live_rooms SET phase=?,updated=?,version=version+1 WHERE id=? AND version=?',phase,now,...guard(r)).run();
  }
 }
 return read(db,id);
}

export async function liveRooms(db,user,now=Date.now()){
 const rows=await db.all("SELECT l.id FROM live_rooms l JOIN matches m ON m.id=l.id WHERE (m.a=? OR m.b=?) AND (l.phase NOT IN ('complete','cancelled','void') OR l.updated>?) ORDER BY m.created DESC LIMIT 20",user,user,now-DAY);
 const result=[];for(const row of rows){const r=await reconcile(db,row.id,now);result.push(snapshot(r,user,now));}return result;
}

async function occupied(db,user){return db.one("SELECT l.id,m.exercise FROM live_rooms l JOIN matches m ON m.id=l.id WHERE (m.a=? OR (m.b=? AND l.phase<>'invited')) AND l.phase NOT IN ('complete','cancelled','void') LIMIT 1",user,user);}
async function pairAllowed(db,a,b,exercise,now){return (await db.one("SELECT COUNT(*) n FROM matches WHERE status='complete' AND exercise=? AND completed>? AND ((a=? AND b=?) OR (a=? AND b=?))",exercise,now-DAY,a,b,b,a)).n<2;}
async function ownRoom(db,user,id,now){const r=await read(db,id);if(!r||![r.a,r.b].includes(user))fail('Live match not found.',404);return reconcile(db,id,now);}

export async function liveAPI(db,user,path,data,now=Date.now(),attempt=0){
 if(!['/api/live/queue','/api/live/invite','/api/live/respond','/api/live/sync'].includes(path))fail('Not found.',404);
 if(path==='/api/live/queue'||path==='/api/live/invite'){
  const exercise=data.exercise;if(!EXERCISES.includes(exercise))fail('Choose an exercise.');
  await liveRooms(db,user,now);
  const existing=await occupied(db,user);if(existing){if(path==='/api/live/queue'&&existing.exercise===exercise)return {room:snapshot(await read(db,existing.id),user,now)};fail('Finish or leave your current live room first.',409);}
  if(await db.one('SELECT match FROM slots WHERE user=? AND exercise=?',user,exercise))fail('Finish your existing ranked round first.',409);
  const rating=(await db.one('SELECT rating FROM ladders WHERE user=? AND exercise=?',user,exercise)).rating;
  if(path==='/api/live/queue'){
   const candidate=await db.one(`${roomSQL} WHERE l.phase='queued' AND m.status='queued' AND m.exercise=? AND m.a<>? AND l.seen_a>=? AND ABS(m.ra-?)<=300 AND (SELECT COUNT(*) FROM matches previous WHERE previous.status='complete' AND previous.exercise=m.exercise AND previous.completed>? AND ((previous.a=m.a AND previous.b=?) OR (previous.b=m.a AND previous.a=?)))<2 ORDER BY m.created LIMIT 1`,exercise,user,now-10000,rating,now-DAY,user,user);
   if(candidate){
    await db.batch([
     db.q("UPDATE matches SET b=?,rb=?,status='active',expires=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='queued' AND seen_a>=?)",user,rating,now+300000,candidate.id,candidate.id,now-10000),
     db.q("UPDATE live_rooms SET phase='preparing',seen_b=?,updated=?,version=version+1 WHERE id=? AND phase='queued' AND EXISTS(SELECT 1 FROM matches WHERE id=? AND b=?)",now,now,candidate.id,candidate.id,user),
     db.q("INSERT INTO slots(user,exercise,match) SELECT ?,?,id FROM matches WHERE id=? AND b=? AND status='active'",user,exercise,candidate.id,user),
    ]);
    const joined=await read(db,candidate.id);if(joined.b===user)return {room:snapshot(joined,user,now)};
    fail('Another player joined first. Please search again.',409);
   }
  }
  let target=null;
  if(path==='/api/live/invite'){
   const friend=await db.one("SELECT * FROM friends WHERE id=? AND status='accepted' AND (requester=? OR recipient=?)",data.friend,user,user);if(!friend)fail('Choose an accepted friend.',403);
   target=friend.requester===user?friend.recipient:friend.requester;
   await liveRooms(db,target,now);
   if(await occupied(db,target))fail('Your friend is already in a live room.',409);
   if(!await pairAllowed(db,user,target,exercise,now))fail('Two ranked rounds per pair each 24 hours. Try another opponent.');
  }
  const id=crypto.randomUUID(),phase=target?'invited':'queued';
  await db.batch([
   db.q('INSERT INTO matches(id,exercise,a,b,status,ra,created,expires) VALUES(?,?,?,?,?,?,?,?)',id,exercise,user,target,phase,rating,now,now+300000),
   db.q('INSERT INTO live_rooms(id,phase,seen_a,updated) VALUES(?,?,?,?)',id,phase,now,now),
   db.q('INSERT INTO slots(user,exercise,match) VALUES(?,?,?)',user,exercise,id),
  ]);
  // If two searches were inserted concurrently, only the later room joins the
  // earlier one. Deterministic ordering avoids two players waiting separately.
  if(!target){
   const earlier=await db.one(`${roomSQL} WHERE l.phase='queued' AND m.status='queued' AND m.exercise=? AND m.a<>? AND l.seen_a>=? AND ABS(m.ra-?)<=300 AND (m.created<? OR (m.created=? AND m.id<?)) AND (SELECT COUNT(*) FROM matches previous WHERE previous.status='complete' AND previous.exercise=m.exercise AND previous.completed>? AND ((previous.a=m.a AND previous.b=?) OR (previous.b=m.a AND previous.a=?)))<2 ORDER BY m.created,m.id LIMIT 1`,exercise,user,now-10000,rating,now,now,id,now-DAY,user,user);
   if(earlier){
    await db.batch([
     db.q("UPDATE matches SET b=?,rb=?,status='active',expires=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='queued') AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='queued')",user,rating,now+300000,earlier.id,earlier.id,id),
     db.q("UPDATE live_rooms SET phase='preparing',seen_b=?,updated=?,version=version+1 WHERE id=? AND phase='queued' AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='active' AND b=?)",now,now,earlier.id,earlier.id,user),
     db.q("DELETE FROM slots WHERE match=? AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='active' AND b=?)",id,earlier.id,user),
     db.q("UPDATE matches SET status='cancelled',completed=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='active' AND b=?)",now,id,earlier.id,user),
     db.q("UPDATE live_rooms SET phase='cancelled',reason='Merged into the live match.',updated=?,version=version+1 WHERE id=? AND phase='queued' AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='active' AND b=?)",now,id,earlier.id,user),
     db.q("INSERT INTO slots(user,exercise,match) SELECT ?,?,id FROM matches WHERE id=? AND b=? AND status='active'",user,exercise,earlier.id,user),
    ]);
    const joined=await read(db,earlier.id);if(joined.b===user)return {room:snapshot(joined,user,now)};
   }
  }
  return {room:snapshot(await read(db,id),user,now)};
 }
 if(typeof data.id!=='string'||!data.id)fail('Choose a live room.');
 let r=await ownRoom(db,user,data.id,now),s=r.a===user?'a':'b';
 if(path==='/api/live/respond'){
  if(r.phase!=='invited')return {room:snapshot(r,user,now)};
  if(user!==r.b)fail('Only the invited player can respond.',403);
  if(data.accept!==true){await closeRoom(db,r,'cancelled','The invitation was declined.',now);return {room:snapshot(await read(db,r.id),user,now)};}
  await liveRooms(db,user,now);
  if(await occupied(db,user)||await db.one('SELECT match FROM slots WHERE user=? AND exercise=?',user,r.exercise))fail('Finish your current round first.',409);
  if(!await pairAllowed(db,r.a,r.b,r.exercise,now))fail('Two ranked rounds per pair each 24 hours. Try another opponent.');
  const rating=(await db.one('SELECT rating FROM ladders WHERE user=? AND exercise=?',user,r.exercise)).rating;
  await db.batch([
   db.q("UPDATE matches SET status='active',rb=?,expires=? WHERE id=? AND status='invited' AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='invited' AND version=?)",rating,now+300000,r.id,...guard(r)),
   db.q("INSERT INTO slots(user,exercise,match) SELECT ?,?,id FROM matches WHERE id=? AND status='active' AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='invited' AND version=?)",user,r.exercise,r.id,...guard(r)),
   db.q("UPDATE live_rooms SET phase='preparing',seen_b=?,updated=?,version=version+1 WHERE id=? AND phase='invited' AND version=? AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='active')",now,now,r.id,r.version,r.id),
  ]);
  return {room:snapshot(await read(db,r.id),user,now)};
 }
 if(path!=='/api/live/sync')fail('Not found.',404);
 if(terminal.has(r.phase))return {room:snapshot(r,user,now)};
 if(data.leave===true){
  const closed=r.starts_at!==null&&now>=r.starts_at?await settleRoom(db,r,s==='a'?'b':'a','A player left the live round.',now,{forfeit:true}):await closeRoom(db,r,'cancelled','A player left before the start. Neither rank changed.',now);
  if(!closed&&attempt<4)return liveAPI(db,user,path,data,now,attempt+1);
  return {room:snapshot(await read(db,r.id),user,now)};
 }
 if(data.ready!==undefined&&typeof data.ready!=='boolean')fail('Ready must be true or false.');
 if(data.events!==undefined){
  if(!['running','finishing'].includes(r.phase))fail('The shared round has not started.',409);
  let reps;try{reps=validateEvidence(data.events,r.exercise);}catch(error){fail(error.message);}
  const old=JSON.parse(r['events_'+s]);
  if(data.events.length<old.length||old.some((e,i)=>['t','low','high','duration','v','drop','bend','topDrop','range'].some(k=>e[k]!==data.events[i]?.[k])))fail('Accepted reps cannot be removed or changed.',409);
  if(data.events.some(e=>e.t>Math.min(DURATION,now-r.starts_at+1000)))fail('A rep is ahead of the shared match clock.');
  if(r['finished_'+s]&&reps!==r['reps_'+s])fail('Your final score has already been submitted.',409);
 }
 if(data.finished===true&&(!r.ends_at||now<r.ends_at))fail('The shared round is still running.');
 // A conditional version update makes stale submissions harmless. Clients send
 // the same cumulative evidence again on the next sync, so no count is lost.
 const sets=[`seen_${s}=?`,'version=version+1'],args=[now];
 if(data.ready!==undefined&&r.phase==='preparing'){sets.push(`ready_${s}=?`);args.push(data.ready?1:0);}
 if(data.events!==undefined){sets.push(`events_${s}=?`,`reps_${s}=?`);args.push(JSON.stringify(data.events.map(({t,low,high,duration,v,drop,bend,topDrop,range})=>({t,low,high,duration,...(v===2?{v,drop,bend,topDrop,range}:{})}))),data.events.length);}
 if(data.finished===true){sets.push(`finished_${s}=1`);}
 const changed=await db.q(`UPDATE live_rooms SET ${sets.join(',')} WHERE id=? AND version=?`,...args,...guard(r)).run();
 if(!changed.meta.changes){if(attempt<4)return liveAPI(db,user,path,data,now,attempt+1);fail('The room changed. Please sync again.',409);}
 r=await read(db,r.id);
 if(r.phase==='preparing'&&r.ready_a&&r.ready_b&&now-r.seen_a<3000&&now-r.seen_b<3000){
  const starts=now+COUNTDOWN,sidA=crypto.randomUUID(),sidB=crypto.randomUUID();
  await db.batch([
   db.q("INSERT OR IGNORE INTO sessions(id,user,exercise,match,started,status) SELECT ?,a,exercise,id,?,'running' FROM matches WHERE id=? AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='preparing' AND version=? AND ready_a=1 AND ready_b=1)",sidA,starts,r.id,...guard(r)),
   db.q("INSERT OR IGNORE INTO sessions(id,user,exercise,match,started,status) SELECT ?,b,exercise,id,?,'running' FROM matches WHERE id=? AND EXISTS(SELECT 1 FROM live_rooms WHERE id=? AND phase='preparing' AND version=? AND ready_a=1 AND ready_b=1)",sidB,starts,r.id,...guard(r)),
   db.q("UPDATE live_rooms SET phase='countdown',starts_at=?,ends_at=?,sid_a=?,sid_b=?,updated=?,version=version+1 WHERE id=? AND phase='preparing' AND version=? AND ready_a=1 AND ready_b=1",starts,starts+DURATION,sidA,sidB,now,...guard(r)),
  ]);
 }
 return {room:snapshot(await reconcile(db,r.id,now),user,now)};
}
