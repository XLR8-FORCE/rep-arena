import { EXERCISES, elo, protect, validateEvidence } from '../dist/rules.js';
import {liveAPI,liveRooms} from './live.js';
const DAY=86400000;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
const id=()=>crypto.randomUUID();
const day=t=>new Date(t).toISOString().slice(0,10);
const week=t=>{const d=new Date(t);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return day(+d);};
export function dbAccess(binding){return {q:(sql,...args)=>binding.prepare(sql).bind(...args),one:(sql,...args)=>binding.prepare(sql).bind(...args).first(),all:async(sql,...args)=>(await binding.prepare(sql).bind(...args).all()).results,batch:statements=>binding.batch(statements)};}
async function settle(db,m){
  if(m.status!=='active'||m.score_a===null||m.score_b===null)return;
  const a=await db.one('SELECT * FROM ladders WHERE user=? AND exercise=?',m.a,m.exercise);
  const b=await db.one('SELECT * FROM ladders WHERE user=? AND exercise=?',m.b,m.exercise);
  const today=day(Date.now()); const result=m.score_a===m.score_b ? .5 : m.score_a>m.score_b ? 1 : 0;
  const pa=protect(elo(m.ra,m.rb,result),result===0?a.shields:0,a.shield_day===today),pb=protect(elo(m.rb,m.ra,1-result),result===1?b.shields:0,b.shield_day===today);
  const query=(user,p,r)=>db.q("UPDATE ladders SET rating=MAX(0,rating+?),wins=wins+?,losses=losses+?,draws=draws+?,shields=shields-?,shield_day=CASE WHEN ?>0 THEN ? ELSE shield_day END WHERE user=? AND exercise=? AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='active' AND score_a IS NOT NULL AND score_b IS NOT NULL)",p.delta,r===1?1:0,r===0?1:0,r===.5?1:0,p.saved?1:0,p.saved,today,user,m.exercise,m.id);
  await db.batch([query(m.a,pa,result),query(m.b,pb,1-result),db.q("UPDATE matches SET status='complete',delta_a=?,delta_b=?,saved_a=?,saved_b=?,completed=? WHERE id=? AND status='active' AND score_a IS NOT NULL AND score_b IS NOT NULL",pa.delta,pb.delta,pa.saved,pb.saved,Date.now(),m.id),db.q("DELETE FROM slots WHERE match=? AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='complete')",m.id,m.id)]);
}
async function expire(db,user){
  const ready=await db.all("SELECT * FROM matches WHERE (a=? OR b=?) AND status='active' AND score_a IS NOT NULL AND score_b IS NOT NULL AND NOT EXISTS(SELECT 1 FROM live_rooms WHERE id=matches.id)",user,user);
  for(const m of ready)await settle(db,m);
  const expired=await db.all("SELECT id FROM matches WHERE (a=? OR b=?) AND status IN ('queued','invited','active') AND expires<? AND NOT EXISTS(SELECT 1 FROM live_rooms WHERE id=matches.id)",user,user,Date.now());
  for(const m of expired)await db.batch([db.q("UPDATE matches SET status='expired' WHERE id=? AND status IN ('queued','invited','active') AND expires<? AND (score_a IS NULL OR score_b IS NULL)",m.id,Date.now()),db.q("DELETE FROM slots WHERE match=? AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='expired')",m.id,m.id)]);
}
function visibleMatch(m,user){ const own=m.a===user;return {id:m.id,isLive:!!m.is_live,exercise:m.exercise,status:m.status,opponent:own?m.name_b:m.name_a,opponentHandle:own?m.handle_b:m.handle_a,isChallenger:own,ownScore:own?m.score_a:m.score_b,opponentScore:m.status==='complete'?(own?m.score_b:m.score_a):null,opponentSubmitted:own?m.score_b!==null:m.score_a!==null,delta:own?m.delta_a:m.delta_b,saved:own?m.saved_a:m.saved_b,created:m.created,expires:m.expires,completed:m.completed};}
async function profile(db,user){
  const live=await liveRooms(db,user);
  await expire(db,user);
  const [me,ladders,sessions,activity,friends,matches,stats]=await Promise.all([
    db.one('SELECT handle,name,created FROM users WHERE id=?',user),db.all('SELECT * FROM ladders WHERE user=?',user),db.all('SELECT id,exercise,match,started,finished,reps,status FROM sessions WHERE user=? ORDER BY started DESC LIMIT 40',user),db.all('SELECT exercise,day FROM activity WHERE user=? ORDER BY day DESC',user),
    db.all('SELECT f.id,f.status,f.requester,u.name,u.handle FROM friends f JOIN users u ON u.id=CASE WHEN f.requester=? THEN f.recipient ELSE f.requester END WHERE f.requester=? OR f.recipient=? ORDER BY f.created DESC',user,user,user),
    db.all('SELECT m.*,EXISTS(SELECT 1 FROM live_rooms WHERE id=m.id) is_live,ua.name name_a,ub.name name_b,ua.handle handle_a,ub.handle handle_b FROM matches m JOIN users ua ON ua.id=m.a LEFT JOIN users ub ON ub.id=m.b WHERE m.a=? OR m.b=? ORDER BY m.created DESC LIMIT 40',user,user),db.one("SELECT COUNT(*) sessions,COALESCE(SUM(reps),0) reps FROM sessions WHERE user=? AND status='complete'",user)]);
  return {me,stats,ladders:ladders.map(({user,...l})=>l),sessions,activity,friends:friends.map(({requester,...f})=>({...f,incoming:requester!==user})),matches:matches.map(m=>visibleMatch(m,user)),liveRooms:live,serverTime:Date.now()};
}
export async function handleAPI(request,env){
  try{
    const url=new URL(request.url),path=url.pathname,method=request.method;
    if(!['GET','POST'].includes(method))return json({error:'Method not allowed'},405);
    if(method==='POST'&&((request.headers.get('origin')&&request.headers.get('origin')!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site'))fail('Cross-site request rejected.',403);
    const user=request.headers.get('oai-authenticated-user-id');
    if(!user)fail('Sign in to save sessions and compete.',401);
    if(!env.DB)fail('Arena storage is unavailable. Please try again.',503);
    const db=dbAccess(env.DB);
    let me=await db.one('SELECT * FROM users WHERE id=?',user);
    if(!me){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(user));const handle='athlete-'+Array.from(new Uint8Array(digest)).slice(0,5).map(x=>x.toString(16).padStart(2,'0')).join('');
      await db.batch([db.q('INSERT OR IGNORE INTO users(id,handle,name,created) VALUES(?,?,?,?)',user,handle,'Athlete',Date.now()),...EXERCISES.map(e=>db.q('INSERT OR IGNORE INTO ladders(user,exercise) VALUES(?,?)',user,e))]);
      me=await db.one('SELECT * FROM users WHERE id=?',user);
    }
    if(path==='/api/state'&&method==='GET')return json(await profile(db,user));
    if(path==='/api/leaderboard'&&method==='GET'){
      const exercise=url.searchParams.get('exercise');if(!EXERCISES.includes(exercise))fail('Choose an exercise.');
      return json(await db.all('SELECT u.name,u.handle,l.rating,l.wins,l.losses,l.draws FROM ladders l JOIN users u ON u.id=l.user WHERE l.exercise=? AND l.wins+l.losses+l.draws>0 ORDER BY l.rating DESC,l.wins DESC LIMIT 50',exercise));
    }
    if(method!=='POST')fail('Not found.',404);
    if(!request.headers.get('content-type')?.includes('application/json'))fail('JSON required.',415);
    const raw=await request.text();if(raw.length>30000)fail('Request too large.',413);
    let data;try{data=JSON.parse(raw);}catch{fail('Invalid JSON.');}
    if(!data||typeof data!=='object'||Array.isArray(data))fail('Invalid request.');
    if(path.startsWith('/api/live/'))return json(await liveAPI(db,user,path,data));
    if(path==='/api/profile'){
      const name=String(data.name||'').trim(),handle=String(data.handle||'').trim().toLowerCase();
      if(name.length<2||name.length>30||!(/^[a-z0-9_-]{3,24}$/).test(handle))fail('Use a 2–30 character name and a 3–24 character handle (letters, numbers, _ or -).');
      const occupied=await db.one('SELECT id FROM users WHERE handle=? AND id<>?',handle,user);if(occupied)fail('That handle is already taken.',409);
      await db.q('UPDATE users SET name=?,handle=? WHERE id=?',name,handle,user).run();return json({ok:true});
    }
    if(path==='/api/friends/request'){
      const target=await db.one('SELECT id FROM users WHERE handle=?',String(data.handle||'').replace(/^@/,'').toLowerCase().trim());
      if(!target)fail('No athlete with that handle yet. They need to open this arena first.',404);if(target.id===user)fail('That is your own handle.');
      if((await db.one('SELECT COUNT(*) n FROM friends WHERE requester=? OR recipient=?',user,user)).n>=100)fail('Friend list limit reached.');
      const key=[user,target.id].sort().join('|');if(await db.one('SELECT id FROM friends WHERE id=?',key))fail('You already have a connection or pending request.',409);
      await db.q('INSERT INTO friends(id,requester,recipient,created) VALUES(?,?,?,?)',key,user,target.id,Date.now()).run();return json({ok:true});
    }
    if(path==='/api/friends/respond'){
      const f=await db.one('SELECT * FROM friends WHERE id=? AND (requester=? OR recipient=?)',data.id,user,user);if(!f)fail('Request not found.',404);
      if(data.action==='accept'){if(f.recipient!==user||f.status!=='pending')fail('Only the recipient can accept this request.',403);await db.q("UPDATE friends SET status='accepted' WHERE id=? AND status='pending'",f.id).run();}
      else if(data.action==='remove')await db.q('DELETE FROM friends WHERE id=?',f.id).run();else fail('Unknown action.');return json({ok:true});
    }
    await expire(db,user);
    if(path==='/api/matches/queue'){
      const exercise=data.exercise;if(!EXERCISES.includes(exercise))fail('Choose an exercise.');
      const slot=await db.one('SELECT match FROM slots WHERE user=? AND exercise=?',user,exercise);if(slot){if(await db.one('SELECT id FROM live_rooms WHERE id=?',slot.match))fail('Use the live room to continue this match.',409);return json({id:slot.match});}
      const l=await db.one('SELECT rating FROM ladders WHERE user=? AND exercise=?',user,exercise);
      const candidate=await db.one("SELECT q.* FROM matches q WHERE q.exercise=? AND q.status='queued' AND q.a<>? AND q.expires>? AND ABS(q.ra-?)<=300 AND NOT EXISTS(SELECT 1 FROM live_rooms WHERE id=q.id) AND (SELECT COUNT(*) FROM matches m WHERE m.status='complete' AND m.exercise=q.exercise AND m.completed>? AND ((m.a=q.a AND m.b=?) OR (m.b=q.a AND m.a=?)))<2 ORDER BY q.created LIMIT 1",exercise,user,Date.now(),l.rating,Date.now()-DAY,user,user);
      if(candidate){
        await db.batch([db.q("UPDATE matches SET b=?,rb=?,status='active',expires=? WHERE id=? AND status='queued'",user,l.rating,Date.now()+DAY,candidate.id),db.q('INSERT INTO slots(user,exercise,match) SELECT ?,?,id FROM matches WHERE id=? AND b=?',user,exercise,candidate.id,user)]);
        const joined=await db.one('SELECT match FROM slots WHERE user=? AND exercise=?',user,exercise);if(joined)return json({id:joined.match});fail('Another athlete joined that round. Please queue again.',409);
      }
      const mid=id();await db.batch([db.q("INSERT INTO matches(id,exercise,a,status,ra,created,expires) VALUES(?,?,?,'queued',?,?,?)",mid,exercise,user,l.rating,Date.now(),Date.now()+DAY),db.q('INSERT INTO slots(user,exercise,match) VALUES(?,?,?)',user,exercise,mid)]);return json({id:mid});
    }
    if(path==='/api/matches/challenge'){
      const exercise=data.exercise;if(!EXERCISES.includes(exercise))fail('Choose an exercise.');
      const f=await db.one("SELECT * FROM friends WHERE id=? AND status='accepted' AND (requester=? OR recipient=?)",data.friend,user,user);if(!f)fail('Choose an accepted friend.',403);
      const target=f.requester===user?f.recipient:f.requester;
      if(await db.one("SELECT id FROM matches WHERE status='invited' AND exercise=? AND ((a=? AND b=?) OR (a=? AND b=?))",exercise,user,target,target,user))fail('A challenge is already pending.',409);
      if((await db.one("SELECT COUNT(*) n FROM matches WHERE a=? AND status='invited'",user)).n>=10)fail('You have 10 pending challenges.');
      const mid=id(),l=await db.one('SELECT rating FROM ladders WHERE user=? AND exercise=?',user,exercise);
      await db.q("INSERT INTO matches(id,exercise,a,b,status,ra,created,expires) VALUES(?,?,?,?,'invited',?,?,?)",mid,exercise,user,target,l.rating,Date.now(),Date.now()+DAY).run();return json({id:mid});
    }
    if(path==='/api/matches/respond'){
      const m=await db.one('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)',data.id,user,user);if(!m)fail('Match not found.',404);
      if(await db.one('SELECT id FROM live_rooms WHERE id=?',m.id))fail('Use the live room to respond to this match.',409);
      if(data.action==='accept'){
        if(m.status!=='invited'||m.b!==user)fail('This challenge cannot be accepted.',409);
        const occupied=await db.one('SELECT user FROM slots WHERE exercise=? AND user IN (?,?)',m.exercise,m.a,m.b);if(occupied)fail('One athlete already has a round in progress. Finish it first.',409);
        const a=await db.one('SELECT rating FROM ladders WHERE user=? AND exercise=?',m.a,m.exercise),b=await db.one('SELECT rating FROM ladders WHERE user=? AND exercise=?',m.b,m.exercise);
        const rematches=await db.one("SELECT COUNT(*) n FROM matches WHERE status='complete' AND exercise=? AND completed>? AND ((a=? AND b=?) OR (a=? AND b=?))",m.exercise,Date.now()-DAY,m.a,m.b,m.b,m.a);if(rematches.n>=2)fail('Two ranked rounds per pair each 24 hours. Try another opponent.');
        const acceptedAt=Date.now();
        await db.batch([db.q("INSERT INTO slots(user,exercise,match) SELECT ?,?,id FROM matches WHERE id=? AND status='invited' AND expires>?",m.a,m.exercise,m.id,acceptedAt),db.q("INSERT INTO slots(user,exercise,match) SELECT ?,?,id FROM matches WHERE id=? AND status='invited' AND expires>?",m.b,m.exercise,m.id,acceptedAt),db.q("UPDATE matches SET status='active',ra=?,rb=?,expires=? WHERE id=? AND status='invited' AND expires>? AND (SELECT COUNT(*) FROM slots WHERE match=?)=2",a.rating,b.rating,acceptedAt+DAY,m.id,acceptedAt,m.id)]);
        if((await db.one('SELECT status FROM matches WHERE id=?',m.id)).status!=='active')fail('This challenge was cancelled or expired before acceptance.',409);
      }else if(data.action==='cancel'){
        if(!['queued','invited','active'].includes(m.status))fail('This match is already closed.');
        if(m.status==='active')fail('Accepted rounds cannot be cancelled. An unfinished round expires after 24 hours.');
        await db.batch([db.q("UPDATE matches SET status='cancelled' WHERE id=? AND status IN ('queued','invited')",m.id),db.q("DELETE FROM slots WHERE match=? AND EXISTS(SELECT 1 FROM matches WHERE id=? AND status='cancelled')",m.id,m.id)]);
      }else fail('Unknown action.');return json({ok:true});
    }
    if(path==='/api/sessions/start'){
      const exercise=data.exercise;if(!EXERCISES.includes(exercise))fail('Choose an exercise.');
      if(await db.one("SELECT id FROM sessions WHERE user=? AND status='running' AND started>?",user,Date.now()-65000))fail('A round is already running.',409);
      let match=null;
      if(data.match){
        if(await db.one('SELECT id FROM live_rooms WHERE id=?',data.match))fail('Live rounds start together when both players are ready.',409);
        match=await db.one("SELECT * FROM matches WHERE id=? AND status='active' AND exercise=? AND (a=? OR b=?)",data.match,exercise,user,user);if(!match)fail('No active match for this exercise.',404);
        if(match.expires<Date.now()+65000)fail('This match is too close to expiry.');
        const prior=await db.one('SELECT * FROM sessions WHERE match=? AND user=?',match.id,user);if(prior)fail('Your one attempt for this match has already started. Retry a pending save, or wait for the match to expire.',409);
      }
      const sid=id(),started=Date.now()+4000;
      await db.q("INSERT INTO sessions(id,user,exercise,match,started,status) VALUES(?,?,?,?,?,'running')",sid,user,exercise,match?.id||null,started).run();return json({id:sid,startsIn:4000,duration:60000});
    }
    if(path==='/api/sessions/finish'){
      const s=await db.one('SELECT * FROM sessions WHERE id=? AND user=?',data.id,user);if(!s)fail('Session not found.',404);
      if(s.match&&await db.one('SELECT id FROM live_rooms WHERE id=?',s.match))fail('Submit this attempt through its live room.',409);
      if(s.status==='complete')return json({ok:true,reps:s.reps});
      const elapsed=Date.now()-s.started;if(elapsed<59500||elapsed>10*60*1000)fail('This attempt is outside its submission window.');
      const reps=validateEvidence(data.events,s.exercise),today=day(Date.now());
      if(s.match){const m=await db.one('SELECT * FROM matches WHERE id=?',s.match);if(m.status!=='active')fail('This match is no longer active.');}
      const queries=[db.q("UPDATE ladders SET best=MAX(best,?) WHERE user=? AND exercise=? AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND status='running')",reps,user,s.exercise,s.id)];
      if(reps>=5)queries.push(db.q("INSERT OR IGNORE INTO activity(user,exercise,day) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND status='running')",user,s.exercise,today,s.id));
      if(s.match){const m=await db.one('SELECT * FROM matches WHERE id=?',s.match);queries.push(db.q(`UPDATE matches SET ${m.a===user?'score_a':'score_b'}=? WHERE id=? AND status='active' AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND status='running')`,reps,s.match,s.id));}
      queries.push(db.q("UPDATE sessions SET status='complete',finished=?,reps=?,evidence=? WHERE id=? AND status='running'",Date.now(),reps,JSON.stringify(data.events),s.id));
      await db.batch(queries);
      const days=(await db.one('SELECT COUNT(*) n FROM activity WHERE user=? AND exercise=?',user,s.exercise)).n;
      await db.q("UPDATE ladders SET shields=MIN(2,shields+1),earned=earned+1,shield_week=? WHERE user=? AND exercise=? AND shields<2 AND earned<? AND shield_week<>?",week(Date.now()),user,s.exercise,Math.floor(days/5),week(Date.now())).run();
      if(s.match)await settle(db,await db.one('SELECT * FROM matches WHERE id=?',s.match));
      return json({ok:true,reps:(await db.one('SELECT reps FROM sessions WHERE id=?',s.id)).reps});
    }
    fail('Not found.',404);
  }catch(error){if(!error.status)console.error('Arena API error:',error.message);return json({error:error.status?error.message:'Could not complete that request. Please refresh and try again.'},error.status||503);}
}
