/** Silent real-model memory evaluation with synthetic dialogues. Never opens audio devices. */
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteMemoryPort } from '../memory/sqlite-port.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { QwenMemoryMaintenanceProvider } from '../providers/qwen-dialogue.js';
import { CHAT_ENDPOINT, EVALUATION_MODELS, IntegratedEvaluationAuthorizer } from './evaluation-authorizer.js';
import { contextInputUpperBound } from './backend.js';
import type { MemoryChange, MemoryMaintenanceInput, TurnScope } from '../contracts/index.js';
import { ProviderTransport } from '../providers/transport.js';

export async function evaluateMemory(root: string, credentialFile: string, options: { runId?: string; onlyAdd?: boolean } = {}): Promise<void> {
  const runId = options.runId ?? 'memory-live-v1';
  if (!/^memory-[a-z0-9-]+$/.test(runId)) throw new Error('Invalid evaluation run ID');
  const out = `${root}/.local/${runId}`;
  await mkdir(out, { recursive: true });
  const source = await readFile(credentialFile, 'utf8');
  const section = source.match(/^## Qwen \/ DashScope\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  const keys = section?.match(/sk-[A-Za-z0-9_-]+/g) ?? [];
  if (keys.length !== 1) throw new Error('Credential section ambiguous');
  const lockPath = `${root}/.local/model-evaluation/backend.lock`, lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, purpose: 'silent_memory_evaluation' }) + '\n');
  let rawModelText: unknown = null;
  class SyntheticEvidenceTransport extends ProviderTransport {
    override async request(...args: Parameters<ProviderTransport['request']>) {
      const result = await super.request(...args);
      // Only this synthetic evaluator records returned model text. Never record URLs/headers.
      const choices = result.choices as { message?: { content?: unknown } }[] | undefined;
      rawModelText = choices?.[0]?.message?.content ?? null;
      return result;
    }
  }
  const provider = new QwenMemoryMaintenanceProvider({ endpoint: CHAT_ENDPOINT, model: EVALUATION_MODELS.memory_maintenance, apiKey: () => keys[0]!, authorizer: new IntegratedEvaluationAuthorizer(`${root}/.local/model-evaluation`) }, new SyntheticEvidenceTransport());
  const reports: Record<string, unknown>[] = [];
  const scope = (turnId: string): TurnScope => ({ characterId: 'friend', sessionId: 'synthetic-memory-evaluation', turnId, generation: 1 });
  const createStore = (name: string) => new SqliteMemoryStore({ filename: `${out}/${name}.sqlite`, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const stores: SqliteMemoryStore[] = [];
  try {
    const store = createStore('natural-update'); stores.push(store);
    async function run(db: SqliteMemoryStore, id: string, text: string, expectedOperation: string, query: string) {
      const owned = scope(id);
      let input: MemoryMaintenanceInput | undefined, changes: readonly MemoryChange[] = [];
      const memory = new SqliteMemoryPort(db, { inputTokenBudget: 32_768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, countTokens: contextInputUpperBound, relevance: () => 1 }, {
        async propose(value, signal) { input = value; changes = await provider.propose(value, signal); return changes; },
      });
      const before = db.visible(owned, 'memory');
      await memory.append(owned, [{ characterId: 'friend', id: `${id}:user`, role: 'user', text, createdAt: new Date().toISOString() }]);
      const report: Record<string, unknown> = { id, synthetic: true, expectedOperation, before };
      const started = performance.now();
      rawModelText = null;
      try {
        const results = await memory.maintain(memory.maintenanceInput(owned, query), AbortSignal.timeout(60_000));
        const applied = changes.filter(change => results.some(result => result.operationId === change.operationId && result.status === 'applied'));
        Object.assign(report, { results, expectedOperationApplied: applied.some(change => change.operation.type === expectedOperation), retrieved: db.search(owned, query, 32, 'lexical'), otherRoleResults: db.search({ ...owned, characterId: 'sweetheart' }, query, 32, 'lexical') });
      } catch (error) { report.errorType = error instanceof Error ? error.name : 'unknown'; report.errorClass = error instanceof Error && /^(?:Unsupported memory operation|Missing memory change array|Memory .+|Model .+|Expected string array|Invalid provider response .+)$/.test(error.message) ? error.message : 'evaluation_failure'; report.expectedOperationApplied = false; }
      Object.assign(report, { elapsedMs: Math.round(performance.now() - started), input, syntheticRawModelText: rawModelText, proposedChanges: changes, after: db.visible(owned, 'memory') });
      await writeFile(`${out}/${id}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); reports.push(report);
      console.log(JSON.stringify({ id, expectedOperationApplied: report.expectedOperationApplied, elapsedMs: report.elapsedMs }));
    }
    await run(store, 'natural-add', '最近我开始固定每周三晚上练吉他，这件事让我很开心。', 'add', '练吉他');
    if (options.onlyAdd) return;
    await run(store, 'natural-update', '吉他课时间调整好了：从这个月起固定改为每周五晚上，周三已经不练了。', 'update', '吉他');
    const merge = createStore('merge'); stores.push(merge); const ms = scope('merge-source');
    merge.append(ms, [{ characterId: 'friend', id: 'm-source-a', role: 'user', text: '我的固定练琴日是周五晚上。', createdAt: new Date().toISOString() }, { characterId: 'friend', id: 'm-source-b', role: 'user', text: '每到周五晚上我都会练吉他。', createdAt: new Date().toISOString() }]);
    for (const [id, text, sourceId] of [['m-a', '用户每周五晚上固定练吉他。', 'm-source-a'], ['m-b', '用户固定在周五晚上练琴，乐器是吉他。', 'm-source-b']] as const) merge.apply({ scope: ms, operationId: `seed:${id}`, reason: 'Synthetic duplicate fixture', createdAt: new Date().toISOString(), operation: { type: 'add', id, text, sourceIds: [sourceId] } });
    await run(merge, 'automatic-merge', '今晚又是周五，我照常去练吉他，练完之后感觉很轻松。', 'merge', '练 吉他 周五');
    const remove = createStore('obsolete-event'); stores.push(remove); const ds = scope('obsolete-source');
    remove.append(ds, [{ characterId: 'friend', id: 'event-source', role: 'user', text: '我明天要参加一个临时项目的面试，正等着面试通知。', createdAt: new Date().toISOString() }]);
    remove.apply({ scope: ds, operationId: 'seed:event', reason: 'Synthetic temporary event fixture', createdAt: new Date().toISOString(), operation: { type: 'add', id: 'temporary-interview', text: '用户明天将参加临时项目面试，正在等候通知。', sourceIds: ['event-source'] } });
    await run(remove, 'automatic-delete', '那个临时项目刚刚解散了，原定的面试已经取消，之后也不会再安排。我今天在看别的工作机会。', 'soft_delete', '临时 项目 面试');
  } finally {
    for (const store of stores) store.close();
    await lock.close(); await unlink(lockPath);
    await writeFile(`${out}/manifest.json`, JSON.stringify({ codeRef: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), model: EVALUATION_MODELS.memory_maintenance, actualProvider: true, syntheticInputs: true, devicePlayback: false, automaticRetry: false, scenarios: reports.map(r => ({ id: r.id, expectedOperationApplied: r.expectedOperationApplied })), retention: 'Synthetic SQLite and traces retained while cited for A11/A19 review; no original user content or credentials' }, null, 2) + '\n');
  }
}
