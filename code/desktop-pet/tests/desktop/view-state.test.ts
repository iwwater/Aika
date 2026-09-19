import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopViewState, neutral } from '../../desktop/view-state.js';
import type { DesktopEvent, TurnScope, PlaybackEvent, ExpressionIntent, InputKind } from '../../contracts/index.js';
const scope: TurnScope = {characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
const expr: ExpressionIntent = {emotion:'happy',intensity:.8,delivery:'cheerful',gesture:'heart'};
function start(kind: InputKind = 'text') { const v=new DesktopViewState(); v.setSession('companion','s1'); v.receive({type:'turn',input:{scope,kind,startedAt:new Date().toISOString()}}); return v; }
function playback(v: DesktopViewState, event: Omit<PlaybackEvent,'scope'|'at'>) { return v.receive({type:'playback',playback:{...event,scope,at:new Date().toISOString()} as PlaybackEvent}); }
function reply(v: DesktopViewState) { v.receive({type:'reply',reply:{scope,text:'我在这里。',expression:expr}}); }
for (const kind of ['text','voice'] as const) test(`${kind}: expression and gesture coexist, speech only starts on actual playback`,()=>{
 const v=start(kind); reply(v); assert.deepEqual(v.expression,expr); assert.equal(v.mouth,0);
 v.receive({type:'presentation',presentation:{scope,state:'speaking',expression:expr,mouth:1}});
 assert.equal(v.state,'thinking'); assert.equal(v.mouth,0);
 assert.equal(playback(v,{type:'amplitude',value:.5} as PlaybackEvent),false);
 playback(v,{type:'started',audioId:'audio'} as PlaybackEvent); playback(v,{type:'amplitude',value:.4} as PlaybackEvent);
 assert.equal(v.state,'speaking'); assert.equal(v.mouth,.4); assert.deepEqual(v.expression,expr);
 v.receive({type:'presentation',presentation:{scope,state:'idle',expression:neutral(),mouth:0}});
 assert.equal(v.state,'speaking'); assert.equal(v.mouth,.4);
});
for(const type of ['ended','stopped','error'] as const) test(`${type}: resets mouth, face, gesture and rejects delayed output`,()=>{
 const v=start(); reply(v); playback(v,{type:'started',audioId:'a'} as PlaybackEvent); playback(v,{type:'amplitude',value:.9} as PlaybackEvent);
 playback(v,{type,message:'device unavailable'} as PlaybackEvent);
 assert.equal(v.mouth,0); assert.deepEqual(v.expression,neutral()); assert.equal(v.scope,null);
 assert.equal(playback(v,{type:'started',audioId:'old'} as PlaybackEvent),false);
 assert.equal(playback(v,{type:'amplitude',value:1} as PlaybackEvent),false);
 assert.equal(v.reply,'我在这里。'); assert.equal(v.state,type==='error'?'error':'idle');
});
test('cancel floors the generation; a newer turn works and old packets cannot affect it',()=>{
 const v=start();reply(v);v.command({type:'cancel'});
 assert.deepEqual(v.expression,neutral());assert.equal(v.scope,null);
 assert.equal(v.receive({type:'turn',input:{scope,kind:'text',startedAt:''}}),false);
 const next={...scope,turnId:'t2',generation:2};
 assert.equal(v.receive({type:'turn',input:{scope:next,kind:'text',startedAt:''}}),true);
 assert.equal(playback(v,{type:'ended'}),false);assert.equal(v.state,'thinking');
});
test('single companion reconnect rejects old sessions and legacy identities',()=>{
 const v=start();reply(v);v.setSession('companion','s2');
 assert.equal(v.reply,'');assert.deepEqual(v.expression,neutral());
 assert.equal(v.receive({type:'turn',input:{scope:{...scope,generation:9},kind:'text',startedAt:''}}),false);
 const current={...scope,sessionId:'s2'};
 assert.equal(v.receive({type:'turn',input:{scope:{...current,characterId:'sweetheart'},kind:'text',startedAt:''}}),false);
 assert.throws(()=>v.setSession('friend','legacy'));
 assert.equal(v.receive({type:'turn',input:{scope:current,kind:'text',startedAt:''}}),true);
 assert.equal(playback(v,{type:'started',audioId:'old'} as PlaybackEvent),false);
});
test('old-scope errors and NaN output cannot corrupt the current turn',()=>{
 const v=start();assert.equal(v.receive({type:'error',scope:{...scope,turnId:'other'},message:'old'}),false);
 playback(v,{type:'started',audioId:'a'} as PlaybackEvent);
 assert.equal(playback(v,{type:'amplitude',value:NaN} as PlaybackEvent),false);
 playback(v,{type:'amplitude',value:4} as PlaybackEvent);assert.equal(v.mouth,1);
 playback(v,{type:'started',audioId:'a'} as PlaybackEvent);assert.equal(v.mouth,1);
});
test('one reply retains its first main face across playback updates and resets for the next turn',()=>{
 const v=start();reply(v);playback(v,{type:'started',audioId:'a'} as PlaybackEvent);
 const other={...expr,emotion:'sad' as const,gesture:null};
 v.receive({type:'presentation',presentation:{scope,state:'speaking',expression:other,mouth:0}});
 v.receive({type:'reply',reply:{scope,text:'同一轮后续文本',expression:other}});
 assert.deepEqual(v.expression,expr);
 playback(v,{type:'ended'});
 const next={...scope,turnId:'next',generation:2};v.receive({type:'turn',input:{scope:next,kind:'text',startedAt:''}});
 v.receive({type:'reply',reply:{scope:next,text:'下一轮',expression:other}});assert.deepEqual(v.expression,other);
});
test('proactive invitation is role scoped, expires locally and never starts speech',()=>{
 const v=new DesktopViewState();v.setSession('companion','s1');
 const invitation:Extract<DesktopEvent,{type:'invitation'}>['invitation']={id:'i',eventId:'e',characterId:'companion',text:'今天怎么样？',gesture:'heart',eligibleAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10000).toISOString(),status:'shown'};
 assert.equal(v.receive({type:'invitation',invitation:{...invitation,characterId:'sweetheart'}}),false);
 assert.equal(v.receive({type:'invitation',invitation}),true);assert.equal(v.state,'idle');assert.equal(v.mouth,0);
 assert.equal(v.expireInvitation(Date.now()+10001),true);assert.equal(v.invitation,null);
});
