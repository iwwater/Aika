/** Explicit, single-call evaluation entry. Building/importing it never invokes a provider. */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { EvaluationBudget } from '../core/evaluation-budget.js';
import { QwenTtsProvider } from '../providers/qwen-tts.js';
import type { CallAuthorizer, CallOutcome } from '../providers/transport.js';
import { MemoryMediaStore } from '../media/store.js';
import { inspectPcmWav } from '../media/wav.js';
import type { TurnScope } from '../contracts/index.js';

export async function evaluateTts(root: string, run: string, credentialFile: string, useAudio?: (bytes: Uint8Array) => Promise<void>): Promise<boolean> {
  if (!/^smoke-tts-[a-z0-9-]+$/.test(run)) throw new Error('Explicit evaluation operation ID required');
  const model = 'qwen3-tts-instruct-flash-2026-01-26';
  const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  const budget = new EvaluationBudget(`${root}/.local/model-evaluation/budget.json`, 'D09-S1-20260906-01', 10_000_000);
  const raw = await readFile(credentialFile, 'utf8');
  const section = raw.match(/^## Qwen \/ DashScope\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  const keys = section?.match(/sk-[A-Za-z0-9_-]+/g) ?? [];
  if (keys.length !== 1) throw new Error('Credential section ambiguous');
  const scope: TurnScope = { characterId: 'friend', sessionId: 'evaluation', turnId: run, generation: 1 };
  let outcome: CallOutcome | null = null, costMicros: number | null = null;
  const authorizer: CallAuthorizer = {
    async authorize(request, signal) {
      if (request.model !== model || request.operation !== 'tts' || request.endpoint !== endpoint) throw new Error('Unapproved evaluation operation');
      signal.throwIfAborted();
      await budget.reserve(`W0-I:${run}`, model, 1_000_000);
      return { async settle(result) {
        outcome = result;
        const usage = result.usage as { characters?: unknown } | null;
        const count = usage?.characters;
        costMicros = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? Math.ceil(count * 80) : null;
        await budget.settle(`W0-I:${run}`, costMicros);
      } };
    },
  };
  const store = new MemoryMediaStore();
  const provider = new QwenTtsProvider({ endpoint, model, voice: 'Cherry', language: 'Chinese', apiKey: () => keys[0]!, authorizer }, store);
  const report: Record<string, unknown> = {
    run, observedAt: new Date().toISOString(), model,
    codeRef: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    providerAdapterUnmodified: true, diagnosticOverride: false,
    physicalPlayback: false, retainedRawMedia: false, verifiedBilledCost: false,
  };
  let success = false, stage = 'synthesize';
  const started = performance.now();
  try {
    const result = await provider.synthesize({ scope, text: '你好，我在这里。今天辛苦了，我们慢慢聊。', expression: { emotion: 'calm', intensity: .4, delivery: '温柔、自然地用中文表达关心', gesture: null } }, AbortSignal.timeout(60_000));
    report.synthesisCompleted = true;
    stage = 'inspect_downloaded_media';
    const bytes = await store.read(scope, result.audio);
    try {
      const wav = inspectPcmWav(bytes);
      report.wav = { bytes: bytes.byteLength, sampleRate: wav.sampleRate, channels: wav.channels, bits: wav.bits, durationMs: wav.durationMs };
      if (useAudio) { await useAudio(bytes); report.retainedRawMedia = 'explicit_playback_test_consumer'; }
    } finally { bytes.fill(0); }
    success = true;
  } catch (error) {
    report.failedStage = stage;
    report.errorType = error instanceof Error ? error.name : 'unknown';
    // Never serialize error objects, provider bodies, signed URLs or credential-bearing inputs.
    report.errorClass = error instanceof Error && /^(?:Provider HTTP \d+|Audio download HTTP \d+|Invalid provider audio URL|Media unavailable for this turn)$/.test(error.message) ? error.message : 'evaluation_failure';
  } finally {
    await store.releaseScope(scope);
    Object.assign(report, { success, elapsedMs: Math.round(performance.now() - started), storeEntriesAfterCleanup: store.count, outcome, estimatedCostCNY: costMicros === null ? null : costMicros / 1_000_000 });
    await writeFile(`${root}/.local/model-evaluation/${run}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report));
  }
  return success;
}
