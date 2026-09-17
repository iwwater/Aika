/** Authorized one-case-at-a-time comparison; never enables the general backend. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { DeepSeekMemoryTurnProvider } from '../providers/deepseek-memory-lifecycle.js';
import { ProviderTransport } from '../providers/transport.js';
import { buildMemoryTurnFormat } from '../providers/memory-turn-format.js';
import { requireAssistantMemoryPort } from '../core/assistant-memory.js';
import { contextInputUpperBound, memoryTurnInputUpperBound } from './input-budgets.js';
import { MemoryTrialCallGuard, runMemoryTrial } from './memory-trial.js';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL, DEEPSEEK_PHASE, DeepSeekComparisonAuthorizer } from './deepseek-comparison-budget.js';
import { assertComparisonOpen, COMPARISON_PROMPT_SHA, comparisonHash, loadDeepSeekComparison, normalizedComparisonInput, reviewedComparisonCount } from './deepseek-comparison-phase.js';

export async function cleanupDeepSeekCredential(root: string, credentialFile: string, reason: string): Promise<void> {
  assert.ok(isAbsolute(credentialFile) && basename(credentialFile) === 'api-key' && basename(dirname(credentialFile)).startsWith('movefile-deepseek-comparison-'));
  const stat = await lstat(credentialFile); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  await unlink(credentialFile);
  await writeFile(`${root}/.local/deepseek-comparison/credential-cleanup.json`, JSON.stringify({ deleted: true, deletedAt: new Date().toISOString(), reason, scope: 'Only explicit task temporary api-key file outside project. User original credentials unchanged.', secretCopied: false, directoryRetained: true }) + '\n', { flag: 'wx' });
}

export async function evaluateDeepSeekComparison(root: string, credentialFile: string, runId: string): Promise<void> {
  assert.ok(isAbsolute(root) && isAbsolute(credentialFile)); assert.match(runId, /^lifecycle-deepseek-[a-z0-9-]+$/);
  // Completed/stopped runs refuse before touching the temporary credential.
  const phase = await loadDeepSeekComparison(root);
  const board = JSON.parse(await readFile(`${root}/docs/agent/blackboard/CURRENT.json`, 'utf8'));
  assert.equal(board.deepseek_comparison.status, 'ready_for_bounded_comparison', 'Integrated comparison must be published ready before generation');
  assert.equal(comparisonHash(await readFile(`${root}/.local/deepseek-comparison/inputs-manifest.json`)), board.deepseek_comparison.inputs_manifest_sha256);
  const index = await reviewedComparisonCount(root, phase.bundle, phase.configSha256);
  const fixture = phase.bundle.cases[index]; assert.ok(fixture, 'All comparison cases already reviewed');
  const directory = `${root}/.local/deepseek-comparison`, out = `${root}/.local/${runId}`;
  await access(out).then(() => { throw new Error('Comparison output already exists'); }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  assert.equal(basename(credentialFile), 'api-key'); assert.ok(basename(dirname(credentialFile)).startsWith('movefile-deepseek-comparison-'));
  const stat = await lstat(credentialFile), parent = await lstat(dirname(credentialFile));
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && parent.isDirectory() && !parent.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(parent.mode & 0o777, 0o700);
  let key = (await readFile(credentialFile, 'utf8')).trim(); assert.ok(key && !/\s/.test(key), 'Invalid temporary credential format');
  const lockPath = `${root}/.local/model-evaluation/backend.lock`, lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, phase: DEEPSEEK_PHASE, runId, startedAt: new Date().toISOString() }) + '\n');
  const codeRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const countMemory = (input: MemoryTurnInput) => memoryTurnInputUpperBound(input, 'quoted-v2');
  const guard = new MemoryTrialCallGuard({ ...phase.bundle, cases: [fixture] });
  const trace: Record<string, unknown>[] = [], plans: Record<string, unknown>[] = [], stores: SqliteMemoryStore[] = [];
  let networkPosts = 0;
  let claimed = false, failed = true, fatal: unknown;
  const authorizer = new DeepSeekComparisonAuthorizer(root, fixture.id);
  class CapturingTransport extends ProviderTransport {
    override async request(...args: Parameters<ProviderTransport['request']>) {
      await assertComparisonOpen(root); assert.equal(args[2], 'memory_turn'); guard.beforeRequest(args[1]);
      assert.equal(args[0].endpoint, DEEPSEEK_ENDPOINT); assert.equal(args[0].model, DEEPSEEK_MODEL);
      assert.deepEqual(Object.keys(args[3]).sort(), ['messages', 'response_format', 'stream', 'thinking']);
      assert.deepEqual(args[3].thinking, { type: 'disabled' }); assert.equal(args[3].stream, false);
      assert.deepEqual(args[3].response_format, { type: 'json_object' });
      if (!claimed) {
        await writeFile(`${directory}/${fixture!.id}-call-owner.json`, JSON.stringify({ runId, codeRef, configSha256: phase.configSha256, claimedAt: new Date().toISOString() }) + '\n', { flag: 'wx' }); claimed = true;
      }
      const started = performance.now(), record: Record<string, unknown> = { scope: args[1], operation: args[2], requestBody: structuredClone(args[3]), requestedModel: DEEPSEEK_MODEL, endpoint: DEEPSEEK_ENDPOINT, synthetic: true };
      try {
        const result = await super.request(...args);
        // Only provider response data, never config/headers/key. Retain the unchanged model completion.
        record.response = result; record.usage = result.usage ?? null;
        return result;
      } catch (error) { record.errorName = error instanceof Error ? error.name : 'unknown'; record.errorMessage = error instanceof Error ? error.message : 'Unknown comparison transport error'; throw error; }
      finally { record.elapsedMs = Math.round(performance.now() - started); trace.push(record); }
    }
  }
  try {
    const transport = new CapturingTransport(async (...args) => { networkPosts++; return fetch(...args); });
    await runMemoryTrial(out, phase.bundle, (id, options = {}) => {
      const store = new SqliteMemoryStore({ filename: `${out}/${id}.sqlite`, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), ...(options.now ? { clock: () => options.now! } : {}) }); stores.push(store);
      const provider = new DeepSeekMemoryTurnProvider({ endpoint: DEEPSEEK_ENDPOINT, model: DEEPSEEK_MODEL, apiKey: () => key, authorizer }, transport);
      let planCount = 0;
      const turn = { async plan(input: MemoryTurnInput, signal: AbortSignal) {
        assert.equal(id, fixture.id); assert.ok(countMemory(input) <= 32768, 'Comparison input exceeds the original budget');
        const format = buildMemoryTurnFormat(input, 'quoted-v2'); assert.equal(comparisonHash(format.system), COMPARISON_PROMPT_SHA);
        const expected = planCount === 0 ? fixture.input : phase.expanded;
        if (planCount > 0) assert.equal(id, 'closure', 'Only original closure may request one necessary expansion');
        assert.deepEqual(normalizedComparisonInput(input), normalizedComparisonInput(expected), 'Actual comparison input differs from frozen original');
        planCount++;
        const snapshot = () => (['transcript', 'memory', 'summary', 'keyword_index', 'vector_index', 'context_cache'] as const).flatMap(kind => store.visible(input.scope, kind)).sort((a, b) => a.id.localeCompare(b.id));
        const record: Record<string, unknown> = { input: structuredClone(input), inputUpperBound: countMemory(input), wireMode: 'quoted-v2', sourcesBeforeCall: structuredClone(snapshot()), synthetic: true };
        try { const plan = await provider.plan(input, signal); record.parsedPlan = structuredClone(plan); return plan; }
        catch (error) { record.errorName = error instanceof Error ? error.name : 'unknown'; record.errorMessage = error instanceof Error ? error.message : 'Unknown plan error'; throw error; }
        finally { record.sourcesAfterPlanBeforeCommit = structuredClone(snapshot()); plans.push(record); }
      } };
      const memory = new SqliteLifecycleMemoryPort(store, {
        context: { inputTokenBudget: 32768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, countTokens: contextInputUpperBound, relevance: () => 1 },
        turn: { provider: turn, inputTokenBudget: 32768, countTokens: countMemory, maxSupplementaryPlans: 1 },
        summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw new Error('Comparison cannot generate summaries'); } } },
      });
      return { store, memory: requireAssistantMemoryPort(memory), dialogue: { async reply() { throw new Error('Comparison cannot generate dialogue'); } } };
    }, countMemory, fixture.id);
    const scenarios = JSON.parse(await readFile(`${out}/scenarios.json`, 'utf8'));
    failed = !scenarios.preflightPassed || scenarios.checks.length !== 1 || scenarios.checks[0].passed !== true;
  } catch (error) { fatal = error; }
  finally {
    try {
    for (const store of stores) if (!store.closed) store.close();
    await mkdir(out, { recursive: true });
    await writeFile(`${out}/model-responses.json`, JSON.stringify(trace, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(`${out}/plan-traces.json`, JSON.stringify(plans, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(`${out}/manifest.json`, JSON.stringify({ phase: DEEPSEEK_PHASE, codeRef, model: DEEPSEEK_MODEL, selectedCaseId: fixture.id, configSha256: phase.configSha256, promptSha256: COMPARISON_PROMPT_SHA, generationCalls: networkPosts, transportAttempts: trace.length, automaticChecksPassed: !failed, independentReviewRequired: true, maxCalls: 4, caseMaxCalls: fixture.maxPlans, errorClass: fatal instanceof Error ? fatal.name : null, allStoresClosed: stores.every(store => store.closed), physicalDevices: false, dialogue: false, summary: false, tts: false, genericBackendLifecycleEnabled: false, wholeAcceptancePassed: false, retention: 'Pin original inputs, outputs and executed database until acceptance references released. Unexecuted disposable databases may be cleaned after closed-state review.' }, null, 2) + '\n', { flag: 'wx' });
    if (failed) {
      await writeFile(`${directory}/STOPPED.json`, JSON.stringify({ phase: DEEPSEEK_PHASE, runId, caseId: fixture.id, reason: 'First protocol, semantic, network or execution failure; no remaining comparison calls.', callsInRun: networkPosts }) + '\n', { flag: 'wx' });
      await cleanupDeepSeekCredential(root, credentialFile, `comparison stopped at ${fixture.id}`);
    }
    } finally { key = ''; await lock.close(); await unlink(lockPath); }
  }
  if (fatal) throw fatal;
}
