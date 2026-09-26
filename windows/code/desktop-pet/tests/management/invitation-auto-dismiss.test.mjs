import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvitationAutoDismiss } from '../../desktop/invitation-auto-dismiss.mjs';

function fakeClock(start=1_000){
  let now=start,nextId=0;
  const timers=new Map();
  return {
    now:()=>now,
    timers,
    setTimer(callback,delay){const id=++nextId;timers.set(id,{callback,delay,due:now+delay});return id;},
    clearTimer(id){timers.delete(id);},
    advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.due<=now){timers.delete(id);timer.callback();}},
  };
}

test('邀请气泡 8 秒后淡出并回传忽略动作',()=>{
  const clock=fakeClock();const fading=[],expired=[];
  const dismiss=createInvitationAutoDismiss({onFadeStart:id=>fading.push(id),onTimeout:id=>expired.push(id),now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  assert.equal(dismiss.schedule('invite-1',new Date(clock.now()+60_000).toISOString()),true);
  assert.equal([...clock.timers.values()][0]?.delay,8_000);
  clock.advance(7_999);assert.deepEqual(fading,[]);assert.deepEqual(expired,[]);
  clock.advance(1);assert.deepEqual(fading,['invite-1']);assert.deepEqual(expired,[]);
  assert.equal([...clock.timers.values()][0]?.delay,180);
  clock.advance(179);assert.deepEqual(expired,[]);
  clock.advance(1);assert.deepEqual(expired,['invite-1']);
});

test('邀请自身先到期时使用更短期限，替换邀请后旧计时器不再触发',()=>{
  const clock=fakeClock();const fading=[],expired=[];
  const dismiss=createInvitationAutoDismiss({onFadeStart:id=>fading.push(id),onTimeout:id=>expired.push(id),now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  dismiss.schedule('soon',new Date(clock.now()+2_000).toISOString());
  assert.equal([...clock.timers.values()][0]?.delay,2_000);
  clock.advance(2_000);assert.deepEqual(expired,['soon']);assert.deepEqual(fading,[],'an already-expired invitation is removed immediately');
  dismiss.schedule('replacement',new Date(clock.now()+60_000).toISOString());
  assert.equal(clock.timers.size,1);
  assert.equal([...clock.timers.values()][0]?.delay,8_000);
  clock.advance(8_000);assert.deepEqual(fading,['replacement']);
  clock.advance(180);assert.deepEqual(expired,['soon','replacement']);
});

test('接受或忽略时可取消展示期或淡出期的自动收起',()=>{
  const clock=fakeClock();const expired=[];
  const fading=[];
  const dismiss=createInvitationAutoDismiss({onFadeStart:id=>fading.push(id),onTimeout:id=>expired.push(id),now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  dismiss.schedule('clicked',new Date(clock.now()+60_000).toISOString());
  assert.equal(dismiss.cancel('different'),false);
  assert.equal(dismiss.cancel('clicked'),true);
  dismiss.schedule('fading',new Date(clock.now()+60_000).toISOString());
  clock.advance(8_000);assert.deepEqual(fading,['fading']);
  assert.equal(dismiss.cancel('fading'),true);
  clock.advance(1_000);assert.deepEqual(expired,[]);
});
