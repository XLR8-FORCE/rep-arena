import {FrontPushupCounter} from './front-counter.js';
export const EXERCISES = ['pushup', 'squat'];
export const TIERS = [{name:'Iron',min:0,color:'#ce977f'},{name:'Bronze',min:800,color:'#ddaa6b'},{name:'Silver',min:1000,color:'#c6d3d7'},{name:'Gold',min:1200,color:'#efff61'},{name:'Platinum',min:1500,color:'#76d8c3'},{name:'Diamond',min:1800,color:'#72a6ff'},{name:'Apex',min:2100,color:'#e194ff'}];
export function rank(rating) { const i = TIERS.findLastIndex(t=>rating>=t.min); const tier=TIERS[Math.max(0,i)]; return {...tier,next:TIERS[i+1]||null,progress:TIERS[i+1]?Math.min(100,(rating-tier.min)/(TIERS[i+1].min-tier.min)*100):100}; }
export function elo(a,b,result) { return Math.round(24*(result-1/(1+10**((b-a)/400)))); }
export function protect(delta,shields,usedToday) { const saved=delta<0&&shields>0&&!usedToday?Math.min(6,Math.floor(-delta/2)):0; return {delta:delta+saved,saved}; }
export function validateEvidence(events,exercise) {
  if(!Array.isArray(events)||events.length>100) throw new Error('Invalid rep evidence.');
  let prior=-1000;
  for(const e of events) {
    if(exercise==='pushup'&&e?.v===3){
      if(![e.t,e.duration,e.drop,e.topDrop,e.range].every(Number.isFinite)||e.t<0||e.t>60000||e.t-prior<650||e.duration<450||e.duration>15000||e.duration>e.t||e.range<.2||e.range>3||e.drop<Math.max(.2,e.range*.7)-.002||e.drop>3||e.topDrop>.08||e.topDrop<-.5)throw new Error('This rep did not pass shoulder travel and timing checks.');
      prior=e.t;continue;
    }
    const motion=exercise==='pushup'&&e?.v===2;
    if(!e || ![e.t,e.low,e.high,e.duration].every(Number.isFinite) || e.t<0 || e.t>60000 || e.t-prior<650 || e.duration<450 || e.duration>15000 || e.duration>e.t || e.low<25 || e.low>(motion?150:exercise==='pushup'?105:110) || e.high<(motion?140:155) || e.high>180.1 || (e.v!==undefined&&(!motion))) throw new Error('This attempt did not pass the timing and range checks.');
    if(motion&&(![e.drop,e.bend,e.topDrop,e.range].every(Number.isFinite)||e.range<.35||e.range>3||e.drop<Math.max(.35,e.range*.7)-.002||e.drop>3||e.bend<25||e.bend>155||e.topDrop> .12||e.topDrop<-.5))throw new Error('This rep did not pass the shoulder travel and arm movement checks.');
    prior=e.t;
  }
  return events.length;
}
export function angle(a,b,c) { const u={x:a.x-b.x,y:a.y-b.y}, v={x:c.x-b.x,y:c.y-b.y}; const d=Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y); return d?Math.acos(Math.max(-1,Math.min(1,(u.x*v.x+u.y*v.y)/d)))*180/Math.PI:0; }
export function angle3D(a,b,c) {
  const u=[a.x-b.x,a.y-b.y,a.z-b.z],v=[c.x-b.x,c.y-b.y,c.z-b.z];
  const d=Math.hypot(...u)*Math.hypot(...v);
  return d?Math.acos(Math.max(-1,Math.min(1,u.reduce((sum,x,i)=>sum+x*v[i],0)/d)))*180/Math.PI:0;
}
export class RepCounter {
  constructor(mode='pushup'){if(mode==='pushup')return new FrontPushupCounter();this.mode=mode;this.reset();}
  reset(){this.phase='seek';this.count=0;this.low=180;this.started=0;this.last=0;this.smooth=null;this.missing=0;this.events=[];this.dwell=0;}
  get calibrated(){return true;}
  update(points,time,width=1,height=1){
    if(!points || points.length<33){if(!this.missing)this.missing=time;if(time-this.missing>450){this.phase='seek';this.smooth=null;}return {hint:'Step into frame · full body visible',angle:0,visible:false};}
    const sides=[[11,13,15,23,25,27],[12,14,16,24,26,28]];
    const confidence=s=>Math.min(...s.filter((_,i)=>![1,2].includes(i)).map(i=>points[i]?.visibility||0));
    const s=confidence(sides[0])>=confidence(sides[1])?sides[0]:sides[1];
    if(confidence(s)<.65)return this.update(null,time,width,height);
    this.missing=0;
    const p=s.map(i=>({x:points[i].x*width,y:points[i].y*height}));
    const [shoulder,,,hip,knee,ankle]=p;
    const raw=angle(hip,knee,ankle);
    this.smooth=this.smooth===null?raw:this.smooth*.35+raw*.65;
    const a=this.smooth;
    const upright=shoulder.y<hip.y&&hip.y<ankle.y;
    if(!upright){this.phase='seek';return {angle:a,visible:true,hint:'Stand side-on with your full body in frame'};}
    let hint='Lower until your knees bend to 100°';
    if(this.phase==='seek'){hint='Start fully extended';if(a>160){if(!this.dwell)this.dwell=time;if(time-this.dwell>180){this.phase='up';this.dwell=0;}}else this.dwell=0;}
    else if(this.phase==='up'&&a<145){this.phase='down';this.started=time;this.low=a;}
    else if(this.phase==='down'){
      this.low=Math.min(this.low,a);hint=this.low<105?'Depth reached · return to full extension':'A little lower for a full rep';
      if(time-this.started>15000){this.phase='seek';}
      else if(a>160){const duration=time-this.started;if(this.low<=105&&duration>=450&&time-this.last>=650){this.count++;this.last=time;this.events.push({t:Math.round(time),low:Math.round(this.low),high:Math.round(a),duration:Math.round(duration)});hint='Rep counted · keep control';}else hint='Rep not counted · complete the full range';this.phase='up';}
    }
    return {angle:a,visible:true,hint,phase:this.phase,count:this.count};
  }
}
