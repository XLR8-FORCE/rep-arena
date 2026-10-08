// Browser integration check with deterministic camera observations. Real model
// inference is independently exercised by check-videos.mjs.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createLocalArena} from '../dev/local-server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const clip=JSON.parse(await readFile('.local/video-checks/WhatsApp Video 2026-09-30 at 12.19.44 AM.mp4.json','utf8'));
const arena=await createLocalArena({port:0,dbPath:':memory:',joinCode:'82645193'});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:430,height:932}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.__clock=10000;performance.now=()=>window.__clock;
    Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{get(){return window.__clock/1000;},set(){}});
    Object.defineProperty(HTMLMediaElement.prototype,'readyState',{get(){return 4;}});
    Object.defineProperty(HTMLVideoElement.prototype,'videoWidth',{get(){return 478;}});
    Object.defineProperty(HTMLVideoElement.prototype,'videoHeight',{get(){return 850;}});
    HTMLMediaElement.prototype.play=()=>Promise.resolve();
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(cb){window.__frameCallback=cb;return 1;};
    HTMLVideoElement.prototype.cancelVideoFrameCallback=function(){window.__frameCallback=null;};
    navigator.mediaDevices.getUserMedia=async()=>{const c=document.createElement('canvas');c.width=478;c.height=850;c.getContext('2d').fillRect(0,0,478,850);return c.captureStream(30);};
  });
  await page.route('**/pose-engine.js',route=>route.fulfill({contentType:'text/javascript',body:'export async function createPoseEngine(){return {detectForVideo(){return {landmarks:window.__pose?.image?[window.__pose.image]:[],worldLandmarks:window.__pose?.world?[window.__pose.world]:[]};}};}'}));
  await page.request.post(arena.origin+'/local/join',{data:{code:'82645193',name:'Counter smoke test'}});
  await page.goto(arena.origin);await page.locator('#launch-mode').selectOption('practice');await page.locator('#queue-btn').click();
  await page.locator('#enable-camera').click();await page.waitForFunction(()=>!!window.__frameCallback);
  await page.evaluate(()=>{
    window.__arcs=[];const original=CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc=function(x,y,...args){if(this.canvas.id==='pose-overlay')window.__arcs.push([x,y]);return original.call(this,x,y,...args);};
  });
  const feed=async(frames,base,offset=0)=>page.evaluate(({frames,base,offset})=>{
    for(const frame of frames){window.__clock=base+frame.time-offset;window.__pose=frame;window.__frameCallback?.(window.__clock);}
  },{frames,base,offset});
  await feed(clip.frames.filter(f=>f.time<=3300),10000);
  assert.match(await page.locator('#form-feedback').textContent(),/FRONT VIEW READY/);
  assert.equal(await page.locator('#rep-count').textContent(),'00','warmup must not score');
  const startedResponse=page.waitForResponse(r=>r.url().endsWith('/api/sessions/start'));
  await page.locator('#start-round').click();const started=await(await startedResponse).json();
  const startTime=13300+started.startsIn;
  // Countdown contains a full exercise cycle; none of it may carry into scoring.
  await feed(clip.frames.filter(f=>f.time>=2233&&f.time<=3267),13350,2233);
  assert.equal(await page.locator('#rep-count').textContent(),'00');
  await feed(clip.frames.filter(f=>f.time>=3267&&f.time<=5600),startTime,3267);
  assert.equal(await page.locator('#rep-count').textContent(),'02','only the two scored cycles count');
  assert.equal(await page.locator('#tracking-joints span').count(),2);
  assert.equal(await page.locator('.arm-tracking-panel').isVisible(),true);
  assert.match(await page.locator('#tracking-setup').textContent(),/Setup complete/);
  const lastFrame=clip.frames.filter(f=>f.time<=5600).at(-1);
  const overlay=await page.evaluate(()=>window.__arcs.slice(-2));
  assert.equal(overlay.length,2);
  for(const [i,joint] of [11,12].entries()){
    assert.ok(Math.abs(overlay[i][0]-lastFrame.image[joint].x*478)<.001,'only shoulder dots are rendered');
  }
  await mkdir('.local/video-checks',{recursive:true});
  await page.screenshot({path:'.local/video-checks/camera-smoke-mobile.png',fullPage:true});
  arena.sqlite.prepare('UPDATE sessions SET started=? WHERE id=?').run(Date.now()-60010,started.id);
  const finishedResponse=page.waitForResponse(r=>r.url().endsWith('/api/sessions/finish'));
  await page.evaluate(time=>{window.__clock=time;window.__frameCallback(window.__clock);},startTime+60010);
  const finished=await finishedResponse;assert.equal(finished.status(),200);assert.equal((await finished.json()).reps,2);
  await page.waitForSelector('#result-done');assert.deepEqual(errors,[]);
  const row=arena.sqlite.prepare('SELECT reps,evidence FROM sessions WHERE id=?').get(started.id);
  assert.equal(row.reps,2);assert.ok(JSON.parse(row.evidence).every(e=>e.v===3));
  await page.reload();await page.locator('#launch-mode').selectOption('practice');await page.locator('#queue-btn').click();
  await page.locator('#enable-camera').click();await page.waitForFunction(()=>!!window.__frameCallback);
  const shoulderFrames=(y)=>Array.from({length:40},(_,i)=>{const image=Array(33).fill(null);image[11]={x:.3,y,visibility:1};image[12]={x:.7,y,visibility:1};return {time:i*100,image};});
  await feed(shoulderFrames(.25),20000);
  await page.locator('#set-shoulder-top').click();await feed(shoulderFrames(.25),24000);
  assert.match(await page.locator('#calibration-message').textContent(),/Top saved/);
  await page.locator('#set-shoulder-bottom').click();await feed(shoulderFrames(.4),28000);
  assert.match(await page.locator('#calibration-message').textContent(),/Bottom saved/);
  await feed(shoulderFrames(.25),32000);
  assert.match(await page.locator('#form-feedback').textContent(),/FRONT VIEW READY/);
  await page.locator('#reset-shoulder-positions').click();
  assert.match(await page.locator('#calibration-message').textContent(),/Positions cleared/);
  await page.goto(arena.origin+'/replay.html');await page.screenshot({path:'.local/video-checks/replay-mobile.png',fullPage:true});
  console.log('PASS: mobile UI, calibration, countdown isolation, 2 scored reps, v3 score saved, replay page.');
}finally{await browser?.close();await arena.close();}
