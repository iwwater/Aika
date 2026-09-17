import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { BackendConnection } from '../../desktop/electron/transport.mjs';

function session(t, options = {}) {
  const messages = [], states = [];
  const transport = new BackendConnection({ onState: value => states.push(value), onMessage: (value, generation) => messages.push({ value, generation }), ...options });
  t.after(() => transport.close());
  return { transport, messages, states };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Transport timeout'); await new Promise(r => setTimeout(r, 20)); }
}
test('NDJSON preserves split Chinese UTF-8 and sends only the current generation', async t => {
  const s = session(t);
  s.transport.start(process.execPath, ['--input-type=module', '-e', `
    const b=Buffer.from(JSON.stringify({channel:'backend_ready',text:'中文'})+'\\n');
    const i=b.indexOf(Buffer.from('中文'))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),30);
    process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.exit(0));
  `]);
  await until(() => s.messages.length === 1);
  assert.equal(s.messages[0].value.text, '中文');
  assert.equal(s.transport.send({ channel: 'echo' }, 0), false);
  assert.equal(s.transport.send({ channel: 'echo' }, s.transport.generation), true);
  await until(() => s.messages.length === 2); assert.equal(s.messages[1].value.channel, 'echo');
  const child = s.transport.child, exited = once(child, 'exit'); s.transport.close();
  assert.equal((await exited)[0], 0);
});
test('malformed JSON fails the bridge and permits a fresh generation', async t => {
  const s = session(t);
  s.transport.start(process.execPath, ['-e', "process.stdout.write('not-json\\n');setTimeout(()=>{},30000)"]);
  await until(() => s.transport.state === 'failed');
  assert.equal(s.states.at(-1).reason, 'invalid-message');
  s.transport.start(process.execPath, ['-e', `console.log(JSON.stringify({channel:'backend_ready'}));process.stdin.resume()`]);
  await until(() => s.transport.state === 'ready'); assert.equal(s.transport.generation, 2);
});
test('startup timeout and oversized messages terminate stalled connections', async t => {
  const s = session(t, { timeoutMs: 150 });
  s.transport.start(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  await until(() => s.transport.state === 'failed'); assert.equal(s.states.at(-1).reason, 'ready-timeout');
  const large = session(t, { limit: 128 });
  large.transport.start(process.execPath, ['-e', "process.stdout.write('x'.repeat(256));process.stdin.resume()"]);
  await until(() => large.transport.state === 'failed'); assert.equal(large.states.at(-1).reason, 'message-too-large');
});
