import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DYNAMICS, DAY_MS, decay, evolve, priority, reinforceActivity, reinforcementDay, validateDynamics } from '../../memory/dynamics.js';
import { meaningfulKeywords, scoreCue } from '../../memory/dynamics-cues.js';

test('approved half lives and stable evidence evolve independently of emotional residue', () => {
  for (const importance of [0, 0.5, 1]) {
    const result = evolve({activity:1, emotion:1, importance, stable:false, elapsedMs:30*(1+2*importance)*DAY_MS});
    assert.equal(result.activity, 0.5); assert.equal(result.halfLifeDays, 30*(1+2*importance));
  }
  const stable=evolve({activity:1,emotion:1,importance:0,stable:true,elapsedMs:7*DAY_MS});
  assert.equal(stable.activity,1); assert.equal(stable.emotion,0.5);
  assert.equal(decay(1,0,30),1); assert.equal(decay(1,1e9*DAY_MS,30),0);
});
test('settle before reinforcing, and segment policy changes without recomputing history', () => {
  const old=evolve({activity:1,emotion:1,importance:0,stable:false,elapsedMs:30*DAY_MS});
  assert.equal(reinforceActivity(old.activity),0.6);
  const next=evolve({...old,importance:0,stable:false,elapsedMs:60*DAY_MS},{...DEFAULT_DYNAMICS,activityHalfLifeDays:60});
  assert.equal(next.activity,0.25);
  assert.notEqual(next.activity,decay(1,90*DAY_MS,60));
});
test('priority formula bounds expose strong-cue recall and threshold behavior', () => {
  assert.equal(priority({cue:1,activity:1,importance:1,emotion:1}),1);
  assert.equal(priority({cue:1,activity:0,importance:0,emotion:0}),0.55);
  assert.equal(priority({cue:0,activity:1,importance:1,emotion:1}),0);
  assert.ok(priority({cue:0.34,activity:1,importance:1,emotion:1})<DEFAULT_DYNAMICS.threshold);
});
test('invalid floating point, backwards time and unnormalized weights fail closed', () => {
  for(const value of [NaN,Infinity,-1,1.01]) assert.throws(()=>reinforceActivity(value));
  assert.throws(()=>decay(1,-1,30)); assert.throws(()=>decay(1,1,0));
  assert.throws(()=>validateDynamics({...DEFAULT_DYNAMICS,weights:{...DEFAULT_DYNAMICS.weights,activity:0.5}}));
  assert.throws(()=>validateDynamics({...DEFAULT_DYNAMICS,emotionHalfLifeDays:Infinity}));
});
test('fixed Shanghai day boundary is independent of host zone and UTC date', () => {
  assert.equal(reinforcementDay(Date.parse('2026-09-11T15:59:59.999Z')),'2026-09-11');
  assert.equal(reinforcementDay(Date.parse('2026-09-11T16:00:00.000Z')),'2026-09-12');
});
test('keyword deduplication and empty queries cannot inflate lexical coverage', () => {
  assert.deepEqual(meaningfulKeywords('the 我你的吗？！'),[]);
  assert.equal(scoreCue('我你的吗','我你的吗').score,0);
  assert.equal(scoreCue('', 'anything').score,0);
  assert.equal(scoreCue('Tea tea COFFEE','tea').coverage,0.5);
  assert.equal(scoreCue('Tea tea COFFEE','tea').score,scoreCue('tea coffee','tea').score);
  assert.equal(scoreCue('红茶','用户喜欢红茶').score,1);
  assert.equal(scoreCue('coffee','unrelated').score,0);
});
test('finite employment relation contributes 0.8 without flattening fact qualifiers', () => {
  const result=scoreCue('我现在在哪里工作？','用户目前就职于银河智学');
  assert.equal(result.relation,'current_employment'); assert.equal(result.score,0.8);
  for (const text of ['用户以前就职于银河智学','用户可能就职于银河智学','用户的朋友目前就职于银河智学']) {
    assert.equal(scoreCue('我现在在哪里工作？',text).relation,null);
  }
});
