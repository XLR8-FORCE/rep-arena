import test from 'node:test';
import assert from 'node:assert/strict';
import {RepCounter,validateEvidence} from '../dist/rules.js';
function run(width=960,height=720){
 const c=new RepCounter();let t=0;
 const frames=(drop=0,n=10,missing=false)=>{
  let result;
  for(let i=0;i<n;i++){
   const p=Array(33).fill(null);
   p[11]={x:.35,y:.25+drop*width*.3/height,visibility:missing?0:1};
   p[12]={x:.65,y:.25+drop*width*.3/height,visibility:1};
   result=c.update(p,t+=100,width,height);
  }return result;
 };
 return {c,frames,lose(){c.update(null,t+=600,width,height);}};
}
test('only two 2D shoulders suffice; calibration and complete cycles count once',()=>{
 const f=run();f.frames();assert.equal(f.c.calibrated,false);
 f.frames(.6);f.frames();assert.equal(f.c.count,1);assert.equal(f.c.calibrated,true);
 f.frames(0,30);assert.equal(f.c.count,1);
 f.frames(.6);f.frames();assert.equal(f.c.count,2);
 assert.equal(validateEvidence(f.c.events,'pushup'),2);
 assert.equal(f.c.events[0].v,3);assert.equal('bend' in f.c.events[0],false);
});
test('stationary shoulders and jitter do not count',()=>{
 const f=run();f.frames();for(let i=0;i<30;i++){f.frames(.03,1);f.frames(-.03,1);}assert.equal(f.c.count,0);
});
test('partial travel is rejected, learned range rejects shrinking reps',()=>{
 const f=run();f.frames();f.frames(.15);
 let rejection;for(let i=0;i<10;i++){const r=f.frames(0,1);if(r.rejection)rejection=r.rejection;}
 assert.match(rejection,/travel far enough/);assert.equal(f.c.calibrated,false);
 f.frames(.8);f.frames();assert.equal(f.c.count,1);
 f.frames(.3);f.frames();assert.equal(f.c.count,1);
});
test('tracking loss cancels incomplete cycle, preserves completed evidence',()=>{
 const f=run();f.frames();f.frames(.6);f.frames();
 f.frames(.6);f.lose();f.frames();assert.equal(f.c.count,1);
 f.frames(.6);f.frames();assert.equal(f.c.count,2);
});
test('missing shoulder blocks counting and names joint',()=>{
 const f=run();f.frames();const r=f.frames(.6,10,true);f.frames();
 assert.equal(f.c.count,0);assert.deepEqual(r.diagnostics.missingJoints,['left shoulder']);
});
test('isolated unobserved depth cannot count',()=>{
 const f=run();f.frames();f.frames(.15,2);f.frames(.6,1,true);f.frames();assert.equal(f.c.count,0);
});
test('portrait and landscape use shoulder-width normalized travel',()=>{
 for(const [w,h] of [[960,720],[720,960],[1280,720]]){const f=run(w,h);f.frames();f.frames(.6);f.frames();assert.equal(f.c.count,1);}
});
test('round reset preserves calibration, clears countdown motion and time origin',()=>{
 const f=run();f.frames();f.frames(.6);f.frames();f.frames(.6);
 f.c.reset(true);assert.equal(f.c.count,0);assert.equal(f.c.calibrated,true);assert.deepEqual(f.c.events,[]);
 const p=Array(33).fill(null);p[11]={x:.35,y:.25,visibility:1};p[12]={x:.65,y:.25,visibility:1};
 f.c.update(p,0,960,720);assert.equal(f.c.phase,'up');assert.equal(f.c.count,0);
});
test('v3 evidence validates shoulder travel and timing without fake elbow angles',()=>{
 const f=run();f.frames();f.frames(.6);f.frames();const e=f.c.events[0];
 assert.equal(validateEvidence([e],'pushup'),1);
 for(const change of [{drop:.1},{range:.1},{topDrop:.3},{drop:NaN},{v:4},{duration:200}])assert.throws(()=>validateEvidence([{...e,...change}],'pushup'));
 assert.throws(()=>validateEvidence([e],'squat'));
 assert.equal(validateEvidence([{v:2,t:1500,duration:750,low:119,high:150,drop:.8,bend:35,topDrop:.06,range:.8}],'pushup'),1);
 assert.equal(validateEvidence([{t:1500,low:85,high:170,duration:800}],'pushup'),1);
});
test('manual heights create tolerance bands and count without hitting exact targets',()=>{
 const f=run();f.frames();f.c.setPosition('top',f.c.sample.time);
 f.frames(.6);assert.equal(f.c.calibrated,false);assert.equal(f.c.count,0);
 f.c.setPosition('bottom',f.c.sample.time);assert.equal(f.c.calibrated,true);
 assert.ok(f.c.bands.bottom>f.c.bands.top);
 f.frames(.02);f.frames(.54);f.frames(.03);
 assert.equal(f.c.count,1);assert.equal(validateEvidence(f.c.events,'pushup'),1);
 f.frames(.3);f.frames(.02);assert.equal(f.c.count,1);
 const bands=f.c.bands;f.c.reset(true);assert.deepEqual(f.c.bands,bands);assert.equal(f.c.count,0);
});
test('manual setup rejects stale, hidden, reversed and nearly identical positions',()=>{
 const f=run();assert.throws(()=>f.c.setPosition('top',0));f.frames();
 assert.throws(()=>f.c.setPosition('bottom',f.c.sample.time));
 assert.throws(()=>f.c.setPosition('top',f.c.sample.time+300));
 f.c.setPosition('top',f.c.sample.time);
 f.frames(.05);assert.throws(()=>f.c.setPosition('bottom',f.c.sample.time));
 f.frames(-.05);assert.throws(()=>f.c.setPosition('bottom',f.c.sample.time));
 f.frames(.6,1,true);assert.throws(()=>f.c.setPosition('bottom',10000));
});
