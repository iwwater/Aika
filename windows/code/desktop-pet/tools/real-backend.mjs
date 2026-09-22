// Real LLM backend for Aika Desktop Pet
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { COMPANION_ID } from '../dist/contracts/character.js';
import { DESKTOP_BRIDGE_VERSION } from '../dist/contracts/desktop-bridge.js';
import { OpenAiCompatibleDialogueProvider } from '../dist/providers/aika-dialogue.js';
import { ProviderTransport } from '../dist/providers/transport.js';

import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../dist/memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../dist/core/trace-store.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.PET_DATABASE && existsSync(process.env.PET_DATABASE)
  ? process.env.PET_DATABASE
  : existsSync(resolve(root, '../../.local/data/companion.sqlite'))
    ? resolve(root, '../../.local/data/companion.sqlite')
    : resolve(root, '.local/data/companion.sqlite');

let memoryStore = null;
let traceStore = null;
try {
  memoryStore = new SqliteMemoryStore({
    filename: dbPath,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai')
  });
  traceStore = RuntimeTraceStore.open(dbPath);
} catch (e) {
  process.stderr.write(`无法加载 SQLite 存储库: ${e.message}\n`);
}

const sessionId = randomUUID();
let generation = 0;
const history = [];

let key = process.env.NEXT_REAL_LLM_KEY?.trim();
let endpoint = process.env.NEXT_REAL_LLM_ENDPOINT?.trim();
let model = process.env.NEXT_REAL_LLM_MODEL?.trim();

if (!key || !endpoint || !model) {
  const envPath = existsSync(resolve(root, '.env')) ? resolve(root, '.env') : existsSync(resolve(root, '../../.env')) ? resolve(root, '../../.env') : null;
  if (envPath) {
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const [k, ...v] = line.split('=');
        if (k && !k.trim().startsWith('#')) {
          const val = v.join('=').trim();
          if (k.trim() === 'NEXT_REAL_LLM_KEY' && !key) key = val;
          if (k.trim() === 'NEXT_REAL_LLM_ENDPOINT' && !endpoint) endpoint = val;
          if (k.trim() === 'NEXT_REAL_LLM_MODEL' && !model) model = val;
        }
      }
    } catch {}
  }
}

const missingConfig = [
  !key && 'NEXT_REAL_LLM_KEY',
  !endpoint && 'NEXT_REAL_LLM_ENDPOINT',
  !model && 'NEXT_REAL_LLM_MODEL',
].filter(Boolean);
if (missingConfig.length) {
  process.stderr.write(`真实后端未配置必要环境变量: ${missingConfig.join(', ')}\n`);
  process.exit(2);
}

const transport = new ProviderTransport();
const provider = new OpenAiCompatibleDialogueProvider(
  transport,
  {
    endpoint, model, apiKey: () => key,
    authorizer: { async authorize() { return { async settle() {} }; } }
  },
  '你是桌宠伴侣Aika，性格活泼、温柔、俏皮，对用户充满好奇与陪伴感。回复语言简洁生动，每次回复控制在1-3句话以内。'
);

const expression = { emotion: 'happy', intensity: 0.5, delivery: '欢快', gesture: null };
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

send({
  channel: 'backend_ready',
  bridgeVersion: DESKTOP_BRIDGE_VERSION,
  characterId: COMPANION_ID,
  sessionId,
  introduction: {
    id: 'windows-real',
    text: '真实大模型服务已连接（Gemini 3.1 Flash），你可以直接在下方输入框和我聊天啦！'
  }
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.channel !== 'command') return;
  const c = message.command;

  if (c.type === 'submit_text') {
    const turnStart = performance.now();
    const stages = [];
    const scope = { characterId: COMPANION_ID, sessionId, turnId: randomUUID(), generation: ++generation };
    send({ channel: 'event', event: { type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: c.text, ...(c.clientRequestId ? { clientRequestId: c.clientRequestId } : {}) } } });
    send({ channel: 'input_route', scope, route: 'companion' });
    send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'thinking', expression, mouth: 0 } } });

    stages.push({
      name: 'admission',
      label: '意图路由与准入',
      elapsedMs: 2,
      status: 'ok',
      details: { route: 'companion', inputLength: c.text.length }
    });

    history.push({ role: 'user', content: c.text });
    if (history.length > 20) history.splice(0, history.length - 20);

    // Fetch active memories from real SQLite store
    const contextStart = performance.now();
    const readScope = { characterId: COMPANION_ID, sessionId: 'management', turnId: 'read', generation: 0 };
    let loadedMemories = [];
    try {
      if (memoryStore) {
        const memRecords = memoryStore.queryRecords(readScope, { kind: 'memory', state: 'active', limit: 10 });
        loadedMemories = memRecords.records.map(r => ({ id: r.id, text: r.text }));
      }
    } catch {}
    const contextElapsed = Math.max(1, Math.round(performance.now() - contextStart));
    stages.push({
      name: 'context',
      label: '记忆与上下文组装',
      elapsedMs: contextElapsed,
      status: 'ok',
      details: {
        memoryCount: loadedMemories.length,
        recentHistoryCount: history.length,
        retrievedMemories: loadedMemories.map(m => m.text)
      }
    });

    try {
      const llmStart = performance.now();
      const reply = await provider.reply({
        scope,
        text: c.text,
        context: {
          scope,
          characterPrompt: '你是桌宠伴侣Aika，青梅竹马设定，温暖真诚。回复简短生动，1-3句话。',
          recent: history.map(h => ({ role: h.role, text: h.content })),
          summary: '',
          memories: loadedMemories
        }
      }, new AbortController().signal);

      const llmElapsed = Math.max(1, Math.round(performance.now() - llmStart));
      const replyText = reply.text || '我在这里哦！';
      history.push({ role: 'assistant', content: replyText });

      const approxInputTokens = Math.ceil((c.text.length + loadedMemories.reduce((acc, m) => acc + m.text.length, 0) + 150) / 1.5);
      const approxOutputTokens = Math.ceil(replyText.length / 1.5);

      stages.push({
        name: 'llm',
        label: '大模型回复生成',
        elapsedMs: llmElapsed,
        status: 'ok',
        details: {
          model,
          inputTokens: approxInputTokens,
          outputTokens: approxOutputTokens,
        }
      });

      // Persist real conversation turn to SQLite memoryStore
      const userMsgId = `${scope.turnId}:user`;
      const asstMsgId = `${scope.turnId}:assistant`;
      if (memoryStore) {
        try {
          const userMsg = {
            characterId: COMPANION_ID,
            id: userMsgId,
            role: 'user',
            text: c.text,
            createdAt: new Date().toISOString(),
            origin: 'conversation'
          };
          const asstMsg = {
            characterId: COMPANION_ID,
            id: asstMsgId,
            role: 'assistant',
            text: replyText,
            createdAt: new Date().toISOString(),
            origin: 'conversation'
          };
          memoryStore.append(scope, [userMsg, asstMsg]);
        } catch (e) {
          process.stderr.write(`写入记忆库失败: ${e.message}\n`);
        }
      }

      send({ channel: 'event', event: { type: 'reply', reply: { scope, text: replyText, expression } } });
      send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'speaking', expression, mouth: 0.6 } } });
      setTimeout(() => {
        send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'idle', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }, mouth: 0 } } });
      }, 1000);

      // Trigger asynchronous background memory distillation
      (async () => {
        const distillStart = performance.now();
        let distilledFact = null;
        try {
          const distillPrompt = `你是一个严谨的AI桌面伴侣记忆提炼器。请分析以下这一轮用户与Aika的对话，判断用户是否透露了关于自己的长期稳定事实、姓名身份、生活习惯、个人喜好或重大经历。
【对话内容】
用户：${c.text}
Aika：${replyText}

【提炼准则】
1. 如果用户透露了值得长期记住的新事实（例如名字身份、习惯爱好、生日日程、重要目标等），提取1条精炼客观的事实陈述（主语必须是“用户”，如：“用户平时喜欢喝无糖乌龙茶”）。
2. 如果只是日常打招呼、闲聊、简单追问或无长期记忆价值的互动，判定为无新事实。
3. 请以严格的 JSON 格式输出，不要有 Markdown 代码块或额外文字：
若有新事实输出：{"hasMemory": true, "fact": "用户平时喜欢喝无糖乌龙茶", "category": "preference"}
若无新事实输出：{"hasMemory": false}`;

          const distillScope = { characterId: COMPANION_ID, sessionId, turnId: randomUUID(), generation: 0 };
          const distillRes = await transport.request(
            {
              endpoint,
              model,
              apiKey: () => key,
              authorizer: { async authorize() { return { async settle() {} }; } }
            },
            distillScope,
            'memory_turn',
            {
              model,
              messages: [{ role: 'user', content: distillPrompt }],
              temperature: 0.1
            },
            new AbortController().signal
          );

          let parsed = null;
          try {
            const rawContent = distillRes?.choices?.[0]?.message?.content || '';
            const cleaned = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
            parsed = JSON.parse(cleaned);
          } catch {}

          if (parsed?.hasMemory && parsed?.fact && typeof parsed.fact === 'string' && parsed.fact.trim()) {
            distilledFact = parsed.fact.trim();
            if (memoryStore) {
              const memId = `mem-auto-${randomUUID().slice(0, 8)}`;
              const nowIso = new Date().toISOString();
              const nowMs = Date.now();
              const db = memoryStore.rawDatabaseForKnowledge();
              db.prepare(`
                INSERT OR REPLACE INTO memory_records (
                  character_id, id, kind, state, version, text,
                  sources_json, created_at, created_ms, transcript_bytes,
                  logical_order, evidence_eligible, origin
                ) VALUES (?, ?, 'memory', 'active', 1, ?, ?, ?, ?, 0, 0, 1, 'automatic')
              `).run(
                COMPANION_ID,
                memId,
                distilledFact,
                JSON.stringify([{ id: userMsgId, version: 1 }, { id: asstMsgId, version: 1 }]),
                nowIso,
                nowMs
              );
              try {
                db.prepare(`INSERT INTO memory_search (rowid, text) VALUES ((SELECT rowid FROM memory_records WHERE id = ?), ?)`).run(memId, distilledFact);
              } catch {}
            }
          }

          const distillElapsed = Math.max(1, Math.round(performance.now() - distillStart));
          stages.push({
            name: 'distill',
            label: '记忆自动提炼与归档',
            elapsedMs: distillElapsed,
            status: 'ok',
            details: {
              hasMemory: !!distilledFact,
              fact: distilledFact || '本轮无新增长期事实'
            }
          });
        } catch (distillErr) {
          const distillElapsed = Math.max(1, Math.round(performance.now() - distillStart));
          stages.push({
            name: 'distill',
            label: '记忆自动提炼',
            elapsedMs: distillElapsed,
            status: 'failed',
            details: { error: distillErr.message }
          });
        } finally {
          if (traceStore) {
            const totalElapsed = Math.round(performance.now() - turnStart);
            traceStore.record({
              traceId: randomUUID(),
              turnId: scope.turnId,
              characterId: COMPANION_ID,
              sessionId,
              userText: c.text,
              replyText,
              totalElapsedMs: totalElapsed,
              status: 'ok',
              tokens: {
                inputTokens: approxInputTokens,
                outputTokens: approxOutputTokens,
                totalTokens: approxInputTokens + approxOutputTokens
              },
              stages,
              createdAt: new Date().toISOString()
            });
          }
        }
      })();

    } catch (err) {
      const totalElapsed = Math.round(performance.now() - turnStart);
      stages.push({
        name: 'llm',
        label: '大模型生成',
        elapsedMs: totalElapsed,
        status: 'failed',
        details: { error: err.message }
      });
      if (traceStore) {
        traceStore.record({
          traceId: randomUUID(),
          turnId: scope.turnId,
          characterId: COMPANION_ID,
          sessionId,
          userText: c.text,
          replyText: `[异常] ${err.message}`,
          totalElapsedMs: totalElapsed,
          status: 'failed',
          stages,
          createdAt: new Date().toISOString()
        });
      }
      send({ channel: 'event', event: { type: 'reply', reply: { scope, text: `大模型请求异常: ${err.message}`, expression: { emotion: 'sad', intensity: 0.5, delivery: '', gesture: null } } } });
      send({ channel: 'event', event: { type: 'presentation', presentation: { scope, state: 'idle', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }, mouth: 0 } } });
    }
  } else if (c.type === 'start_voice' || c.type === 'click_invitation') {
    send({ channel: 'event', event: { type: 'error', scope: null, message: '当前为真实文本对话模式，语音需要配置独立麦克风输入。' } });
  }
});
