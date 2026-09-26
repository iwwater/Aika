import {MAX_CAPTURE_IMAGES} from '../contracts/index.js';
/** Three encoding attempts at most; reserve the final slot for release, never wait to fill it. */
export class TemporalFrames {
  private frames:{atMs:number;bytes:Uint8Array}[]=[];
  private attempts=0;
  private nextAt=0;
  private closed=false;
  constructor(private readonly intervalMs=1000){if(!Number.isFinite(intervalMs)||intervalMs<1000)throw Error('Invalid frame interval');}
  get size(){return this.frames.length;}
  due(atMs:number,final=false){return !this.closed&&Number.isFinite(atMs)&&atMs>=0&&this.attempts<(final?MAX_CAPTURE_IMAGES:MAX_CAPTURE_IMAGES-1)&&(final||atMs>=this.nextAt);}
  reserve(atMs:number,final=false){if(!this.due(atMs,final))return false;this.attempts++;this.nextAt=atMs+this.intervalMs;return true;}
  add(atMs:number,bytes:Uint8Array){
    if(this.closed||!Number.isFinite(atMs)||atMs<0||!bytes.length||bytes.length>512*1024||this.frames.length>=this.attempts){bytes.fill(0);throw Error('Invalid camera frame');}
    this.frames.push({atMs,bytes});
  }
  take(_durationMs?:number){const result=this.frames;this.frames=[];this.closed=true;return result;}
  clear(){for(const frame of this.frames)frame.bytes.fill(0);this.frames=[];this.closed=true;}
}
