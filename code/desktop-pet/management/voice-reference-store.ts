import { constants, type Stats } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, parse, join, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { abortable } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';

export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export type ReferenceFormat = 'wav' | 'mp3' | 'm4a';
export interface VoiceReference { id: string; format: ReferenceFormat; bytes: number; sha256: string; durationMs: number; createdAt: string }
export type ReferenceProbe = (file: string, format: ReferenceFormat, signal: AbortSignal) => Promise<number>;
export class VoiceReferenceError extends Error {
  constructor(readonly code: 'invalid_audio' | 'invalid_reference' | 'unsafe_storage' | 'probe_unavailable' | 'cancelled') { super(code); }
}
export const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
export function requireLive(signal: AbortSignal): void { if (signal.aborted) throw new VoiceReferenceError('cancelled'); }
export function referenceId(id: string): void { if (!/^[a-f0-9]{32}$/.test(id)) throw new VoiceReferenceError('invalid_reference'); }
function privateMode(stat: Stats, mode: number): void {
  // Windows ACL enforcement is supplied by the platform host, not POSIX mode bits.
  if (process.platform !== 'win32' && ((stat.mode & 0o7777) !== mode || typeof process.getuid !== 'function' || stat.uid !== process.getuid())) {
    throw new VoiceReferenceError('unsafe_storage');
  }
}
function sameFile(a: Stats, b: Stats): void {
  if (a.dev !== b.dev || a.ino !== b.ino) throw new VoiceReferenceError('unsafe_storage');
}
/** Reject symlinks in every ancestor. This is local single-writer storage, not a sandbox. */
export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VoiceReferenceError('unsafe_storage');
    if (current === absolute) privateMode(stat,0o700);
  }
  return absolute;
}
export async function privateRead(file: string, limit: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new VoiceReferenceError('unsafe_storage');
  privateMode(stat,0o600);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > limit) throw new VoiceReferenceError('unsafe_storage');
    privateMode(actual,0o600); sameFile(stat,actual);
    const bytes = await handle.readFile();
    try {
      const after = await handle.stat(), pathAfter = await lstat(file);
      privateMode(after,0o600); privateMode(pathAfter,0o600); sameFile(actual,after); sameFile(after,pathAfter);
      if (pathAfter.isSymbolicLink() || bytes.length > limit || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) throw new VoiceReferenceError('unsafe_storage');
      return bytes;
    } catch(error) { bytes.fill(0); throw error; }
  } finally { await handle.close(); }
}
export async function privateJson(file: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(file)); const temporary = file + '.' + randomUUID() + '.next';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
/** No shell, no network protocols, bounded output/time. Compressed references require an installed ffprobe. */
export const probeReference: ReferenceProbe = (file, format, signal) => new Promise((resolveProbe, reject) => {
  execFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,duration', '-of', 'json', file],
    { timeout: 15000, maxBuffer: 65536, signal }, (error, stdout) => {
      if (error) { reject(new VoiceReferenceError(signal.aborted ? 'cancelled' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'probe_unavailable' : 'invalid_audio')); return; }
      try {
        const value = JSON.parse(stdout), streams = value.streams;
        if (!Array.isArray(streams) || streams.length !== 1 || streams[0].codec_type !== 'audio'
          || (format === 'mp3' && (value.format?.format_name !== 'mp3' || streams[0].codec_name !== 'mp3'))
          || (format === 'm4a' && (!String(value.format?.format_name).split(',').includes('m4a') || !['aac','alac'].includes(streams[0].codec_name)))) throw Error();
        const duration = Number(value.format?.duration) * 1000;
        if (!Number.isFinite(duration) || duration <= 0) throw Error();
        resolveProbe(duration);
      } catch { reject(new VoiceReferenceError('invalid_audio')); }
    });
});
function metadata(value: unknown): VoiceReference {
  const v = value as VoiceReference;
  if (!v || typeof v !== 'object' || Object.keys(v).sort().join() !== ['id','format','bytes','sha256','durationMs','createdAt'].sort().join()) throw new VoiceReferenceError('invalid_reference');
  referenceId(v.id);
  if (!['wav','mp3','m4a'].includes(v.format) || !Number.isSafeInteger(v.bytes) || v.bytes <= 0 || v.bytes > MAX_REFERENCE_BYTES
    || !/^[a-f0-9]{64}$/.test(v.sha256) || !Number.isFinite(v.durationMs) || v.durationMs < 10000 || v.durationMs > 300000
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))) throw new VoiceReferenceError('invalid_reference');
  return Object.freeze({ ...v });
}
export class VoiceReferenceStore {
  private constructor(readonly directory: string, private readonly probe: ReferenceProbe) {}
  static async open(directory: string, probe: ReferenceProbe = probeReference): Promise<VoiceReferenceStore> {
    return new VoiceReferenceStore(await privateDirectory(directory), probe);
  }
  async save(input: { bytes: Uint8Array; filename: string }, signal: AbortSignal): Promise<VoiceReference> {
    requireLive(signal);
    const format = extname(input.filename).slice(1).toLowerCase() as ReferenceFormat;
    if (!['wav','mp3','m4a'].includes(format) || !input.bytes.length || input.bytes.length > MAX_REFERENCE_BYTES) throw new VoiceReferenceError('invalid_audio');
    const bytes = Buffer.from(input.bytes), id = randomUUID().replaceAll('-',''), file = join(this.directory, id + '.' + format);
    let retained = false;
    try {
      await privateDirectory(this.directory);
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      requireLive(signal);
      let durationMs: number;
      if (format === 'wav') {
        try {
          const wav = inspectPcmWav(bytes);
          if (bytes.readUInt32LE(4) + 8 !== bytes.length || ![1,2].includes(wav.channels)) throw Error();
          durationMs = wav.durationMs;
        } catch { throw new VoiceReferenceError('invalid_audio'); }
      } else {
        if (format === 'm4a' && bytes.toString('ascii',4,8) !== 'ftyp') throw new VoiceReferenceError('invalid_audio');
        if (format === 'mp3' && !(bytes.toString('ascii',0,3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224))) throw new VoiceReferenceError('invalid_audio');
        durationMs = await abortable(this.probe(file, format, signal),signal);
      }
      requireLive(signal);
      const result = metadata({ id, format, bytes: bytes.length, sha256: sha256(bytes), durationMs, createdAt: new Date().toISOString() });
      await privateJson(join(this.directory, id + '.json'), result); retained = true; return result;
    } finally { bytes.fill(0); if (!retained) await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async get(id: string): Promise<VoiceReference> {
    referenceId(id); await privateDirectory(this.directory);
    const result = metadata(JSON.parse((await privateRead(join(this.directory,id+'.json'),4096)).toString()));
    if (result.id !== id) throw new VoiceReferenceError('invalid_reference'); return result;
  }
  async read(id: string): Promise<{ metadata: VoiceReference; bytes: Uint8Array }> {
    const value = await this.get(id), bytes = await privateRead(join(this.directory,id+'.'+value.format),MAX_REFERENCE_BYTES);
    if (bytes.length !== value.bytes || sha256(bytes) !== value.sha256) { bytes.fill(0); throw new VoiceReferenceError('invalid_reference'); }
    return { metadata: value, bytes };
  }
  async list(): Promise<VoiceReference[]> {
    await privateDirectory(this.directory);
    const ids = (await readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
    return Promise.all(ids.map(name => this.get(name.slice(0,-5))));
  }
}
