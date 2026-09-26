import test from 'node:test';
import assert from 'node:assert/strict';
import {PressToTalk} from '../../desktop/press-to-talk.js';
function fixture(){const calls:string[]=[];const hold=new PressToTalk({start(){calls.push('start');return true},finish(){calls.push('finish')},cancel(early){calls.push(early?'cancel-early':'cancel')}});hold.configure('ArrowLeft');return {hold,calls}}
test('custom arrow binding starts once and only finishes after actual capture-ready',()=>{
 const {hold,calls}=fixture();assert.equal(hold.down('ArrowRight'),false);hold.down('ArrowLeft');hold.down('ArrowLeft',true);hold.down('ArrowLeft');hold.ready();hold.up('ArrowLeft');hold.up('ArrowLeft');assert.deepEqual(calls,['start','finish']);
});
test('release before readiness cancels without a later ready reviving capture',()=>{
 const {hold,calls}=fixture();hold.down('ArrowLeft');hold.up('ArrowLeft');hold.ready();hold.up('ArrowLeft');assert.deepEqual(calls,['start','cancel-early']);
});
test('focus loss, role change and rebinding cancel a held turn once',()=>{
 const {hold,calls}=fixture();hold.down('ArrowLeft');hold.ready();hold.cancel();hold.cancel();hold.up('ArrowLeft');assert.deepEqual(calls,['start','cancel']);
 hold.down('ArrowLeft');hold.configure('KeyV');hold.up('ArrowLeft');hold.down('KeyV');hold.ready();hold.up('KeyV');assert.deepEqual(calls,['start','cancel','start','cancel','start','finish']);
});
test('invalid bindings and denied starts cannot produce a finish',()=>{
 const calls:string[]=[];const hold=new PressToTalk({start(){return false},finish(){calls.push('finish')},cancel(){calls.push('cancel')}});
 assert.equal(hold.configure('MetaLeft'),false);assert.equal(hold.configure('ArrowUp'),true);assert.equal(hold.down('ArrowUp'),false);hold.ready();hold.up('ArrowUp');assert.deepEqual(calls,[]);
});
