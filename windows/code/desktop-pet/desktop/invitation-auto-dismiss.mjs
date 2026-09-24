const DISPLAY_MS=8_000;

/** Expires a visible invitation after the contract's display window, bounded by its own TTL. */
export function createInvitationAutoDismiss({onFadeStart=()=>{},onTimeout,now=()=>Date.now(),setTimer=(fn, ms)=>globalThis.setTimeout(fn, ms),clearTimer=id=>globalThis.clearTimeout(id),displayMs=DISPLAY_MS,fadeMs=180}){
  let currentId=null,timer=null;
  const cancel=(id)=>{
    if(id!==undefined&&currentId!==id)return false;
    if(timer!==null)clearTimer(timer);
    currentId=null;timer=null;return true;
  };
  return Object.freeze({
    schedule(id,expiresAt){
      cancel();
      const expiry=Date.parse(expiresAt);
      if(typeof id!=='string'||!id||!Number.isFinite(expiry))return false;
      currentId=id;
      const untilExpiry=expiry-now();
      const expiresBeforeFade=untilExpiry<=displayMs;
      timer=setTimer(()=>{
        if(currentId!==id)return;
        if(expiresBeforeFade){currentId=null;timer=null;onTimeout(id);return;}
        onFadeStart(id);
        timer=setTimer(()=>{
          if(currentId!==id)return;
          currentId=null;timer=null;onTimeout(id);
        },Math.max(0,fadeMs));
      },Math.max(0,Math.min(displayMs,untilExpiry)));
      return true;
    },
    cancel,
    dispose(){cancel();},
  });
}
