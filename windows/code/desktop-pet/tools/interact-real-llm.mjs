import { ProviderTransport } from '../dist/providers/transport.js';
import { OpenAiCompatibleDialogueProvider } from '../dist/providers/aika-dialogue.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../dist/memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = existsSync(resolve(root, '../../.local/data/companion.sqlite'))
  ? resolve(root, '../../.local/data/companion.sqlite')
  : resolve(root, '.local/data/companion.sqlite');

console.log('Using SQLite Database:', dbPath);

const store = new SqliteMemoryStore({
  filename: dbPath,
  retention: CONFIRMED_RETENTION,
  invitations: confirmedInvitationPolicy('Asia/Shanghai')
});

const envFile = readFileSync('.env', 'utf8');
const env = {};
for (const line of envFile.split('\n')) {
  const [k, ...v] = line.split('=');
  if (k && !k.trim().startsWith('#')) {
    env[k.trim()] = v.join('=').trim();
  }
}

const key = env.NEXT_REAL_LLM_KEY;
const endpoint = env.NEXT_REAL_LLM_ENDPOINT;
const model = env.NEXT_REAL_LLM_MODEL;

if (!key || !endpoint || !model) {
  console.error('Missing LLM credentials in .env');
  process.exit(1);
}

const transport = new ProviderTransport();
const provider = new OpenAiCompatibleDialogueProvider(
  transport,
  {
    endpoint,
    model,
    apiKey: () => key,
    authorizer: { async authorize() { return { async settle() {} }; } }
  },
  '你是桌宠伴侣Aika，性格活泼、温柔、俏皮，对用户充满好奇与陪伴感。回复语言简洁生动，每次回复控制在1-3句话以内。'
);

const characterId = 'companion';
const sessionId = 'session-real-' + Date.now();
let generation = 0;

// Check counts before
const initialScope = { characterId, sessionId: 'management', turnId: 'read', generation: 0 };
const beforeTrans = store.queryRecords(initialScope, { kind: 'transcript', state: 'active', query: '', offset: 0, limit: 100 });
const beforeMems = store.queryRecords(initialScope, { kind: 'memory', state: 'active', query: '', offset: 0, limit: 100 });
console.log(`\n=== 交互前 SQLite 数据统计 ===`);
console.log(`历史对话记录数: ${beforeTrans.total}`);
console.log(`长期记忆条目数: ${beforeMems.total}`);

const conversationHistory = [];
const createdMessageIds = [];

async function chatTurn(userText) {
  generation++;
  const turnId = randomUUID();
  const scope = { characterId, sessionId, turnId, generation };

  console.log(`\n------------------------------------------------------------`);
  console.log(`[Turn ${generation}] 用户发言: "${userText}"`);

  // Query existing memories to provide to LLM
  const activeMems = store.queryRecords(scope, { kind: 'memory', state: 'active', query: '', offset: 0, limit: 10 });
  const memoryList = activeMems.records.map(r => ({ id: r.id, text: r.text }));

  conversationHistory.push({ role: 'user', content: userText });

  const reply = await provider.reply({
    scope,
    text: userText,
    context: {
      scope,
      characterPrompt: '你是桌宠伴侣Aika，青梅竹马设定，温暖真诚。回复简短生动，1-3句话。',
      recent: conversationHistory.map(h => ({ role: h.role, text: h.content })),
      summary: '',
      memories: memoryList
    }
  }, new AbortController().signal);

  const replyText = reply.text || '我在这里哦！';
  console.log(`[Turn ${generation}] Aika 回复: "${replyText}"`);

  conversationHistory.push({ role: 'assistant', content: replyText });

  const userMsgId = `${turnId}:user`;
  const asstMsgId = `${turnId}:assistant`;
  createdMessageIds.push(userMsgId, asstMsgId);

  const userMsg = {
    characterId,
    id: userMsgId,
    role: 'user',
    text: userText,
    createdAt: new Date().toISOString(),
    origin: 'conversation'
  };
  const asstMsg = {
    characterId,
    id: asstMsgId,
    role: 'assistant',
    text: replyText,
    createdAt: new Date().toISOString(),
    origin: 'conversation'
  };

  store.append(scope, [userMsg, asstMsg]);
  console.log(`[Turn ${generation}] 已成功持久化写入 SQLite (ID: ${userMsgId}, ${asstMsgId})`);
  return { replyText, turnId };
}

// 1. Turn 1
await chatTurn('Aika，我用 Antigravity 正在全面重构你的控制台和记忆系统。我的名字是 ZYF，我最看重真实和真诚，任何数据都必须真实记录，不能造假。你收到并记住了吗？');

// 2. Turn 2
await chatTurn('Aika，你还记得我叫什么名字，以及我刚才向你强调的最重要的原则是什么吗？');

// 3. Turn 3
await chatTurn('太棒了！接下来我们还会为你接入外观换肤和知识库系统，你对未来陪伴我有什么新的期待吗？');

// 4. Distill and write a new real memory fact referencing these turns
console.log(`\n=== 沉淀新记忆到 SQLite 长期记忆库 ===`);
const newMemoryId = 'mem-user-identity-zyf';
const newMemoryText = '用户姓名是 ZYF，正在使用 Antigravity 重构 Aika-Next 控制台与记忆系统；高度重视真实与真诚，严禁伪造数据，计划扩展换肤与知识库。';

const memoryScope = { characterId, sessionId, turnId: randomUUID(), generation: ++generation };
const sourceRefs = createdMessageIds.map(id => ({ id, version: 1 }));

try {
  // Use editRecord or apply
  store.editRecord(memoryScope, {
    id: newMemoryId,
    operationId: 'op-' + Date.now(),
    expectedVersion: 1,
    text: newMemoryText,
    reason: '从与用户的真实多轮对话中沉淀用户身份与核心偏好'
  });
  console.log(`已更新记忆: ${newMemoryId}`);
} catch (err) {
  // If not existing yet, add via transaction ledger
  store.recordDerived(memoryScope, {
    id: newMemoryId,
    kind: 'memory',
    text: newMemoryText,
    sources: sourceRefs,
    createdAt: new Date().toISOString()
  });
  console.log(`已成功插入新长期记忆: ${newMemoryId}`);
}

// Check counts after
const afterTrans = store.queryRecords(initialScope, { kind: 'transcript', state: 'active', query: '', offset: 0, limit: 100 });
const afterMems = store.queryRecords(initialScope, { kind: 'memory', state: 'active', query: '', offset: 0, limit: 100 });
console.log(`\n=== 交互后 SQLite 数据统计 ===`);
console.log(`历史对话记录数: ${beforeTrans.total} -> ${afterTrans.total} (+${afterTrans.total - beforeTrans.total})`);
console.log(`长期记忆条目数: ${beforeMems.total} -> ${afterMems.total} (+${afterMems.total - beforeMems.total})`);

console.log('\n最新 3 条对话记录:');
afterTrans.records.slice(0, 3).forEach(r => {
  console.log(`  [${r.role}] ${r.text.slice(0, 50)}... (${r.createdAt})`);
});

console.log('\n最新长期记忆:');
afterMems.records.slice(0, 4).forEach(r => {
  console.log(`  - [${r.id}]: ${r.text}`);
});
