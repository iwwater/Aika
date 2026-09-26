/** Bounded silent real-model evaluation. This does not enable lifecycle memory in the general desktop backend. */
import { access, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { QwenMemoryTurnProvider, QwenSummaryProvider } from '../providers/qwen-memory-lifecycle.js';
import { QwenDialogueProvider } from '../providers/qwen-dialogue.js';
import { ProviderTransport } from '../providers/transport.js';
import { CHAT_ENDPOINT, EVALUATION_MODELS, IntegratedEvaluationAuthorizer } from './evaluation-authorizer.js';
import { contextInputUpperBound, memoryTurnInputUpperBound, summaryInputUpperBound } from './input-budgets.js';
import { runLifecycleScenarios } from './lifecycle-scenarios.js';
import { requireAssistantMemoryPort } from '../core/assistant-memory.js';
import { runSourceRegressionScenarios, type SourceCaseOptions } from './source-regression-scenarios.js';
import { copyFileSync, constants, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { runAbsenceRegressionScenario, runDialogueRegressionScenarios } from './dialogue-regression-scenarios.js';
import { runFrozenSourceScenarios } from './frozen-source-scenarios.js';
import { assertMemoryWireMode, type MemoryWireMode } from '../providers/memory-wire.js';
import { loadMemoryTrial, MemoryTrialCallGuard, reviewedTrialCount, runMemoryTrial } from './memory-trial.js';
import { buildMemoryTurnFormat } from '../providers/memory-turn-format.js';

export async function evaluateLifecycle(root: string, credentialFile: string, runId: string, suite: 'natural' | 'sources' | 'dialogue' | 'absence' | 'source-originals' | 'remaining-sources' | 'prompt-trial-known' | 'prompt-trial-holdout' = 'natural', memoryWireMode: MemoryWireMode = 'numeric-v1'): Promise<void> {
  if (!root.startsWith('/') || !credentialFile.startsWith('/') || !/^lifecycle-[a-z0-9-]+$/.test(runId)) throw new Error('Invalid explicit evaluation paths or run ID');
  if (!['natural', 'sources', 'dialogue', 'absence', 'source-originals', 'remaining-sources', 'prompt-trial-known', 'prompt-trial-holdout'].includes(suite)) throw new Error('Unknown lifecycle scenario suite');
  assertMemoryWireMode(memoryWireMode);
  if (memoryWireMode === 'quoted-v2' && (suite === 'dialogue' || suite === 'absence')) throw new Error('Memory wire mode is not applicable to a dialogue-only suite');
  const trialStage = suite === 'prompt-trial-known' ? 'known' : suite === 'prompt-trial-holdout' ? 'holdout' : null;
  if (trialStage && memoryWireMode !== 'quoted-v2') throw new Error('Bounded prompt trial requires explicit quoted-v2');
  if (trialStage && existsSync(`${root}/.local/prompt-trial-inputs/STOPPED.json`)) throw new Error('Bounded trial is stopped; no further candidate calls allowed');
  const trial = trialStage ? await loadMemoryTrial(root, trialStage) : null;
  const trialPromptHash = trial ? createHash('sha256').update(buildMemoryTurnFormat(trial.cases[0]!.input, 'quoted-v2').system).digest('hex') : null;
  const trialRoot = `${root}/.local/prompt-trial-inputs`;
  const trialIndex = trial ? await reviewedTrialCount(root, trial, trialPromptHash!) : 0;
  const trialCase = trial?.cases[trialIndex] ?? null;
  if (trial && !trialCase) throw new Error('Trial stage already reviewed; no further calls allowed');
  const trialGuard = trial && trialCase ? new MemoryTrialCallGuard({ ...trial, cases: [trialCase] }) : null;
  if (trialStage === 'holdout') {
    const gate = JSON.parse(await readFile(`${trialRoot}/holdout-gate.json`, 'utf8'));
    const known = await loadMemoryTrial(root, 'known');
    if (gate.reviewedBy !== 'W0-I' || !gate.allFixedCasesPassed || gate.promptSha256 !== trialPromptHash || await reviewedTrialCount(root, known, trialPromptHash!) !== 8) throw new Error('Independent fixed-case review required before holdout');
    if (createHash('sha256').update(await readFile(`${trialRoot}/known-approvals.json`)).digest('hex') !== gate.knownApprovalsSha256) throw new Error('Known approvals changed after holdout gate review');
  }
  const countMemory = (input: MemoryTurnInput) => memoryTurnInputUpperBound(input, memoryWireMode);
  // Reviewed bounded expansion is enabled only for this synthetic evaluation.
  // Protocol failures never qualify, and the shared authorizer budgets every call.
  const maxSupplementaryPlans = 1 as const;
  const out = `${root}/.local/${runId}`;
  await access(out).then(() => { throw new Error('Evaluation run already exists'); }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  const credentialSource = await readFile(credentialFile, 'utf8');
  const section = credentialSource.match(/^## Qwen \/ DashScope\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  const keys = section?.match(/sk-[A-Za-z0-9_-]+/g) ?? [];
  if (keys.length !== 1) throw new Error('Credential section is ambiguous');
  const ledgerRoot = `${root}/.local/model-evaluation`;
  await mkdir(ledgerRoot, { recursive: true });
  const lockPath = `${ledgerRoot}/backend.lock`, lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, purpose: runId, startedAt: new Date().toISOString() }) + '\n');
  const trace: Record<string, unknown>[] = [];
  const planTrace: Record<string, unknown>[] = [];
  const seedFingerprints: Record<string, string> = {};
  const originalFailureDatabase = `${root}/.local/lifecycle-live-v1/natural.sqlite`;
  const closureRoot = `${root}/.local/source-budget-v2`;
  const codeRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  let trialClaimed = false;
  class SyntheticTransport extends ProviderTransport {
    override async request(...args: Parameters<ProviderTransport['request']>) {
      if (trialGuard) {
        if (args[2] !== 'memory_turn') throw new Error('Bounded trial cannot call dialogue, summary, perception or TTS');
        trialGuard.beforeRequest(args[1]);
        if (!trialClaimed) {
          const pin = `${trialRoot}/candidate.json`;
          try { await writeFile(pin, JSON.stringify({ promptSha256: trialPromptHash, firstRunId: runId }) + '\n', { flag: 'wx' }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (JSON.parse(await readFile(pin, 'utf8')).promptSha256 !== trialPromptHash) throw new Error('Only one prompt candidate may receive actual trial calls');
          }
          await writeFile(`${trialRoot}/${trialStage}-${trialCase!.id}-call-owner.json`, JSON.stringify({ runId, codeRef, promptSha256: trialPromptHash, stage: trialStage, claimedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
          trialClaimed = true;
        }
      }
      const started = performance.now();
      const record: Record<string, unknown> = { scope: args[1], operation: args[2], inputMessages: args[3].messages, synthetic: true };
      try {
        const result = await super.request(...args);
        const choices = result.choices as { message?: { content?: unknown } }[] | undefined;
        record.modelText = choices?.[0]?.message?.content ?? null; record.usage = result.usage ?? null;
        return result;
      } catch (error) { record.errorName = error instanceof Error ? error.name : 'unknown'; throw error; }
      finally { record.elapsedMs = Math.round(performance.now() - started); trace.push(record); }
    }
  }
  class SyntheticMemoryTurnProvider extends QwenMemoryTurnProvider {
    override async plan(...args: Parameters<QwenMemoryTurnProvider['plan']>) {
      const record: Record<string, unknown> = { input: structuredClone(args[0]), inputUpperBound: countMemory(args[0]), memoryWireMode, synthetic: true };
      try {
        const plan = await super.plan(...args);
        record.parsedPlan = structuredClone(plan); return plan;
      } catch (error) { record.errorName = error instanceof Error ? error.name : 'unknown'; throw error; }
      finally { planTrace.push(record); }
    }
  }
  const authorizer = new IntegratedEvaluationAuthorizer(ledgerRoot), transport = new SyntheticTransport();
  const config = (model: string) => ({ model, endpoint: CHAT_ENDPOINT, apiKey: () => keys[0]!, authorizer });
  let completed = false;
  try {
    const createCase = (name: string, options: SourceCaseOptions = {}) => {
      const filename = `${out}/${name}.sqlite`;
      if (options.reopen !== true && existsSync(filename)) throw new Error('Scenario database already exists');
      if (options.reopen === true && !existsSync(filename)) throw new Error('Reopen requires an existing scenario database');
      if (options.seedDatabase) {
        if (options.reopen || ![originalFailureDatabase, `${closureRoot}/synthetic.sqlite`].includes(options.seedDatabase) || existsSync(`${options.seedDatabase}-wal`)) throw new Error('Unverified fixture database copy');
        copyFileSync(options.seedDatabase, filename, constants.COPYFILE_EXCL);
        // The source stays immutable. Fingerprint the exact copied database used by this run.
        seedFingerprints[name] = createHash('sha256').update(readFileSync(filename)).digest('hex');
      }
      const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), ...(options.now ? { clock: () => options.now! } : {}) });
      try {
        const memory = new SqliteLifecycleMemoryPort(store, {
          context: { inputTokenBudget: 32_768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, countTokens: contextInputUpperBound, relevance: () => 1 },
          turn: { provider: new SyntheticMemoryTurnProvider(config(EVALUATION_MODELS.memory_turn), transport, memoryWireMode), inputTokenBudget: 32_768, countTokens: countMemory, maxSupplementaryPlans },
          // Small explicit fixture threshold exercises actual generation; it does not change production policy.
          summary: { provider: new QwenSummaryProvider(config(EVALUATION_MODELS.summary), transport), minMessages: 4, maxMessages: 4, inputTokenBudget: 32_768, countTokens: summaryInputUpperBound },
        });
        return { store, memory: requireAssistantMemoryPort(memory), dialogue: new QwenDialogueProvider(config(EVALUATION_MODELS.dialogue), transport) };
      } catch (error) { store.close(); throw error; }
    };
    if (trial) {
      await runMemoryTrial(out, trial, createCase, countMemory, trialCase!.id);
    } else if (suite === 'source-originals') {
      await runFrozenSourceScenarios(out, `${root}/.local/lifecycle-sources-v1`, createCase, countMemory);
    } else if (suite === 'absence') {
      await runAbsenceRegressionScenario(out, `${root}/.local/lifecycle-sources-v1`, new QwenDialogueProvider(config(EVALUATION_MODELS.dialogue), transport));
    } else if (suite === 'dialogue') {
      await runDialogueRegressionScenarios(out, `${root}/.local/lifecycle-live-v4`, new QwenDialogueProvider(config(EVALUATION_MODELS.dialogue), transport));
    } else if (suite === 'sources' || suite === 'remaining-sources') {
      const input = JSON.parse(await readFile(`${closureRoot}/complete-input.json`, 'utf8')) as MemoryTurnInput;
      const manifest = JSON.parse(await readFile(`${closureRoot}/manifest.json`, 'utf8'));
      if (createHash('sha256').update(JSON.stringify(input)).digest('hex') !== manifest.snapshotSha256) throw new Error('Complete source snapshot changed');
      await runSourceRegressionScenarios(out, originalFailureDatabase, createCase, { database: `${closureRoot}/synthetic.sqlite`, input }, suite === 'remaining-sources' ? 'closure-and-maintenance' : 'all');
    }
    else await runLifecycleScenarios(out, createCase);
    completed = true;
  } finally {
    try {
      await mkdir(out, { recursive: true });
      await writeFile(`${out}/model-responses.json`, JSON.stringify(trace, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await writeFile(`${out}/plan-traces.json`, JSON.stringify(planTrace, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await writeFile(`${out}/manifest.json`, JSON.stringify({ codeRef, suite, memoryWireMode, summaryWireMode: 'numeric-v1', seedFingerprints, actualProvider: true, model: EVALUATION_MODELS.memory_turn, completedScenariosRunner: completed, physicalDevices: false, ttsRequested: false, automaticRetry: false, maxSupplementaryPlans, syntheticInputsOnly: true, generationCalls: trace.length, summaryFixtureThreshold: 4, genericBackendLifecycleEnabled: false, ...(trial ? { trialStage, trialSelectedCaseId: trialCase!.id, trialPromptHash, trialStageCallLimit: trialStage === 'known' ? 9 : 3, trialCaseCallLimit: trialCase!.maxPlans, trialTotalCallLimit: 12, semanticReviewRequired: true } : {}), retention: 'Synthetic databases and traces pinned while used for memory acceptance; no original user content or credentials.' }, null, 2) + '\n', { flag: 'wx' });
    } finally { await lock.close(); await unlink(lockPath); }
  }
}
