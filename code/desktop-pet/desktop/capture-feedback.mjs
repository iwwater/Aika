/** Fourth-root display mapping lifts quiet input without a nonzero floor or clipping.
 * Ephemeral input-level history only. Never reads devices, sends data, or logs levels. */
export class CaptureFeedback {
  constructor(get){this.get=get;this.generation=0;this.active=false;this.stop();}
  start(options={}){
    this.mode=options;
    const token=++this.generation;this.active=true;this.hasPCM=false;this.dirty=false;this.latest=0;this.smoothed=0;this.history=Array(40).fill(0);this.lastFrame=-Infinity;
    this.get('capture-feedback').hidden=false;this.get('capture-feedback').dataset.phase=options.phase||'connecting';this.get('capture-feedback').dataset.mode=options.keepLabel?'wake':'ptt';this.get('capture-connecting').textContent=options.label||'正在连接语音';this.get('capture-connecting').hidden=false;this.get('capture-wave').hidden=true;this.get('capture-wave-path').setAttribute('d','M0 12 H160');
    const frame=at=>{if(!this.active||token!==this.generation)return;if(this.dirty&&at-this.lastFrame>=50){this.lastFrame=at;this.dirty=false;this.smoothed=this.latest===0?0:this.smoothed*.3+this.latest*.7;this.history.shift();this.history.push(Math.pow(this.smoothed,.25)*10);const upper=this.history.map((v,i)=>`${(i*160/39).toFixed(1)} ${(12-v).toFixed(2)}`),lower=this.history.map((v,i)=>`${(i*160/39).toFixed(1)} ${(12+v).toFixed(2)}`).reverse();this.get('capture-wave-path').setAttribute('d','M'+upper.join(' L')+' L'+lower.join(' L')+' Z');this.get('capture-feedback').dataset.phase=this.mode.phase||'recording';this.get('capture-connecting').hidden=!this.mode.keepLabel;this.get('capture-wave').hidden=false;}requestAnimationFrame(frame);};requestAnimationFrame(frame);return token;
  }
  configure(token,options){if(!this.active||token!==this.generation)return;this.mode=options;this.get('capture-feedback').dataset.phase=options.phase||'recording';this.get('capture-feedback').dataset.mode=options.keepLabel?'wake':'ptt';this.get('capture-connecting').textContent=options.label||'正在连接语音';this.get('capture-connecting').hidden=!options.keepLabel&&this.hasPCM;}
  level(token,value){if(!this.active||token!==this.generation||!Number.isFinite(value?.rms)||value.rms<0||value.rms>1||!Number.isFinite(value?.peak)||value.peak<0||value.peak>1)return;this.hasPCM=true;this.latest=value.rms;this.dirty=true;}
  stop(token){if(token!==undefined&&token!==this.generation)return;this.active=false;this.generation++;this.hasPCM=false;this.dirty=false;this.latest=0;this.smoothed=0;this.history=[];this.get('capture-feedback').hidden=true;this.get('capture-feedback').dataset.phase='idle';this.get('capture-wave-path').setAttribute('d','');}
}
