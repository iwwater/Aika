// Semantic timing only. Model IDs and physical ranges belong to the renderer.
const smooth=t=>t*t*(3-2*t);
const curve=(t,points)=>{for(let i=1;i<points.length;i++){const [end,value]=points[i],[start,previous]=points[i-1];if(t<=end)return previous+(value-previous)*smooth(Math.max(0,(t-start)/(end-start)));}return points.at(-1)[1];};
export class InteractionMotion {
  constructor(){this.values={yaw:0,pitch:0,roll:0,body:0,gazeX:0,gazeY:0,blink:0};this.attentionAt=null;}
  start(now){this.attentionAt=now;}
  release(){this.attentionAt=null;}
  sample({now,delta,elapsed,state,head,body,blink,work=false,reducedMotion=false}){
    const age=this.attentionAt===null?Infinity:Math.max(0,(now-this.attentionAt)/1000);
    if(age>.9)this.attentionAt=null;
    const tap=age<=.9?curve(age,[[0,0],[.12,-1],[.32,.42],[.7,0],[.9,0]]):0;
    const eye=age<=.4?curve(age,[[0,0],[.09,1],[.16,1],[.35,0],[.4,0]]):0;
    const speaking=state==='speaking',thinking=state==='thinking',listening=state==='listening';
    const target={
      yaw:thinking?4+Math.sin(elapsed*.45)*.7:Math.sin(elapsed*.75)*(speaking?7:2),
      pitch:(thinking?-4:listening?3:Math.sin(elapsed*1.1)*2)+tap*12,
      roll:(thinking?-7+Math.sin(elapsed*.35)*.6:Math.sin(elapsed*.65)*(speaking?5:2))+tap*2,
      body:Math.sin(elapsed*.75)*(speaking?3:1)+tap*1.8,
      gazeX:thinking?.3+Math.sin(elapsed*.4)*.035:0,
      gazeY:thinking?.18:age<.9?.1:0,
      blink:eye
    };
    if(work){
      const cycle=reducedMotion?0:elapsed;
      target.yaw=1.5+Math.sin(cycle*.55)*.7;
      target.pitch=-8+Math.sin(cycle*.8)*.9;
      target.roll=-2.5+Math.sin(cycle*.4)*.4;
      target.body=Math.sin(cycle*.55)*.55;
      target.gazeX=.14+Math.sin(cycle*.4)*.03;
      target.gazeY=-.28;
      target.blink=.16;
    }
    for(const key of Object.keys(target)){
      const allowed=key==='body'?body:key==='blink'?blink:head;
      if(!allowed){this.values[key]=0;continue;}
      const tau=key==='blink'?.035:(age<.9?.055:.22);
      this.values[key]+=(target[key]-this.values[key])*(1-Math.exp(-Math.max(0,delta)/tau));
    }
    return this.values;
  }
}
