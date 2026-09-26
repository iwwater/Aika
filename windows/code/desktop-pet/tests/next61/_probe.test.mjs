import test from 'node:test';
import assert from 'node:assert/strict';
test('mock timers probe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = false;
  setTimeout(() => { fired = true; }, 60000);
  // setImmediate must stay real while setTimeout is mocked
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  assert.equal(fired, false);
  t.mock.timers.tick(60001);
  assert.equal(fired, true);
  assert.equal(typeof process.stdout.write, 'function');
});
