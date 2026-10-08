// Private cached results from check-videos.mjs; files remain under ignored .local.
import {readFile,readdir} from 'node:fs/promises';
import {RepCounter,validateEvidence} from '../dist/rules.js';
for(const file of await readdir('.local/video-checks')) {
  if(!file.endsWith('.mp4.json'))continue;
  const clip=JSON.parse(await readFile('.local/video-checks/'+file,'utf8'));
  const c=new RepCounter('pushup');let last='';const changes=[];
  for(const frame of clip.frames.filter((_,i)=>i % Number(process.env.FRAME_STRIDE||1)===0)){
    const r=c.update(frame.image,frame.time,clip.width,clip.height,frame.world);
    if(r.hint!==last){changes.push({t:+(frame.time/1000).toFixed(2),hint:r.hint,phase:c.phase,count:c.count,peak:+c.peak.toFixed(2),angles:c.front.angles?.map(Math.round),baseline:c.front.baseline&&{height:+c.front.baseline.height.toFixed(1),width:+c.front.baseline.width.toFixed(1),angles:c.front.baseline.angles.map(Math.round)}});last=r.hint;}
  }
  console.log(JSON.stringify({file,count:c.count,accepted:validateEvidence(c.events,'pushup'),events:c.events,...(process.env.DETAIL?{changes:changes.map(c=>[c.t,c.hint,c.count,c.angles])}: {})}));
}
