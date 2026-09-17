import {restrictPrivatePathSync} from '../core/platform-files.js';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface RegisteredVoice {
  readonly voiceId: string;
  readonly label: string;
  readonly provider: 'dashscope';
  readonly endpoint: string;
  readonly targetModel: string;
  readonly credentialRef: string;
  readonly referenceSha256: string;
  readonly createdAt: string;
}
export type VoiceBindingKey = Pick<RegisteredVoice, 'voiceId' | 'provider' | 'endpoint' | 'targetModel' | 'credentialRef'>;
export interface RegisteredVoicesSnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly voices: readonly RegisteredVoice[];
}
declare const registeredVoiceBrand: unique symbol;
export interface RegisteredVoiceBinding extends RegisteredVoice { readonly [registeredVoiceBrand]: true }
export class RegisteredVoiceError extends Error {
  constructor(readonly code: 'invalid_registry' | 'version_conflict' | 'duplicate_voice' | 'binding_mismatch' | 'unregistered_voice') {
    super(`Registered voice ${code}`); this.name = 'RegisteredVoiceError';
  }
}

const modelEndpoints: Readonly<Record<string, string>> = Object.freeze({
  'qwen-audio-3.0-tts-plus': 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  'qwen-audio-3.0-tts-flash': 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  'MiniMax/speech-2.8-hd': 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  'MiniMax/speech-2.8-turbo': 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
});
const fields = ['voiceId', 'label', 'provider', 'endpoint', 'targetModel', 'credentialRef', 'referenceSha256', 'createdAt'] as const;
const bindings = new WeakSet<object>();
const queues = new Map<string, Promise<unknown>>();
function invalid(): never { throw new RegisteredVoiceError('invalid_registry'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const names = Object.keys(value);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function record(value: unknown): RegisteredVoice {
  const v = exact(value, fields);
  if (typeof v.voiceId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(v.voiceId)
    || typeof v.label !== 'string' || !v.label.trim() || v.label.length > 120 || /[\u0000-\u001f\u007f]/.test(v.label)
    || v.provider !== 'dashscope' || typeof v.targetModel !== 'string'
    || !Object.hasOwn(modelEndpoints, v.targetModel) || modelEndpoints[v.targetModel] !== v.endpoint
    || typeof v.credentialRef !== 'string' || !/^dashscope-[a-f0-9]{12}$/.test(v.credentialRef)
    || typeof v.referenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.referenceSha256)
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))
    || new Date(v.createdAt).toISOString() !== v.createdAt) invalid();
  // Only known metadata fields are copied. Keys and signed media URLs have no field here.
  return Object.freeze(Object.fromEntries(fields.map(key => [key, v[key]])) as unknown as RegisteredVoice);
}
function snapshot(revision: number, voices: readonly RegisteredVoice[]): RegisteredVoicesSnapshot {
  return Object.freeze({ version: 1, revision, voices: Object.freeze([...voices]) });
}
function parse(value: unknown): RegisteredVoicesSnapshot {
  const v = exact(value, ['version', 'revision', 'voices']);
  if (v.version !== 1 || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.voices)) invalid();
  const voices = v.voices.map(record);
  // This version only appends immutable registrations; each successful append is one revision.
  if (v.revision !== voices.length || new Set(voices.map(voice => voice.voiceId)).size !== voices.length) invalid();
  return snapshot(v.revision as number, voices);
}
async function read(file: string): Promise<RegisteredVoicesSnapshot> {
  try { return parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return snapshot(0, []);
    if (error instanceof SyntaxError) invalid();
    throw error;
  }
}
function matches(voice: RegisteredVoice, key: VoiceBindingKey): boolean {
  return voice.voiceId === key.voiceId && voice.provider === key.provider && voice.endpoint === key.endpoint
    && voice.targetModel === key.targetModel && voice.credentialRef === key.credentialRef;
}
export function assertRegisteredVoiceBinding(binding: unknown, key: VoiceBindingKey): asserts binding is RegisteredVoiceBinding {
  if (!binding || typeof binding !== 'object' || !bindings.has(binding)) throw new RegisteredVoiceError('unregistered_voice');
  if (!matches(binding as RegisteredVoiceBinding, key)) throw new RegisteredVoiceError('binding_mismatch');
}

/** Local metadata, not provider enrollment proof. I registers only a successful exact API
 * result. One backend owns cross-process writes; the queue serializes local handles.
 * A missing file reads as empty without creating it. A read or save never invokes a model. */
export class RegisteredVoiceStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly file: string, private state: RegisteredVoicesSnapshot) {}
  static async open(file: string): Promise<RegisteredVoiceStore> {
    const path = resolve(file); return new RegisteredVoiceStore(path, await read(path));
  }
  snapshot(): RegisteredVoicesSnapshot { return this.state; }
  resolve(key: VoiceBindingKey): RegisteredVoiceBinding {
    const voice = this.state.voices.find(item => item.voiceId === key.voiceId);
    if (!voice) throw new RegisteredVoiceError('unregistered_voice');
    if (!matches(voice, key)) throw new RegisteredVoiceError('binding_mismatch');
    const binding = Object.freeze({ ...voice }) as RegisteredVoiceBinding;
    bindings.add(binding); return binding;
  }
  register(expectedRevision: number, value: RegisteredVoice): Promise<RegisteredVoicesSnapshot> {
    let voice: RegisteredVoice;
    try { voice = record(value); } catch (error) { return Promise.reject(error); }
    const run = (queues.get(this.file) ?? Promise.resolve()).then(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.state.revision) throw new RegisteredVoiceError('version_conflict');
      const current = await read(this.file);
      if (current.revision !== expectedRevision || JSON.stringify(current) !== JSON.stringify(this.state)) throw new RegisteredVoiceError('version_conflict');
      if (current.voices.some(item => item.voiceId === voice.voiceId)) throw new RegisteredVoiceError('duplicate_voice');
      const next = snapshot(expectedRevision + 1, [...current.voices, voice]);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.next`;
      try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); restrictPrivatePathSync(temporary); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      this.state = next; return this.snapshot();
    });
    const tail = run.catch(() => {}); this.tail = tail; queues.set(this.file, tail);
    void tail.then(() => { if (queues.get(this.file) === tail) queues.delete(this.file); });
    return run;
  }
  async drain(): Promise<void> { await this.tail; }
}
