import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join } from 'node:path';
import { managementUrl } from './management-url.mjs';

const descriptor = process.argv[2];
if (!descriptor || !isAbsolute(descriptor)) throw Error('An absolute management-session.json path is required.');
const schema = { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false };
const catalogue = ['send_confirmed', 'status'].map(name => ({ name, description: name === 'status' ? 'Read the confirmed task receipt.' : 'Deliver an already confirmed task once.', inputSchema: schema }));
const toolError = () => ({ isError: true, content: [{ type: 'text', text: 'Confirmed task unavailable; review it in the desktop companion.' }] });
async function handle(message) {
  if (message.method === 'initialize') return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'aaaagent-confirmed-relay', version: '0.1.1' } };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools: catalogue };
  if (message.method !== 'tools/call') throw Error('Unsupported method');
  const { name, arguments: args } = message.params ?? {};
  if (!catalogue.some(tool => tool.name === name) || !args || Object.keys(args).length !== 1 ||
      typeof args.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(args.operationId)) return toolError();
  try {
    // Validate private descriptor, loopback origin and live backend identity before sending its token.
    const url = new URL(await managementUrl(join(dirname(descriptor), 'config.json')));
    const response = await fetch(url.origin + '/api/harness-tools/' + (name === 'status' ? 'status' : 'send-confirmed'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + url.hash.slice(7), Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: args.operationId }), redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return toolError();
    const receipt = await response.json();
    const safe = { status: receipt.phase, ...(receipt.appTurnId ? { turnId: receipt.appTurnId } : {}), ...(typeof receipt.result === 'string' ? { result: receipt.result } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(safe) }] };
  } catch { return toolError(); }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id === undefined) return;
  let response;
  try { response = { result: await handle(message) }; }
  catch { response = { error: { code: -32601, message: 'Unsupported request' } }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response }) + '\n');
});
