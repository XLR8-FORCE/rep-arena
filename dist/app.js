import {RepCounter,rank,TIERS} from './rules.js';
import {LiveSession} from './live-session.js';
import {createPoseEngine} from './pose-engine.js';
// Camera frames never leave this browser. Only completed rep summaries are submitted.
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data=null,mode='pushup',view='arena',stream=null,landmarker=null,raf=0,lastFrame=0,lastVideo=-1,counter=new RepCounter(),running=false,round=null,selectedMatch=null,demo=false,timer=null,loadingCamera=false,pending=null;
let toastTimer,refreshing=false;
let cameraFacing='user',wakeLock=null,startingRound=false;
let cameraReady=false,lastPoseAt=0;
let videoCallback=false,repFeedbackUntil=0;
let playMode='live',friendSelection=null,queueing=false,connected=false,liveLocalDone=false,liveResultShown=null;
const live=new LiveSession({request:(path,body)=>api(path,body),onState:updateDuel,onError:liveConnectionError,evidence:()=>round?.live&&live.room?.id===round.match?counter.events:undefined});
const activeLive=()=>live.room&&!live.terminal();
const label=e=>e==='pushup'?'Push-ups':'Squats';
const placement=()=>mode==='pushup'?'Frame both shoulders. Elbows, wrists and legs are not required. Keep the phone fixed. Use Set top and Set bottom below the camera, or complete one automatic setup rep. Yellow is your top band; blue is your bottom band.':'Place your phone side-on at hip height. Keep your whole body in frame, then stand tall.';
const trackingPanel=document.createElement('section');trackingPanel.className='arm-tracking-panel';trackingPanel.hidden=true;trackingPanel.setAttribute('aria-label','Shoulder tracking');
trackingPanel.innerHTML='<strong>SHOULDERS ONLY</strong><p id="tracking-setup"></p><p id="tracking-reason"></p><div id="tracking-joints" class="tracking-joints"></div><details><summary>Movement checks</summary><p id="tracking-measurements"></p></details><p id="tracking-rejection" hidden></p>';
$('#camera-stage').after(trackingPanel);
const calibration=document.createElement('div');calibration.className='shoulder-calibration';
calibration.innerHTML='<p>Custom shoulder heights (optional): tap a button, then hold that pose for the 3-second countdown. Shaded guides allow a little movement around each saved height.</p><button type="button" id="set-shoulder-top">SET TOP · 3s</button> <button type="button" id="set-shoulder-bottom">SET BOTTOM · 3s</button> <button type="button" id="reset-shoulder-positions">RESET POSITIONS</button><p id="calibration-message" role="status"></p>';
trackingPanel.append(calibration);
let capturePosition=null;
const calibrationLocked=()=>running||startingRound||live.room?.ownReady||['countdown','running','finishing'].includes(live.room?.phase);
for(const position of ['top','bottom'])$('#set-shoulder-'+position).onclick=()=>{
 if(calibrationLocked()||!stream)return;
 if(position==='bottom'&&!counter.front?.baseline?.manual){$('#calibration-message').textContent='Set your top first.';return;}
 capturePosition={position,due:performance.now()+3000};cameraReady=false;
 $('#calibration-message').textContent='Move into your '+position+' pose and hold still…';
};
$('#reset-shoulder-positions').onclick=()=>{if(calibrationLocked())return;capturePosition=null;counter.reset();cameraReady=false;$('#calibration-message').textContent='Positions cleared. Use the buttons or complete an automatic setup rep.';};
function updateCalibration(now){
 const locked=calibrationLocked();
 for(const id of ['set-shoulder-top','set-shoulder-bottom','reset-shoulder-positions'])$('#'+id).disabled=!!locked;
 if(!capturePosition)return;
 cameraReady=false;
 if(locked){capturePosition=null;return;}
 const remaining=Math.ceil((capturePosition.due-now)/1000);
 if(remaining>0){$('#calibration-message').textContent='Hold '+capturePosition.position+' position · capturing in '+remaining+'…';return;}
 try{$('#calibration-message').textContent=counter.setPosition(capturePosition.position,now);}
 catch(e){$('#calibration-message').textContent=e.message;}
 capturePosition=null;
}
function renderTracking(feedback){
 trackingPanel.hidden=mode!=='pushup'||!stream;if(trackingPanel.hidden)return;
 const d=feedback.diagnostics;if(!d)return;
 $('#tracking-setup').textContent=d.setup;
 $('#tracking-reason').textContent=feedback.hint;
 const missing=new Set(d.missingJoints);
 $('#tracking-joints').replaceChildren(...['left shoulder','right shoulder'].map(name=>{const chip=document.createElement('span');const visible=!missing.has(name);chip.className=visible?'tracked':'missing';chip.textContent=(visible?'✓ ':'? ')+name;return chip;}));
 const m=d.measurements;$('#tracking-measurements').textContent=m?`Shoulder travel: ${m.depthPercent}% of required depth. Back at top: ${m.atTop?'yes':'not yet'}.`:'Movement checks will appear once your starting position and both shoulders are tracked.';
 if(feedback.rejection){$('#tracking-rejection').hidden=false;$('#tracking-rejection').textContent='Last missed rep: '+feedback.rejection+'.';}
 else if(feedback.counted){$('#tracking-rejection').hidden=true;}
}
function setupCameraCopy(){ $('#camera-placeholder > p:not(.eyebrow)').textContent=placement(); }
const empty=(title,copy)=>`<div class="empty-state"><strong>${title}</strong><p>${copy}</p></div>`;
const date=t=>new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(t));
async function enableCamera(){
 if(round?.live&&liveLocalDone)throw new Error('This round has ended. Return to the lobby for another set.');
 if(loadingCamera||stream)return;if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access requires HTTPS or localhost in a supported browser.');
 loadingCamera=true;$('#enable-camera').disabled=true;$('#enable-camera').textContent='CONNECTING CAMERA…';
 try{
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:cameraFacing},width:{ideal:960},height:{ideal:720}},audio:false});$('#camera').srcObject=stream;await $('#camera').play();$('#camera').hidden=false;$('#camera-placeholder').hidden=true;$('#camera-off').hidden=false;$('#flip-camera').hidden=false;$('#camera').classList.toggle('rear-camera',cameraFacing==='environment');$('#pose-overlay').classList.toggle('rear-camera',cameraFacing==='environment');$('#form-feedback').hidden=false;$('#form-feedback').textContent='Loading pose detection. First launch can take a moment…';
  if(!landmarker)landmarker=await createPoseEngine();
  $('#pose-overlay').hidden=false;$('#rep-hud').hidden=false;$('#live-status').innerHTML='<span></span> LIVE · POSE TRACKING';if(!round?.live||!running)counter=new RepCounter(mode);lastVideo=-1;lastFrame=0;scheduleDetection();if(activeLive())paintDuel();
 }catch(e){stopCamera();throw new Error(e.name==='NotAllowedError'?'Camera permission was denied. Allow camera access in your browser, then try again.':e.name==='NotFoundError'?'No camera was found. Connect a camera, or explore the demo.':'Could not start pose detection. Check your camera and internet connection, then try again.');}
 finally{loadingCamera=false;$('#enable-camera').disabled=false;$('#enable-camera').textContent='ENABLE CAMERA ↗';}
}
function scheduleDetection(){const video=$('#camera');videoCallback=typeof video.requestVideoFrameCallback==='function';raf=videoCallback?video.requestVideoFrameCallback(detect):requestAnimationFrame(detect);}
function detect(now){
 if(!stream)return;const video=$('#camera');
 if(now-lastFrame>=30&&video.readyState>=2&&video.currentTime!==lastVideo){lastFrame=now;lastVideo=video.currentTime;
  try{const result=landmarker.detectForVideo(video,now);const time=running?roundElapsed():now;const active=running&&time>=0&&time<60000;
   if(running&&time>=60000){void finishRound();if(stream)scheduleDetection();return;}
   // Start the scored state machine on its first actual frame, never inside
   // the countdown. Calibration survives; an unfinished warmup rep does not.
   if(active&&!round.countingStarted){const accepted=round.live?(live.room.ownEvents||[]).map(e=>({...e})):[];counter.reset(true);counter.events=accepted;counter.count=accepted.length;counter.last=accepted.at(-1)?.t||0;round.countingStarted=true;}
   const previousCount=counter.count;
   const feedback=counter.update(result.landmarks[0],active?time:now,video.videoWidth,video.videoHeight,result.worldLandmarks?.[0]);
   cameraReady=feedback.visible&&(mode!=='pushup'||feedback.ready);lastPoseAt=performance.now();
   if(mode==='pushup')updateCalibration(now);
   if(!active&&!liveLocalDone){counter.count=0;counter.events=[];counter.last=0;}
   if(active&&counter.count>previousCount){repFeedbackUntil=now+450;if(round.live)void live.pushEvidence();$('#rep-count').animate?.([{transform:'scale(1.16)'},{transform:'scale(1)'}],{duration:180});}
   $('#form-feedback').textContent=active&&now<repFeedbackUntil?'+1 · REP COUNTED':(!running&&mode==='pushup'&&cameraReady?'FRONT VIEW READY · ':'')+feedback.hint;$('#form-feedback').classList.toggle('good',cameraReady);
   $('#form-feedback').dataset.phase=feedback.phase||'seek';
   renderTracking(feedback);
   if(active){$('#rep-count').textContent=String(counter.count).padStart(2,'0');if(round.live)$('#duel-own-reps').textContent=counter.count;}drawPose(result.landmarks[0]);
  }catch{if(running)finishRound(true);stopCamera();notify('Pose tracking stopped. Please reconnect your camera.');return;}
 }
 if(stream)scheduleDetection();
}
function drawPose(points){const canvas=$('#pose-overlay'),v=$('#camera');canvas.width=v.videoWidth;canvas.height=v.videoHeight;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!points)return;ctx.strokeStyle='#efff61';ctx.fillStyle='#efff61';ctx.lineWidth=3;
 const bands=mode==='pushup'?counter.bands:null;
 if(bands){ctx.save();for(const [y,tolerance,color] of [[bands.top,bands.topTolerance,'#efff61'],[bands.bottom,bands.bottomTolerance,'#72cfff']]){
  if(y===null)continue;ctx.fillStyle=color;ctx.globalAlpha=.16;ctx.fillRect(0,y-tolerance,canvas.width,tolerance*2);ctx.globalAlpha=.9;ctx.strokeStyle=color;ctx.setLineDash([10,8]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();
 }ctx.restore();}
 const armLinks=[[11,12],[11,13],[13,15],[12,14],[14,16]];
 const links=mode==='pushup'?[[11,12]]:[...armLinks,[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
 const joints=mode==='pushup'?[11,12]:[11,12,13,14,15,16,23,24,25,26,27,28];
 const visible=i=>points[i]&&Number.isFinite(points[i].x)&&Number.isFinite(points[i].y)&&points[i].visibility>=(mode==='pushup'?.5:.6)&&points[i].x>.005&&points[i].x<.995&&points[i].y>.005&&points[i].y<.995;
 for(const [a,b] of links){if(!visible(a)||!visible(b))continue;ctx.beginPath();ctx.moveTo(points[a].x*canvas.width,points[a].y*canvas.height);ctx.lineTo(points[b].x*canvas.width,points[b].y*canvas.height);ctx.stroke();}
 for(const i of joints)if(visible(i)){ctx.beginPath();ctx.arc(points[i].x*canvas.width,points[i].y*canvas.height,5,0,Math.PI*2);ctx.fill();}
}
function stopCamera(){capturePosition=null;if(videoCallback)$('#camera').cancelVideoFrameCallback?.(raf);else cancelAnimationFrame(raf);stream?.getTracks().forEach(t=>t.stop());stream=null;cameraReady=false;lastPoseAt=0;trackingPanel.hidden=true;$('#tracking-rejection').hidden=true;repFeedbackUntil=0;$('#camera').srcObject=null;$('#camera').hidden=true;$('#pose-overlay').hidden=true;$('#camera-placeholder').hidden=false;$('#camera-off').hidden=true;$('#flip-camera').hidden=true;$('#form-feedback').hidden=true;$('#rep-hud').hidden=true;$('#live-status').innerHTML='<span></span> CAMERA OFF';}
function confirmRanked(){dialog(`<p class="eyebrow">${label(mode).toUpperCase()} · RANKED</p><h2>ONE ROUND. MAKE IT COUNT.</h2><p>The clock starts after a 4-second countdown. You get one 60-second attempt. Reloading or closing the page ends your attempt.</p><p>${mode==='pushup'?'Keep both shoulders visible.':'Keep your whole body visible.'} Only complete reps count. Stop if you feel pain or dizziness.</p><button class="primary-btn" id="confirm-round">I'M READY · START ROUND →</button>`);$('#confirm-round').onclick=()=>{closeDialog();action(()=>startRound());};}
async function startRound(){
 if(activeLive())return readyDuel();
 if(capturePosition)throw new Error('Finish saving your shoulder position first.');
 if(running||loadingCamera||startingRound)return;if(!stream){await enableCamera();notify('Camera is ready. Check your position, then start your round.');return;}
 if(mode==='pushup'&&(!cameraReady||!counter.calibrated||performance.now()-lastPoseAt>500))throw new Error('Set both shoulder heights or do one setup rep, then return to the top until you see “Front view ready”.');
 if(!data)throw new Error('Connect to the arena before starting a saved round.');if(pending)throw new Error('Save your previous round before starting another.');
 startingRound=true;$('#start-round').disabled=true;$('#camera-off').disabled=true;$('#flip-camera').disabled=true;
 try{const result=await api('sessions/start',{exercise:mode,match:selectedMatch});round={...result,start:performance.now()+result.startsIn,exercise:mode,match:selectedMatch};running=true;demo=false;counter.reset(true);$('#camera-off').disabled=true;$('#flip-camera').disabled=true;$$('[data-mode]').forEach(e=>e.disabled=true);$('#queue-btn').disabled=true;$('#countdown').hidden=false;$('#time-left').textContent='60';$('#rep-count').textContent='00';timer=setInterval(tick,80);tick();if(navigator.wakeLock?.request)navigator.wakeLock.request('screen').then(lock=>{if(running)wakeLock=lock;else lock.release();}).catch(()=>{});}
 finally{startingRound=false;if(!running){$('#start-round').disabled=false;$('#camera-off').disabled=false;$('#flip-camera').disabled=false;}}
}
function roundElapsed(){return round?.live?live.serverNow()-live.room.startsAt:performance.now()-round.start;}
function tick(){const elapsed=roundElapsed();if(elapsed<0){$('#countdown').textContent=Math.ceil(-elapsed/1000);if(round.live)$('#duel-clock').textContent='00:'+String(Math.ceil(-elapsed/1000)).padStart(2,'0');return;}$('#countdown').hidden=true;$('#time-left').textContent=String(Math.max(0,Math.ceil((60000-elapsed)/1000)));if(round.live)$('#duel-clock').textContent='00:'+String(Math.max(0,Math.ceil((60000-elapsed)/1000))).padStart(2,'0');
 if(demo){$('#rep-count').textContent=String(Math.min(24,Math.floor(elapsed/2400))).padStart(2,'0');$('#form-feedback').textContent=['Lower with control','Depth reached · return to extension','Rep counted'][Math.floor(elapsed/800)%3];}
 if(elapsed>=60000)finishRound();
}
async function finishRound(aborted=false){if(round?.live){if(liveLocalDone)return;liveLocalDone=true;clearInterval(timer);running=false;releaseWakeLock();$('#countdown').hidden=true;$('#time-left').textContent='0';$('#duel-clock').textContent='00:00';$('#duel-status').textContent=aborted?'Tracking interrupted. Your accepted reps are preserved.':'Round over. Confirming both scores…';stopCamera();await live.sync(aborted?{leave:true}:{finished:true}).catch(()=>{});return;}clearInterval(timer);running=false;wakeLock?.release().catch(()=>{});wakeLock=null;$('#countdown').hidden=true;$('#start-round').disabled=false;$('#camera-off').disabled=false;$('#flip-camera').disabled=false;$$('[data-mode]').forEach(e=>e.disabled=false);
 if(demo){demo=false;$('#demo-label').hidden=true;$('#rep-hud').hidden=true;$('#form-feedback').hidden=true;$('#camera-placeholder').hidden=false;$('#live-status').innerHTML='<span></span> CAMERA OFF';dialog('<p class="eyebrow">DEMO COMPLETE</p><h2>THAT’S THE ROUND.</h2><p>That was a simulated 60-second round. No session, rank, or reward was changed. Enable your camera to count your own reps.</p><button class="primary-btn" id="demo-done">BACK TO THE ARENA →</button>');$('#demo-done').onclick=closeDialog;render();return;}
 if(aborted){notify('Round interrupted. No score was submitted.');render();return;}
 pending={id:round.id,events:counter.events.filter(e=>e.t<=60000),exercise:round.exercise,match:round.match};try{sessionStorage.setItem('rep-arena-pending',JSON.stringify(pending));}catch{}await saveRound();
}
async function saveRound(){if(!pending)return;try{const result=await api('sessions/finish',{id:pending.id,events:pending.events});const wasMatch=pending.match;pending=null;try{sessionStorage.removeItem('rep-arena-pending');}catch{}selectedMatch=null;$('#round-kind').textContent='PRACTICE';$('#round-note').textContent='Full range. Every rep.';await refresh();dialog(`<p class="eyebrow">ROUND COMPLETE</p><h2 class="result-number">${result.reps}<span>CLEAN REPS</span></h2><p>${wasMatch?'Your attempt is submitted. See your match card for the result or your rival’s progress.':'Saved to your history. '+(result.reps>=5?'Today counts toward your next shield.':'Five reps in a round count toward an active day.')}</p><button class="primary-btn" id="result-done">BACK TO THE ARENA →</button>`);$('#result-done').onclick=closeDialog;
 }catch(e){dialog(`<p class="eyebrow">YOUR ROUND IS STILL HERE</p><h2>SAVE NEEDS A RETRY.</h2><p>${esc(e.message)}</p><p>Your ${pending.events.length} reps are held in this tab. Retry within 10 minutes of the round starting.</p><button class="primary-btn" id="retry-save">RETRY SAVE</button><button class="text-btn" id="discard-save">DISCARD UNSAVED ROUND</button>`);$('#retry-save').onclick=()=>{closeDialog();saveRound();};$('#discard-save').onclick=()=>{pending=null;sessionStorage.removeItem('rep-arena-pending');closeDialog();render();};}
}
function startDemo(){if(running||loadingCamera||startingRound||activeLive())return;stopCamera();demo=true;running=true;round={start:performance.now()+3000};$('#camera-placeholder').hidden=true;$('#rep-hud').hidden=false;$('#form-feedback').hidden=false;$('#countdown').hidden=false;$('#demo-label').hidden=false;$('#start-round').disabled=true;$$('[data-mode]').forEach(e=>e.disabled=true);$('#live-status').innerHTML='<span></span> DEMO ROUND';timer=setInterval(tick,80);tick();}
function showProfile(){if(!data){notify('Connect to the arena to edit your profile.');return;}dialog(`<p class="eyebrow">YOUR ATHLETE PROFILE</p><h2>MAKE A NAME.</h2><form id="profile-form"><label for="athlete-name">Display name</label><input id="athlete-name" minlength="2" maxlength="30" required value="${esc(data.me.name)}"><label for="athlete-handle">Unique handle</label><input id="athlete-handle" minlength="3" maxlength="24" pattern="[a-z0-9_-]+" required value="${esc(data.me.handle)}"><p class="small-note">Lowercase letters, numbers, underscores and hyphens. Friends find you by this handle.</p><button class="primary-btn">SAVE PROFILE →</button></form>`);$('#profile-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('profile',{name:$('#athlete-name').value,handle:$('#athlete-handle').value});closeDialog();await refresh();notify('Profile saved.');});};}
function showGuide(){dialog(`<p class="eyebrow">CAMERA COUNTING GUIDE</p><h2>FACE YOUR PHONE.</h2><ol class="rules-list"><li><strong>Push-ups:</strong> prop your phone in front of you, tilted toward your upper body. Keep both shoulders visible; elbows and hands are not required.</li><li>Hold the top, then do one full practice rep. Return to the top and wait for <strong>FRONT VIEW READY</strong> before starting. That setup rep does not score.</li><li>Lower your shoulders. Press back up to the top. The score changes as soon as a complete cycle is detected.</li><li>The counter learns your range from the practice rep. Shallow movements do not count. Brief tracking glitches pause feedback; longer gaps cancel the unfinished rep. Return to the top to continue. If you move the phone, turn the camera off and on to repeat setup.</li><li><strong>Squats:</strong> use a side view at hip height with your whole body visible. Bend your knees, then stand fully upright.</li></ol><p class="small-note">Shoulder-only mode measures motion, not push-up form. Other up-and-down movements can also count. Try practice first. Video stays on your device. Stop if you feel pain or dizziness.</p><button class="primary-btn" id="guide-done">GOT IT →</button>`);$('#guide-done').onclick=closeDialog;}
function notify(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4200);}
async function api(path,body){const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});let result;try{result=await r.json();}catch{throw new Error('Arena connection unavailable. Please try again.');}if(!r.ok)throw Object.assign(new Error(result.error||'Please try again.'),{status:r.status,code:result.code});return result;}
async function refresh(silent=false){if(refreshing)return;refreshing=true;try{data=await api('state');connected=true;$('#service-message').hidden=true;render();}catch(e){connected=false;renderLobby();if(!silent||e.code==='LOCAL_JOIN_REQUIRED'){$('#service-message').hidden=false;$('#service-message').innerHTML=`${esc(e.message)} ${e.code==='LOCAL_JOIN_REQUIRED'?'<a href="/local/join">Join local room</a>':e.status===401?'<a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in</a>':'<button id="retry-connection">RETRY</button>'}`;$('#retry-connection')?.addEventListener('click',()=>refresh());}}finally{refreshing=false;}}
async function action(fn){try{await fn();}catch(e){notify(e.message);}}
function dialog(html){$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();}
function closeDialog(){$('#modal').close();}
function navigate(next){if(!['arena','ranks','friends','history','session'].includes(next))throw new Error('Unknown view.');if(next!=='session'&&view==='session'&&(running||startingRound||loadingCamera||activeLive()))throw new Error(activeLive()?'Use Leave duel before returning to the lobby.':'Finish your round before leaving.');if(next!=='session'&&stream)stopCamera();view=next;$$('.view').forEach(e=>e.hidden=e.id!==next+'-view');$$('.nav-item').forEach(e=>{const selected=e.dataset.view===(next==='session'?'arena':next);e.classList.toggle('active',selected);if(selected)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});if(next==='ranks')loadLeaderboard();history.replaceState(null,'','#'+next);window.scrollTo({top:0,behavior:'smooth'});}
function setMode(next){if(!['pushup','squat'].includes(next))throw new Error('Unknown exercise.');if(running||loadingCamera||startingRound||activeLive())throw new Error('Finish or leave the current round before switching exercises.');mode=next;counter=new RepCounter(mode);selectedMatch=null;$$('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode));});$('#round-kind').textContent='PRACTICE';$('#round-note').textContent='Full range. Every rep.';$('#rep-count').textContent='00';render();if(view==='ranks')loadLeaderboard();}
function ladder(){return data?.ladders.find(l=>l.exercise===mode)||{rating:600,wins:0,losses:0,draws:0,best:0,shields:0,earned:0};}
function renderLobby(){
 const me=data?.me,friend=data?.friends.find(f=>f.id===friendSelection&&f.status==='accepted');
 if(friendSelection&&!friend)friendSelection=null;
 $('#lobby-name').textContent=me?.name||'YOUR ATHLETE';$('#lobby-handle').textContent=me?'@'+me.handle:'Create your player profile to get started';
 $('#lobby-avatar').textContent=me?me.name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase():'RA';
 $('#selected-friend-name').textContent=friend?.name||'Invite a friend';
 $('#lobby-connection').textContent=connected?'CONNECTED':'CONNECTING…';
 $('#lobby-connection').classList.toggle('is-offline',!connected);
 $('#launch-mode').value=playMode;
 $('#mode-description').textContent=playMode==='live'?'Find a rival. Ready up together. Most reps in 60 seconds wins.':playMode==='friend'?'Invite a friend to a live 60-second duel. Both players must be here.':'A solo 60-second set. Check your camera and count reps without risking rank.';
 const rooms=(data?.liveRooms||[]).filter(r=>!['complete','cancelled','void'].includes(r.phase)),own=rooms.find(r=>r.exercise===mode&&(r.phase!=='invited'||r.isHost));
 $('#lobby-player-status').textContent=own?(own.phase==='queued'?'Finding an opponent':own.phase==='invited'?'Invitation sent':'Duel in progress'):'Choose your exercise. Make it count.';
 $('#queue-btn').disabled=queueing||!connected||running||startingRound;
 $('#queue-btn').textContent=queueing?'CONNECTING…':own&&playMode!=='practice'?'RETURN TO DUEL →':'START →';
 $('#launch-hint').textContent=own&&playMode!=='practice'?'Your duel is waiting. Rejoin to continue.':playMode==='friend'?(friend?'Challenge '+friend.name:'Choose a friend with the + invite button.'):'Camera setup comes next. You control when it turns on.';
 $('#active-matches').innerHTML=rooms.map(liveCard).join('')+(data?.matches||[]).filter(m=>!m.isLive&&['queued','active'].includes(m.status)&&m.exercise===mode).map(matchMarkup).join('');
}
function liveCard(room){
 const terminal=['complete','cancelled','void'].includes(room.phase),result=room.result;
 let detail=room.phase==='queued'?'Finding an opponent for '+label(room.exercise).toLowerCase()+'.':room.phase==='invited'?(room.isHost?'Waiting for your friend to accept.':'A friend invited you to a live duel.'):room.phase==='preparing'?'Check your camera, then both tap Ready.':room.phase==='countdown'?'Both ready. The shared countdown has started.':room.phase==='running'?'Live round in progress.':room.phase==='finishing'?'Confirming the final scores.':result?`${room.ownReps} – ${room.opponentReps} reps · ${result.delta>=0?'+':''}${result.delta||0} rating${result.reason?' · '+result.reason:''}`:'Duel closed. No rank change.';
 return `<article class="match-card"><div><p class="eyebrow">${label(room.exercise).toUpperCase()} · LIVE 1V1</p><h3>${room.opponent?'You vs. '+esc(room.opponent.name):'Finding your rival'}</h3><p>${esc(detail)}</p></div><div class="match-actions">${terminal?`<span class="result-chip">${result?.outcome==='win'?'VICTORY':result?.outcome==='loss'?'DEFEAT':result?.outcome==='draw'?'DRAW':'NO CONTEST'}</span>`:room.phase==='invited'&&!room.isHost?`<button class="primary-btn" data-accept-live="${esc(room.id)}">ACCEPT</button><button class="inline-btn" data-decline-live="${esc(room.id)}">DECLINE</button>`:`<button class="primary-btn" data-open-live="${esc(room.id)}">${room.phase==='queued'?'VIEW SEARCH':'OPEN DUEL'} →</button>`}</div></article>`;
}
function chooseFriend(){
 if(!connected)throw new Error('Connect to the arena first.');if(activeLive())throw new Error('Leave the current duel before inviting someone else.');
 const friends=data.friends.filter(f=>f.status==='accepted');
 dialog(`<p class="eyebrow">YOUR DUEL PARTNER</p><h2>INVITE A FRIEND</h2><p>Choose your rival, then press START in the lobby.</p>${friends.length?friends.map(f=>`<button class="friend-pick secondary-btn" data-pick-friend="${esc(f.id)}">${esc(f.name)} <small>@${esc(f.handle)}</small></button>`).join(''):'<p>No friends added yet. Add your friend by their athlete handle.</p>'}<button class="text-btn" id="manage-friends">${friends.length?'ADD ANOTHER FRIEND':'ADD A FRIEND'} →</button>`);
 $('#manage-friends').onclick=()=>{closeDialog();navigate('friends');};
}
function openPractice(simulate=false){
 if(running||startingRound||loadingCamera||activeLive())throw new Error('Finish or leave your current round first.');
 live.stop();live.room=null;round=null;liveLocalDone=false;selectedMatch=null;counter=new RepCounter(mode);
 $('#session-title').textContent=label(mode).toUpperCase()+' PRACTICE';$('#session-subtitle').textContent=placement();setupCameraCopy();
 $('#live-duel-panel').hidden=true;$('#start-round').hidden=false;$('#start-round').disabled=false;$('#demo-session').hidden=false;
 $('#round-kind').textContent='PRACTICE';$('#round-note').textContent='Solo training · no rating change';$('#rep-count').textContent='00';$('#time-left').textContent='60';
 navigate('session');if(simulate)startDemo();
}
async function launch(){
 if(queueing)return;if(!connected)throw new Error('Connect to the arena first.');
 if(playMode==='practice'){openPractice();return;}
 const current=(data.liveRooms||[]).find(r=>r.exercise===mode&&!['complete','cancelled','void'].includes(r.phase)&&(r.phase!=='invited'||r.isHost));
 if(current){openDuel(current);return;}
 if(pending)throw new Error('Save or discard your previous round before entering a duel.');
 if(playMode==='friend'&&!friendSelection){chooseFriend();return;}
 queueing=true;renderLobby();
 try{const response=await api(playMode==='friend'?'live/invite':'live/queue',{exercise:mode,...(playMode==='friend'?{friend:friendSelection}:{})});openDuel(response.room);await refresh();}
 finally{queueing=false;renderLobby();}
}
function openDuel(room){
 if(running||startingRound||loadingCamera)throw new Error('Finish your current round first.');
 if(activeLive()&&live.room.id!==room.id)throw new Error('Leave your current duel first.');
 live.stop();live.room=null;setMode(room.exercise);liveLocalDone=false;liveResultShown=null;round=null;counter=new RepCounter(mode);
 if(!stream)stopCamera();$('#time-left').textContent='60';$('#rep-count').textContent='00';
 $('#live-duel-panel').hidden=false;$('#start-round').hidden=true;$('#demo-session').hidden=true;
 $('#session-title').textContent=label(mode).toUpperCase()+' DUEL';$('#session-subtitle').textContent=placement()+' Both players tap Ready to start together.';setupCameraCopy();
 $('#round-kind').textContent='LIVE 1V1';$('#round-note').textContent='Shared clock · 60 seconds';navigate('session');live.open(room);
}
function releaseWakeLock(){wakeLock?.release().catch(()=>{});wakeLock=null;}
function holdWakeLock(){if(navigator.wakeLock?.request)navigator.wakeLock.request('screen').then(lock=>{if(running)wakeLock=lock;else lock.release();}).catch(()=>{});}
function paintDuel(){
 const room=live.room;if(!room)return;const phase=room.phase;
 $('#duel-own-name').textContent=data?.me.name||'You';$('#duel-opponent-name').textContent=room.opponent?.name||'Waiting for a rival';
 $('#duel-own-reps').textContent=running&&round?.live?Math.max(counter.count,room.ownReps):room.ownReps;$('#duel-opponent-reps').textContent=room.opponentReps;
 const messages={queued:'Looking for another athlete. You can cancel at any time.',invited:'Invitation sent. Waiting for your friend to accept.',preparing:room.ownReady?(room.opponentReady?'Both ready. Starting together…':'You are ready. Waiting for your rival.'):(room.opponentReady?'Your rival is ready. Check your camera, then tap Ready.':'Both players need their cameras ready before the countdown.'),countdown:'Both ready. Get into position!',running:room.opponentConnected?'LIVE · Your rival’s score updates throughout the round.':'Your rival is reconnecting. The clock continues.',finishing:'Round over. Confirming both scores…',complete:'Round complete.',cancelled:'Duel cancelled. No rank change.',void:'No contest. No rank change.'};
 $('#duel-status').textContent=messages[phase]||'Connecting…';
 $('#duel-ready').hidden=phase!=='preparing';$('#duel-ready').disabled=loadingCamera||(!room.ownReady&&!room.canReady);$('#duel-ready').textContent=room.ownReady?'CANCEL READY':!stream?'ENABLE CAMERA':mode==='pushup'&&!cameraReady?'COMPLETE CAMERA SETUP':'READY';
 const locked=['countdown','running','finishing'].includes(phase)||room.ownReady;
 $('#camera-off').disabled=locked||loadingCamera;$('#flip-camera').disabled=locked||loadingCamera;
 $('#duel-leave').hidden=live.terminal();$('#duel-leave').textContent=phase==='running'?'LEAVE DUEL':'CANCEL DUEL';
 if(!running)$('#duel-clock').textContent=phase==='finishing'||live.terminal()?'00:00':'01:00';
}
function updateDuel(room){
 if(data){data.liveRooms=[room,...(data.liveRooms||[]).filter(r=>r.id!==room.id)];}paintDuel();
 if(['countdown','running'].includes(room.phase)&&!round?.live&&!liveLocalDone){
  const now=live.serverNow();round={id:room.sessionId,exercise:room.exercise,match:room.id,live:true,start:performance.now()+room.startsAt-now};
  counter.reset(true);counter.events=(room.ownEvents||[]).map(e=>({...e}));counter.count=counter.events.length;counter.last=counter.events.at(-1)?.t||0;
  running=true;demo=false;$('#rep-count').textContent=String(counter.count).padStart(2,'0');$('#countdown').hidden=now>=room.startsAt;$$('[data-mode]').forEach(b=>b.disabled=true);
  clearInterval(timer);timer=setInterval(tick,80);tick();holdWakeLock();
 }
 if(room.phase==='finishing'&&!liveLocalDone&&round?.live){void finishRound();}
 if(live.terminal(room)){
  clearInterval(timer);running=false;releaseWakeLock();stopCamera();$('#countdown').hidden=true;$$('[data-mode]').forEach(b=>b.disabled=false);$('#camera-off').disabled=false;$('#flip-camera').disabled=false;
  if(liveResultShown!==room.id){liveResultShown=room.id;const r=room.result,title=r?.outcome==='win'?'VICTORY':r?.outcome==='loss'?'GOOD FIGHT':r?.outcome==='draw'?'IT’S A DRAW':room.phase==='cancelled'?'DUEL CANCELLED':'NO CONTEST';dialog(`<p class="eyebrow">${label(room.exercise).toUpperCase()} · LIVE 1V1</p><h2>${title}</h2><div class="duel-result-score">${room.ownReps} <span>–</span> ${room.opponentReps}</div><p>${esc(r?.reason||'The room has closed.')}</p>${r&&room.phase==='complete'?`<p>${r.delta>=0?'+':''}${r.delta} rating${r.saved?' · shield saved '+r.saved+' points':''}</p>`:''}<button class="primary-btn" id="duel-result-done">BACK TO LOBBY →</button>`);$('#duel-result-done').onclick=()=>{closeDialog();live.stop();live.room=null;round=null;liveLocalDone=false;navigate('arena');refresh();};void refresh();}
 }
 renderLobby();
}
function liveConnectionError(error){$('#duel-status').textContent='Connection interrupted. Reconnecting… The match clock keeps running.';if(error.status===401){live.stop();notify('Your login expired. Rejoin the local room.');}}
async function readyDuel(){
 if(capturePosition)throw new Error('Finish saving your shoulder position first.');
 if(!activeLive()||live.room.phase!=='preparing')return;
 if(live.room.ownReady){await live.sync({ready:false});return;}
 if(!stream){await enableCamera();notify('Camera ready. Check your position, then tap Ready.');paintDuel();return;}
 if(mode==='pushup'&&(!cameraReady||!counter.calibrated||performance.now()-lastPoseAt>500))throw new Error('Do one full practice rep, then return to the top until you see “Front view ready”.');
 await live.sync({ready:true});
}
function leaveDuel(){
 if(!activeLive())return;const inRound=live.room.startsAt&&live.serverNow()>=live.room.startsAt;
 dialog(`<p class="eyebrow">LIVE 1V1</p><h2>${inRound?'LEAVE THIS DUEL?':'CANCEL THIS DUEL?'}</h2><p>${inRound?'Leaving now counts as a forfeit. Your opponent will win.':'The round has not started. Cancelling will not change either rating.'}</p><button class="primary-btn" id="confirm-leave-duel">${inRound?'LEAVE & FORFEIT':'CANCEL DUEL'}</button><button class="text-btn" id="stay-duel">STAY HERE</button>`);
 $('#stay-duel').onclick=closeDialog;$('#confirm-leave-duel').onclick=()=>action(async()=>{closeDialog();await live.sync({leave:true});});
}
function render(){
 renderLobby();
 const l=ladder(),r=rank(l.rating),games=l.wins+l.losses+l.draws,days=(data?.activity||[]).filter(d=>d.exercise===mode).length;
 $('#rank-card').innerHTML=`<div class="rank-topline"><span>YOUR ${mode==='pushup'?'PUSH-UP':'SQUAT'} RANK</span><span>↗</span></div><div class="rank-emblem"><span class="emblem-wings" style="--rank-color:${r.color}">${games<5?'?':r.name.slice(0,1)}</span></div><h2>${games<5?'PLACEMENTS':r.name.toUpperCase()}</h2><p class="rating">${l.rating} <span>RATING</span></p><div class="progress-track"><span style="width:${games<5?games/5*100:r.progress}%"></span></div><div class="progress-label"><span>${games<5?games+' / 5 MATCHES':r.name.toUpperCase()}</span><span>${games<5?'FIND YOUR STARTING RANK':r.next?r.next.min+' TO '+r.next.name.toUpperCase():'TOP TIER'}</span></div><div class="protection"><div class="shield-icon" aria-hidden="true">◇</div><div><strong>${l.shields?'RANK SHIELD READY':'BUILD YOUR RANK SHIELD'}</strong><p>${l.shields?'Automatically cushions your next rated loss.':Math.max(0,5-(days-l.earned*5))+' active days until your next shield.'}</p></div><span class="charge">${l.shields}/2</span></div><div class="rank-stats"><div><small>WINS</small><strong>${l.wins}</strong></div><div><small>WIN RATE</small><strong>${games?Math.round(l.wins/games*100)+'%':'—'}</strong></div><div><small>BEST SET</small><strong>${l.best}</strong></div></div><button class="secondary-btn" data-view-jump="ranks">VIEW RANK PATH ↗</button>`;
 const now=new Date(),monday=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);const start=monday.toISOString().slice(0,10),weekly=new Set((data?.activity||[]).filter(d=>d.day>=start).map(d=>d.day)).size;
 $('#active-days').textContent=weekly+' / 5';$('#activity-progress').textContent=Math.min(5,Math.max(0,days-l.earned*5))+' / 5';
 $('#reward-summary').innerHTML=`<div class="week-days">${Array.from({length:7},(_,i)=>{const dt=new Date(monday);dt.setUTCDate(dt.getUTCDate()+i);const active=(data?.activity||[]).some(d=>d.exercise===mode&&d.day===dt.toISOString().slice(0,10));return `<div class="${active?'done':''}"><span>${['M','T','W','T','F','S','S'][i]}</span><strong>${active?'✓':'·'}</strong></div>`;}).join('')}</div><div class="mission"><span class="check">◇</span><div><strong>Five days. One safety net.</strong><small>5+ reps counts a day · ${label(mode).toLowerCase()}</small></div><b>1 SHIELD</b></div><p class="small-note">Progress carries over. Max one earned each week; max two held. Weeks use UTC.</p>`;
 if(!data){$('#friend-preview').innerHTML=empty('Your circle starts here.','Add friends to send a 60-second challenge.');return;}
 $('#profile-name').textContent=data.me.name.toUpperCase();$('#avatar').textContent=data.me.name.split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();$('#profile-rank').textContent=games<5?'PLACEMENTS':r.name.toUpperCase();$('#own-handle').textContent='@'+data.me.handle;
 const friends=data.friends.filter(f=>f.status==='accepted'),requests=data.friends.filter(f=>f.status==='pending');$('#friend-count').textContent=requests.filter(f=>f.incoming).length||'';
 const friendMarkup=f=>`<div class="friend"><span class="avatar blue">${esc(f.name.slice(0,2).toUpperCase())}</span><div><strong>${esc(f.name)}</strong><small>@${esc(f.handle)}</small></div><button data-challenge="${esc(f.id)}">CHALLENGE</button></div>`;
 $('#friend-preview').innerHTML=friends.length?friends.slice(0,3).map(friendMarkup).join(''):empty('Your circle starts here.','Add a friend. Settle it on the floor.')+'<button class="secondary-btn" data-view-jump="friends">FIND YOUR FRIENDS →</button>';
 $('#friends-list').innerHTML=friends.length?friends.map(f=>`<div class="friends-card">${friendMarkup(f)}<button class="text-btn" data-remove-friend="${esc(f.id)}">Remove friend</button></div>`).join(''):empty('No rivals yet.','Send your first friend request above.');$('#total-friends').textContent=friends.length+' ATHLETES';
 $('#friend-requests').innerHTML=requests.length?requests.map(f=>`<div class="request-row"><div><strong>${esc(f.name)}</strong><small>@${esc(f.handle)} · ${f.incoming?'Wants to be friends':'Request sent'}</small></div><div>${f.incoming?`<button class="primary-btn compact" data-accept-friend="${esc(f.id)}">ACCEPT</button>`:''}<button class="inline-btn" data-remove-friend="${esc(f.id)}">${f.incoming?'DECLINE':'CANCEL'}</button></div></div>`).join(''):empty('All caught up.','Friend requests will appear here.');
 $('#friend-challenges').innerHTML=(data.liveRooms||[]).filter(m=>!['queued','complete','cancelled','void'].includes(m.phase)).map(liveCard).join('')+data.matches.filter(m=>!m.isLive&&(m.status==='invited'||m.status==='active')).map(matchMarkup).join('')||empty('No pending challenges.','Invite a friend from the lobby for a live duel.');
 $('#rank-path').innerHTML=TIERS.map(t=>`<div class="rank-stop ${t.name===r.name?'current':''}"><div class="rank-glyph" style="color:${t.color}">◇</div><strong>${t.name.toUpperCase()}</strong><small>${t.min}+ RP</small></div>`).join('');
 const completed=data.sessions.filter(s=>s.status==='complete'),total=data.stats.reps,allDays=new Set(data.activity.map(d=>d.day)).size,allWins=data.ladders.reduce((a,l)=>a+l.wins,0);
 $('#milestones').innerHTML=[['FIRST REP','Complete your first camera round',data.stats.sessions>0],['REGULAR','Train on 5 different days',allDays>=5],['FIRST VICTORY','Win your first ranked round',allWins>=1],['CENTURY CLUB','Log 100 lifetime camera-counted reps',total>=100]].map(([title,copy,earned])=>`<article class="milestone ${earned?'earned':''}"><span>${earned?'✓':'◇'}</span><strong>${title}</strong><p>${copy}</p><small>${earned?'EARNED':'IN PROGRESS'}</small></article>`).join('');
 $('#history-stats').innerHTML=[['LIFETIME REPS',total],['ACTIVE DAYS',allDays],['PUSH-UP BEST',data.ladders.find(l=>l.exercise==='pushup')?.best||0],['SQUAT BEST',data.ladders.find(l=>l.exercise==='squat')?.best||0]].map(([k,v])=>`<div><small>${k}</small><strong>${v}</strong></div>`).join('');
 const recentLive=new Set((data.liveRooms||[]).map(m=>m.id));
 $('#match-history').innerHTML=(data.liveRooms||[]).filter(m=>['complete','void'].includes(m.phase)).map(liveCard).join('')+data.matches.filter(m=>(!m.isLive||!recentLive.has(m.id))&&!['queued','active','invited'].includes(m.status)).map(matchMarkup).join('')||empty('Your record is a clean slate.','Complete a ranked challenge to see its result here.');
 $('#session-history').innerHTML=completed.length?`<div class="table-wrap"><table><thead><tr><th>EXERCISE</th><th>DATE</th><th>ROUND</th><th>REPS</th></tr></thead><tbody>${completed.map(s=>`<tr><td>${label(s.exercise)}</td><td>${date(s.started)}</td><td>${s.match?'Ranked':'Practice'}</td><td class="acid">${s.reps}</td></tr>`).join('')}</tbody></table></div><p class="small-note">Showing up to 40 recent sessions. Personal bests and active days include your full history.</p>`:empty('The next set is yours.','Enable your camera and complete a practice round.');
}
function matchMarkup(m){const complete=m.status==='complete';return `<article class="match-card"><div><p class="eyebrow">${label(m.exercise).toUpperCase()} · ${m.status==='queued'?'OPEN QUEUE':m.status.toUpperCase()}</p><h3>${m.opponent?'You vs. '+esc(m.opponent):'Waiting for your next rival'}</h3><p>${complete?`${m.ownScore} — ${m.opponentScore} reps · ${m.delta>=0?'+':''}${m.delta} rating${m.saved?' · shield saved '+m.saved+' points':''}`:m.status==='active'?(m.ownScore!==null?'Your round is submitted. Opponent score stays hidden until both finish.':m.opponentSubmitted?'Your rival has submitted. Your score is still yours to earn.':'One 60-second attempt each. Complete yours before '+date(m.expires)+'.'):m.status==='invited'?(m.isChallenger?'Challenge sent. Waiting for acceptance.':'You have been challenged.'):m.status==='queued'?'Matched within 300 rating points. Practice while you wait.':'No rating change.'}</p></div><div class="match-actions">${m.status==='active'&&m.ownScore===null?`<button class="primary-btn" data-play-match="${m.id}">PLAY YOUR ROUND →</button>`:''}${m.status==='invited'&&!m.isChallenger?`<button class="primary-btn" data-accept-match="${m.id}">ACCEPT</button>`:''}${['queued','invited'].includes(m.status)?`<button class="inline-btn" data-cancel-match="${m.id}">${m.isChallenger?'CANCEL':'DECLINE'}</button>`:''}${complete?`<span class="result-chip">${m.ownScore===m.opponentScore?'DRAW':m.ownScore>m.opponentScore?'VICTORY':'DEFEAT'}</span>`:''}</div></article>`;}
async function loadLeaderboard(){try{const rows=await api('leaderboard?exercise='+mode);$('#leaderboard').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>PLACE</th><th>ATHLETE</th><th>RANK</th><th>RECORD</th><th>RATING</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td><strong>${esc(r.name)}</strong><small>@${esc(r.handle)}</small></td><td>${r.wins+r.losses+r.draws<5?'Placement':rank(r.rating).name}</td><td>${r.wins}W / ${r.losses}L / ${r.draws}D</td><td class="acid">${r.rating}</td></tr>`).join('')}</tbody></table></div>`:empty('First on the floor.','The leaderboard begins when the first ranked round is completed.');}catch(e){$('#leaderboard').innerHTML=empty('Leaderboard unavailable',esc(e.message));}}

document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const d=b.dataset;action(async()=>{
 if(d.view||d.viewJump)navigate(d.view||d.viewJump);if(d.mode)setMode(d.mode);
 if(d.pickFriend){friendSelection=d.pickFriend;playMode='friend';closeDialog();navigate('arena');renderLobby();}
 if(d.openLive){const room=data.liveRooms?.find(r=>r.id===d.openLive);if(room)openDuel(room);}
 if(d.acceptLive){if(running||activeLive())throw new Error('Finish or leave your current round first.');const response=await api('live/respond',{id:d.acceptLive,accept:true});openDuel(response.room);await refresh();}
 if(d.declineLive){await api('live/respond',{id:d.declineLive,accept:false});await refresh();}
 if(d.acceptFriend){await api('friends/respond',{id:d.acceptFriend,action:'accept'});await refresh();notify('Friend added.');}
 if(d.removeFriend){const f=data.friends.find(f=>f.id===d.removeFriend);if(f?.status==='accepted'){dialog(`<p class="eyebrow">YOUR CIRCLE</p><h2>REMOVE ${esc(f.name.toUpperCase())}?</h2><p>You can send a new request later.</p><button class="primary-btn" id="confirm-remove">REMOVE FRIEND</button>`);$('#confirm-remove').onclick=()=>action(async()=>{await api('friends/respond',{id:f.id,action:'remove'});closeDialog();await refresh();});}else{await api('friends/respond',{id:d.removeFriend,action:'remove'});await refresh();}}
 if(d.challenge){if(activeLive())throw new Error('Leave the current duel first.');friendSelection=d.challenge;playMode='friend';navigate('arena');renderLobby();notify('Friend selected. Choose your exercise, then press START.');}
 if(d.acceptMatch){await api('matches/respond',{id:d.acceptMatch,action:'accept'});await refresh();notify('Challenge accepted. Your round is ready.');}
 if(d.cancelMatch){await api('matches/respond',{id:d.cancelMatch,action:'cancel'});await refresh();}
 if(d.playMatch){const m=data.matches.find(m=>m.id===d.playMatch);if(m.isLive)throw new Error('Open the live duel from your lobby.');setMode(m.exercise);openPractice();selectedMatch=m.id;$('#round-kind').textContent='LEGACY CHALLENGE';$('#round-note').textContent='VS. '+m.opponent;$('#session-title').textContent='COMPLETE YOUR CHALLENGE';notify('Previous challenge selected. Check your camera, then start.');}
});});
$('#enable-camera').onclick=()=>action(enableCamera);
$('#camera-off').onclick=()=>{if(!running&&!startingRound&&!loadingCamera&&!live.room?.ownReady){stopCamera();if(activeLive())paintDuel();}};
const flipButton=document.createElement('button');flipButton.id='flip-camera';flipButton.className='camera-flip';flipButton.textContent='SWITCH CAMERA';flipButton.hidden=true;$('#camera-off').after(flipButton);
flipButton.onclick=()=>action(async()=>{if(running||loadingCamera||startingRound||live.room?.ownReady)return;cameraFacing=cameraFacing==='user'?'environment':'user';stopCamera();await enableCamera();});
$('#demo-session').onclick=startDemo;
$('#start-round').onclick=()=>action(async()=>{if(selectedMatch&&stream)confirmRanked();else await startRound();});
$('#queue-btn').onclick=()=>action(launch);
$('#launch-mode').onchange=e=>{if(activeLive()){e.target.value=playMode;notify('Leave your duel before changing the mode.');return;}playMode=e.target.value;renderLobby();};
$('#invite-slot').onclick=()=>action(chooseFriend);
$('#lobby-help').onclick=showGuide;
$('#lobby-demo').onclick=()=>action(()=>openPractice(true));
$('#duel-ready').onclick=()=>action(readyDuel);$('#duel-leave').onclick=leaveDuel;
$('#back-lobby').onclick=()=>action(()=>{if(activeLive()){leaveDuel();return;}if(demo){clearInterval(timer);running=false;demo=false;$('#demo-label').hidden=true;$('#countdown').hidden=true;$('#start-round').disabled=false;$$('[data-mode]').forEach(b=>b.disabled=false);stopCamera();}navigate('arena');renderLobby();});
$('#profile-btn').onclick=showProfile;$('#counting-guide').onclick=showGuide;$('#refresh-leaderboard').onclick=loadLeaderboard;$('.modal-close').onclick=closeDialog;
$('#friend-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('friends/request',{handle:$('#friend-handle').value});$('#friend-handle').value='';await refresh();notify('Friend request sent.');});};
$('#copy-handle').onclick=()=>action(async()=>{if(!data)throw new Error('Connect to the arena first.');await navigator.clipboard.writeText('@'+data.me.handle);notify('Handle copied.');});
window.addEventListener('pagehide',()=>{live.stop();stopCamera();clearInterval(timer);releaseWakeLock();});
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
window.addEventListener('beforeunload',e=>{if(running||pending||activeLive()){e.preventDefault();e.returnValue='';}});
render();await refresh();
const initial=location.hash.slice(1);if(['arena','ranks','friends','history'].includes(initial))navigate(initial);
if(initial==='session'){const room=data?.liveRooms?.find(r=>!['complete','cancelled','void','invited'].includes(r.phase));if(room)openDuel(room);else navigate('arena');}
setInterval(()=>{if(!running&&!document.hidden&&!activeLive())refresh(true);},3000);
try{const saved=JSON.parse(sessionStorage.getItem('rep-arena-pending'));if(saved?.id&&Array.isArray(saved.events)){pending=saved;await saveRound();}}catch{}
const context=document.modelContext;
if(context?.registerTool){const lifecycle=new AbortController();for(const tool of [
 {name:'read_arena_status',description:'Read the signed-in athlete’s ladder, active rounds and connection status.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:async()=>({connected:!!data,exercise:mode,ladder:ladder(),matches:data?.matches.filter(m=>['active','queued','invited'].includes(m.status))||[]})},
 {name:'configure_arena_view',description:'Choose an exercise and open a view. Does not start a camera, round or ranked queue.',inputSchema:{type:'object',properties:{exercise:{type:'string',enum:['pushup','squat']},view:{type:'string',enum:['arena','ranks','friends','history']}},required:['exercise','view'],additionalProperties:false},annotations:{readOnlyHint:false},execute:async input=>{if(!input||!['pushup','squat'].includes(input.exercise)||!['arena','ranks','friends','history'].includes(input.view))throw new Error('Invalid exercise or view.');setMode(input.exercise);navigate(input.view);return {exercise:mode,view};}}
 ])try{await context.registerTool(tool,{signal:lifecycle.signal});}catch{}window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});}
