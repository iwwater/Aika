/** Deliberately offline UI fixture. It never imports providers, credentials or private data. */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { COMPANION_ID } from '../contracts/character.js';
import { DESKTOP_BRIDGE_VERSION, type BackendToDesktop, type DesktopToBackend } from '../contracts/desktop-bridge.js';
const sessionId = randomUUID();
let generation = 0;
const expression = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null };
const send = (message: BackendToDesktop) => process.stdout.write(JSON.stringify(message) + '\n');
send({ channel: 'backend_ready', bridgeVersion: DESKTOP_BRIDGE_VERSION, characterId: COMPANION_ID, sessionId,
  introduction: { id: 'windows-preview', text: 'Offline development preview · 离线开发预览。可以测试角色、窗口和文字交互；回复为本地回显。语音和控制台需要正式配置。' } });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let message: DesktopToBackend;
  try { message = JSON.parse(line); } catch { return; }
  if (message.channel !== 'command') return;
  const c = message.command;
  if (c.type === 'submit_text') {
    const scope = { characterId: COMPANION_ID, sessionId, turnId: randomUUID(), generation: ++generation };
    send({ channel: 'event', event: { type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: c.text, ...(c.clientRequestId ? { clientRequestId: c.clientRequestId } : {}) } } });
    send({ channel: 'input_route', scope, route: 'companion' });
    send({ channel: 'event', event: { type: 'reply', reply: { scope, text: 'Offline preview received: ' + c.text, expression } } });
    send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'idle', expression, mouth: 0 } } });
  } else if (c.type === 'start_voice' || c.type === 'click_invitation') {
    send({ channel: 'event', event: { type: 'error', scope: null, message: 'Offline preview: voice requires a configured backend.' } });
  }
});
