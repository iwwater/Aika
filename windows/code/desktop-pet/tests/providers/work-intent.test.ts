import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnScope } from '../../contracts/index.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import { WorkIntentClassifier } from '../../providers/work-intent.js';

const scope: TurnScope = { characterId: 'companion', sessionId: 'session', turnId: 'turn', generation: 1 };
const endpoint: EndpointConfig = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: () => 'synthetic-key',
  authorizer: { async authorize() { return { async settle() {} }; } } };
test('classifier sends only current input with host-bound scope, bounded JSON, no companion history/project catalog', async () => {
  let body: any;
  const transport = new ProviderTransport((async (_input, init) => { body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'work', question: '' }) }, finish_reason: 'stop' }] }), { status: 200 }); }) as typeof fetch);
  const result = await new WorkIntentClassifier(endpoint, transport).classify(scope, 'Implement a synthetic task', new AbortController().signal);
  assert.deepEqual(result, { kind: 'work' }); assert.equal(body.max_tokens, 384); assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.messages.length, 2); assert.deepEqual(JSON.parse(body.messages[1].content), { currentInput: 'Implement a synthetic task' });
});
for (const invalid of [{ scope: { ...scope, turnId: 'old' }, kind: 'work', question: '' }, { kind: 'work', question: '', target: 'invented' },
  { kind: 'clarify', question: '' }]) test('unbound/extra/empty clarification response cannot authorize work', async () => {
  const transport = new ProviderTransport((async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) }, finish_reason: 'stop' }] }))) as typeof fetch);
  await assert.rejects(new WorkIntentClassifier(endpoint, transport).classify(scope, 'Synthetic input', new AbortController().signal));
});
test('cancellation stops routing without converting an aborted response to companion permission', async () => {
  const controller = new AbortController(); controller.abort();
  const transport = new ProviderTransport((async () => { throw Error('Network must not run'); }) as typeof fetch);
  await assert.rejects(new WorkIntentClassifier(endpoint, transport).classify(scope, 'Synthetic input', controller.signal));
});

test('delayed classifier response cannot bypass cancellation by claiming a valid turn',async()=>{
 const stop=new AbortController();let release:(v:any)=>void=()=>{};
 const transport={request:()=>new Promise(resolve=>{release=resolve;})} as unknown as ProviderTransport;
 const p=new WorkIntentClassifier(endpoint,transport).classify(scope,'Synthetic input',stop.signal);
 stop.abort();release({choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'work',question:''})}}]});await assert.rejects(p);
});
