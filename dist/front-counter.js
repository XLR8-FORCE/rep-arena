// Shoulder-only motion counter: measures vertical travel, not push-up form.
const MIN_TRAVEL=.2, GAP_MS=250, TOP_HOLD_MS=250;
export class FrontPushupCounter {
  constructor(){this.mode='pushup';this.reset();}
  reset(keepCalibration=false){
    this.measurements=null;this.missingJoints=[];
    this.sample=null;
    const baseline=keepCalibration?this.front?.baseline:null;
    this.front={baseline,hold:null,height:null,missing:null,lastFrame:null,lastValid:null};
    this.count=0;this.events=[];this.last=0;this.phase='seek';this.clearCycle();
  }
  get calibrated(){return !!this.front.baseline?.range;}
  setPosition(position,time){
    const s=this.sample,b=this.front.baseline;
    if(!s||time-s.time>250||time<s.time)throw new Error('Both shoulders must be visible. Hold still and try again.');
    if(position==='top'){
      this.front.baseline={height:s.height,width:s.width,range:0,manual:true};
    }else if(position==='bottom'){
      if(!b?.manual)throw new Error('Set your top position first.');
      const range=(s.height-b.height)/b.width;
      if(range<MIN_TRAVEL||range>3)throw new Error('Positions are too close or reversed. Lower your shoulders further, keeping the phone fixed.');
      b.range=range;
    }else throw new Error('Unknown shoulder position.');
    this.phase='seek';this.clearCycle();
    return position==='top'?'Top saved. Now set your bottom position.':'Bottom saved. Return to the top to get ready.';
  }
  topTolerance(){const b=this.front.baseline;return Math.min(.08,b?.manual&&b.range?b.range*.15:this.requiredTravel()*.25);}
  get bands(){
    const b=this.front.baseline;if(!b?.manual)return null;
    const tolerance=this.topTolerance()*b.width;
    return {top:b.height,topTolerance:tolerance,bottom:b.range?b.height+b.range*b.width:null,bottomTolerance:b.range*b.width*.15};
  }
  clearCycle(){this.started=0;this.peak=0;this.deep=false;this.depthFrames=0;}
  status(hint,visible=true,extra={}){
    return {hint,visible,ready:visible&&this.calibrated&&this.phase==='up',count:this.count,phase:this.phase,
      progress:this.phase==='down'?Math.min(1,this.peak/this.requiredTravel()):0,
      diagnostics:{setup:!this.front.baseline?'Find top position':!this.calibrated?'Complete one setup rep':'Setup complete',missingJoints:this.missingJoints,measurements:this.measurements},...extra};
  }
  requiredTravel(){const b=this.front.baseline;return Math.max(MIN_TRAVEL,(b?.range||0)*(b?.manual ? .85 : .7));}
  lose(time,hint,force=false){
    const f=this.front;f.hold=null;
    if(f.missing===null)f.missing=time;
    // Measure from last good frame, including across a run of invalid frames.
    if(force||f.lastValid===null||time-f.lastValid>GAP_MS){
      this.phase='seek';this.clearCycle();f.height=null;
      if(force)f.baseline=null;
    }
    return this.status(hint,false);
  }
  update(points,time,width=1,height=1){
    this.sample=null;
    this.measurements=null;this.missingJoints=[];
    const f=this.front;
    if(!Number.isFinite(time)||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return this.status('Waiting for camera frames',false);
    if(f.lastFrame!==null&&time<f.lastFrame){this.lose(time,'Return to the top',true);f.lastValid=null;}
    const dt=f.lastFrame===null?33:Math.max(1,time-f.lastFrame);f.lastFrame=time;
    if(f.lastValid!==null&&time-f.lastValid>GAP_MS)this.lose(time,'Tracking paused · return to the top');
    const shoulders=[11,12];
    const valid=p=>p&&[p.x,p.y].every(Number.isFinite)&&p.visibility>=.5&&p.x>.005&&p.x<.995&&p.y>.005&&p.y<.995;
    const names={11:'left shoulder',12:'right shoulder'};
    this.missingJoints=shoulders.filter(i=>!valid(points?.[i])).map(i=>names[i]);
    if(this.missingJoints.length)return this.lose(time,points?'Not clearly visible: '+this.missingJoints.join(', '):'No shoulders detected · bring both shoulders into view');
    const l=points[11],r=points[12],span=Math.hypot((l.x-r.x)*width,(l.y-r.y)*height);
    if(span<width*.08)return this.lose(time,'Move closer so both shoulders are clear');
    const rawHeight=(l.y+r.y)*height/2,alpha=1-Math.exp(-dt/40);
    f.height=f.height===null?rawHeight:f.height+alpha*(rawHeight-f.height);
    f.lastValid=time;f.missing=null;
    const shoulderY=f.height;
    this.sample={height:shoulderY,width:span,time};
    if(!f.baseline){
      const sample={time,height:shoulderY,width:span,range:0};
      if(!f.hold||Math.abs(shoulderY-f.hold.height)>span*.08)f.hold=sample;
      if(time-f.hold.time<TOP_HOLD_MS)return this.status('Hold still at the top');
      f.baseline={...f.hold};f.hold=null;this.phase='up';
      return this.status('Do one practice rep · lower, then press up');
    }
    const b=f.baseline;
    if(b.manual&&!b.range)return this.status('Top saved · set your bottom position');
    if(span<b.width*.6||span>b.width*1.6)return this.lose(time,'Camera distance changed · hold at the top to recalibrate',true);
    const drop=(shoulderY-b.height)/b.width;
    const top=b.manual?Math.abs(drop)<=this.topTolerance():drop<=this.topTolerance();
    this.measurements={depthPercent:Math.round(Math.max(0,drop)/this.requiredTravel()*100),atTop:top,depthObserved:this.deep};
    if(this.phase==='seek'){
      if(top){this.phase='up';this.clearCycle();return this.status(this.calibrated?'Ready · lower with control':'Do one practice rep · lower, then press up');}
      return this.status('Return to the top to start a new rep');
    }
    if(this.phase==='up'){
      if(drop>=.10){this.phase='down';this.started=time;this.peak=drop;this.deep=false;this.depthFrames=0;}
      else return this.status(this.calibrated?'Ready · lower with control':'Do one practice rep · lower, then press up');
    }
    this.peak=Math.max(this.peak,drop);
    // Require two observed depth frames; no fixed bottom pause or extrapolation.
    if(drop>=this.requiredTravel()){
      this.depthFrames++;this.peak=Math.max(this.peak,drop);
      if(this.depthFrames>=2)this.deep=true;
    }else if(!this.deep)this.depthFrames=0;
    if(time-this.started>15000){this.phase='seek';this.clearCycle();return this.status('Rep timed out · return to the top to start again');}
    if(top){
      const duration=time-this.started;
      const counted=this.deep&&duration>=450&&time-this.last>=650&&drop>=-.5&&this.peak<=3;
      if(counted){
        if(!b.range)b.range=this.peak;
        this.count++;this.last=time;
        this.events.push({v:3,t:Math.round(time),duration:Math.round(duration),drop:Number(this.peak.toFixed(3)),topDrop:Number(drop.toFixed(3)),range:Number(b.range.toFixed(3))});
      }
      const rejection=counted?null:!this.deep?'Shoulders did not travel far enough':duration<450?'Movement was too quick to confirm':time-this.last<650?'Too soon after the previous rep':'Position changed beyond the allowed range';
      this.phase='up';this.clearCycle();
      return this.status(counted?'Rep counted · full down and up':'Rep not counted · '+rejection.toLowerCase(),true,{counted,rejection});
    }
    return this.status(this.deep?'Rise back to your starting shoulder height':'Lower your shoulders further');
  }
}
