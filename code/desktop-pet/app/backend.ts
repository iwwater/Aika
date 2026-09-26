/** Native shell child process. Requires explicit project evaluation configuration; no paid work at startup. */
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteMemoryPort } from '../memory/sqlite-port.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { QwenDialogueProvider, QwenMemoryMaintenanceProvider } from '../providers/qwen-dialogue.js';
import { QwenPerceptionProvider } from '../providers/qwen-perception.js';
import { QwenTtsProvider } from '../providers/qwen-tts.js';
import { MemoryMediaStore } from '../media/store.js';
import { BackendSession } from './backend-session.js';
import { CHAT_ENDPOINT, TTS_ENDPOINT, EVALUATION_MODELS, IntegratedEvaluationAuthorizer } from './evaluation-authorizer.js';
import { contextInputUpperBound } from './input-budgets.js';
export { contextInputUpperBound } from './input-budgets.js';

export async function startBackend(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const projectRoot = environment.PET_PROJECT_ROOT;
  const filename = environment.PET_DATABASE;
  const credentialFile = environment.PET_CREDENTIAL_FILE;
  if (environment.PET_EVALUATION_BATCH !== 'D09-S1-20260906-01' || !projectRoot || !isAbsolute(projectRoot) || !filename || !isAbsolute(filename) || !credentialFile || !isAbsolute(credentialFile)) throw new Error('Explicit authorized evaluation configuration is required');
  const source = await readFile(credentialFile, 'utf8');
  const section = source.match(/^## Qwen \/ DashScope\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  const keys = section?.match(/sk-[A-Za-z0-9_-]+/g) ?? [];
  if (keys.length !== 1) throw new Error('Credential section is ambiguous');
  const authorizer = new IntegratedEvaluationAuthorizer(`${projectRoot}/.local/model-evaluation`);
  const apiKey = () => keys[0]!;
  const modelConfig = (model: string) => ({ endpoint: CHAT_ENDPOINT, model, apiKey, authorizer });
  const evidenceRoot = `${projectRoot}/.local/model-evaluation`;
  await mkdir(evidenceRoot, { recursive: true });
  // A second desktop backend cannot become another paid evaluation writer.
  // After a crash, inspect the recorded PID before manually clearing this file.
  const lockPath = `${evidenceRoot}/backend.lock`, lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  const releaseLock = async () => { await lock.close(); await unlink(lockPath); };
  let store: SqliteMemoryStore;
  try { store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') }); }
  catch (error) { await releaseLock(); throw error; }
  const mediaStore = new MemoryMediaStore();
  const memory = new SqliteMemoryPort(store, {
    inputTokenBudget: 32_768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8,
    countTokens: contextInputUpperBound,
    // Store.contextRecords already restricts results to matching current-role lexical terms.
    // This retains their candidate set; it is not a claim of semantic retrieval quality.
    relevance: () => 1,
  }, new QwenMemoryMaintenanceProvider(modelConfig(EVALUATION_MODELS.memory_maintenance)));
  const session = new BackendSession({ memory, mediaStore,
    perception: new QwenPerceptionProvider({ ...modelConfig(EVALUATION_MODELS.perception), cueLifetimeMs: 5 * 60_000 }, mediaStore),
    dialogue: new QwenDialogueProvider(modelConfig(EVALUATION_MODELS.dialogue)),
    tts: new QwenTtsProvider({ ...modelConfig(EVALUATION_MODELS.tts), endpoint: TTS_ENDPOINT, voice: 'Cherry', language: 'Chinese' }, mediaStore),
  }, message => process.stdout.write(JSON.stringify(message) + '\n'), () => store.close());
  // Startup/append already enforce retention; idle cleanup also expires soft-deleted memory.
  const cleanupTimer = setInterval(() => { try { store.cleanup(); } catch { process.stderr.write('Local memory cleanup did not complete\n'); } }, 60_000);
  cleanupTimer.unref();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let stopping = false;
  const close = async () => {
    if (stopping) return; stopping = true; clearInterval(cleanupTimer); lines.close(); process.stdin.pause();
    try { await session.close(); } finally { await releaseLock(); }
  };
  // Never await a long device/model operation in the input loop: cancellation must remain readable.
  lines.on('line', line => { void session.receiveLine(line); });
  lines.on('close', () => { void close(); });
  process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBackend().catch(() => { process.stderr.write('Backend startup failed; check the explicit local evaluation configuration.\n'); process.exitCode = 1; });
}
