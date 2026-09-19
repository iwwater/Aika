import test from 'node:test';
import assert from 'node:assert/strict';
import {TemporalFrames} from '../../media/temporal-frames.js';
test('long turns use two spaced early attempts and reserve one real frame for release',()=>{
 const frames=new TemporalFrames();let attempts=0;
 for(let at=0;at<600000;at+=34)if(frames.reserve(at)){attempts++;frames.add(at,Uint8Array.of(attempts));}
 assert.equal(attempts,2);assert.ok(frames.reserve(600000,true));frames.add(600000,Uint8Array.of(3));assert.equal(frames.reserve(600001,true),false);
 const selected=frames.take();assert.equal(selected.length,3);assert.equal(selected[0]!.atMs,0);assert.equal(selected[2]!.atMs,600000);
});
test('failed encodings consume slots; zero/short turns return only actual frames',()=>{
 const empty=new TemporalFrames();assert.ok(empty.reserve(0));assert.equal(empty.reserve(500),false);assert.ok(empty.reserve(1000));assert.equal(empty.reserve(2000),false);assert.ok(empty.reserve(3000,true));assert.deepEqual(empty.take(),[]);
 const short=new TemporalFrames();short.reserve(0);short.add(0,Uint8Array.of(7));assert.equal(short.take().length,1);
});
test('cancellation and late frame arrival erase bytes without reopening the collection',()=>{
 const frames=new TemporalFrames(),bytes=Uint8Array.of(1);frames.reserve(0);frames.add(0,bytes);frames.clear();assert.equal(bytes[0],0);
 const late=Uint8Array.of(2);assert.throws(()=>frames.add(1000,late));assert.equal(late[0],0);assert.equal(frames.reserve(1000),false);
});
