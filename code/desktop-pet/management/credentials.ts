import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { CredentialInfo } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';

/** References identify existing restricted files. Listing never opens key contents. */
export function credentialRegistry(configuration: TrialConfiguration) {
  const entries = new Map<string, { file: string; provider: string }>();
  for (const model of Object.values(configuration.models)) {
    const id = model.provider + '-' + createHash('sha256').update(model.credentialFile).digest('hex').slice(0, 12);
    entries.set(id, { file: model.credentialFile, provider: model.provider });
  }
  return {
    ref(file: string, provider: string): string { const found = [...entries].find(([, value]) => value.file === file && value.provider === provider); if (!found) throw new Error('Unknown credential'); return found[0]; },
    file(ref: string, provider: string): string {
      const entry = entries.get(ref); if (!entry || entry.provider !== provider) throw new Error('Unknown credential reference'); return entry.file;
    },
    list(): CredentialInfo[] {
      return [...entries].map(([id, entry]) => {
        let status: CredentialInfo['status'] = 'unavailable';
        try {
          const actual = realpathSync(entry.file), info = statSync(actual), local = relative(realpathSync(configuration.projectRoot), actual);
          if (isAbsolute(entry.file) && (local === '..' || local.startsWith('../')) && info.isFile() && (info.mode & 0o077) === 0
            && (!process.getuid || info.uid === process.getuid())) status = 'configured';
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') status = 'missing'; }
        return { id, label: entry.provider === 'dashscope' ? '百炼凭据' : 'DeepSeek凭据', status, masked: '••••••••' };
      });
    },
  };
}
