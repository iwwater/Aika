import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WakeDetector, WakeDetectorOptions, WakeDetectorResult } from '../../contracts/wake.js';
import { keywordTokens } from './keywords.js';
import { verifyWakeModels } from './models.js';

export async function openWakeDetector(options: WakeDetectorOptions): Promise<WakeDetector> {
  await verifyWakeModels(options.modelDirectory);
  const keywordLine = keywordTokens(options.settings.keyword, await readFile(join(options.modelDirectory, 'tokens.txt'), 'utf8'));
  if (!['standard', 'sensitive', 'strict'].includes(options.settings.sensitivity)) throw Error('Invalid wake sensitivity');
  const worker = new Worker(new URL('./detector-worker.js', import.meta.url), { workerData: { ...options, keywordLine }, stdout: true, stderr: true, execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
  worker.stdout.resume(); worker.stderr.resume();
  let closed = false, sequence = 0, inFlight = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const stop = (error = new Error('Wake detector closed')) => {
    closed = true; rejectReady(error);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear();
    return worker.terminate().then(() => {});
  };
  worker.on('error', () => { void stop(new Error('Local wake model failed')); });
  worker.on('exit', () => { if (!closed) void stop(new Error('Local wake model exited')); });
  worker.on('message', message => {
    if (message.ready) { resolveReady(); return; }
    if (message.failed && message.id === undefined) { void stop(new Error('Local wake initialization failed')); return; }
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.failed) call.reject(new Error('Local wake processing failed')); else call.resolve(message.result);
  });
  const timer = setTimeout(() => { void stop(new Error('Local wake initialization timed out')); }, 30000);
  try { await ready; } finally { clearTimeout(timer); }
  const call = (type: string, data: object = {}): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('Wake detector closed'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void stop(new Error('Local wake processing timed out')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type, id, ...data });
    });
  };
  return {
    async accept(samples): Promise<WakeDetectorResult> {
      if (inFlight || !(samples instanceof Float32Array) || !samples.length || samples.length > 3200 || samples.some(v => !Number.isFinite(v) || Math.abs(v) > 1)) throw Error('Invalid or overlapping wake PCM');
      inFlight = true;
      try { return await call('pcm', { samples }) as WakeDetectorResult; } finally { inFlight = false; }
    },
    async setCapturing(active) { await call('capture', { active }); },
    async reset() { await call('reset'); },
    async close() { if (!closed) await stop(); },
  };
}
