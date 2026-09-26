import { createPackageHost } from '../../dist/plugins/host-runtime.js';
import { Next65Management } from '../../dist/management/next65-management.js';
import { FlowAwareDialogueProvider } from '../../dist/providers/flow-aware-dialogue.js';
import { BackendSession } from '../../dist/app/backend-session.js';
import { MemoryMediaStore } from '../../dist/media/store.js';

const [hostRoot, rawTurns] = process.argv.slice(2);
const turns = Number(rawTurns);
const host = createPackageHost({ hostRoot, secrets: { has: () => false, resolve: () => null, list: () => [] } });
const management = new Next65Management({ hostRoot, host });
const observed = [];
const dialogue = new FlowAwareDialogueProvider({
  async reply(input) {
    const context = input.context.flowContext;
    if (!context) throw new Error('active Flow output did not reach the actual dialogue request');
    if (context.text !== `fixture-context:${input.scope.turnId}`) throw new Error('Flow did not consume the current conversation scope');
    observed.push(context.text);
    return { scope: input.scope, text: `reply-${observed.length}`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
  },
}, management);
const session = new BackendSession({
  outputMode: 'text', mediaStore: new MemoryMediaStore(),
  perception: { async perceive() { throw new Error('text turn must not perceive'); } },
  tts: { async synthesize() { throw new Error('text turn must not synthesize'); } },
  memory: {
    async append() {},
    async context(scope) { return { scope, characterPrompt: 'fixture', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 4096 }; },
    maintenanceInput(scope) { return { scope, messages: [], relevantMemories: [] }; },
    async maintain() { return []; },
  },
  dialogue,
}, () => {}, () => {});

try {
  for (let index = 0; index < turns; index += 1) {
    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: `turn-${index}` } }));
    await session.drain();
  }
  if (observed.length !== turns) throw new Error(`only ${observed.length}/${turns} turns reached the dialogue provider`);
  const active = management.activeProfile();
  if (!active) throw new Error('active Flow profile did not survive process restart');
  process.stdout.write(JSON.stringify({ turns, flowCalls: observed.length, profileId: active.profileId, first: observed[0], last: observed.at(-1) }));
} finally {
  await session.close();
  await host.close();
}
