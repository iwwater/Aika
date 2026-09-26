// FIX61-07 / FIX61-11: the machine-local microphone preference, split out of `microphone-test.ts`.
//
// Why a separate module: this store is the only part of the microphone feature that touches the filesystem,
// and FIX61-07 §2 puts the microphone TEST in the desktop renderer. If the store lived beside the lease,
// bundling the renderer would drag `node:fs/promises` into a browser bundle. Keeping it here lets the
// renderer import the lease (pure, injectable media) while only the backend and Electron main touch a file.
//
// The stored value is a device id — never a path, never a recording, never a label.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The only durable state: the chosen device id, in this machine's app data. Never a path or a recording. */
export class MicrophonePreferenceStore {
  private constructor(readonly file: string, private selected: string | null) {}
  static async open(file: string): Promise<MicrophonePreferenceStore> {
    let selected: string | null = null;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; deviceId?: unknown };
      if (raw.version !== 1) throw new Error('unsupported_microphone_preference');
      if (raw.deviceId !== null && typeof raw.deviceId !== 'string') throw new Error('invalid_microphone_preference');
      selected = (raw.deviceId as string | null) ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new MicrophonePreferenceStore(file, selected);
  }
  /** null means "the system default device" — an explicit, stored choice, not a missing value. */
  deviceId(): string | null { return this.selected; }
  async save(deviceId: string | null): Promise<void> {
    if (deviceId !== null && (!deviceId.trim() || deviceId.length > 512 || /[\u0000-\u001f]/.test(deviceId))) throw new Error('invalid_microphone_device');
    const temporary = `${this.file}.${process.pid}.next`;
    await mkdir(dirname(this.file), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, deviceId }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    this.selected = deviceId;
  }
}
