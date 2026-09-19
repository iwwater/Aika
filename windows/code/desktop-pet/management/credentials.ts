import { isOutside, isPrivateFileSync } from '../core/platform-files.js';
import { createHash } from 'node:crypto';
import { ManagedCredentialStore, managedCredentialId } from './credential-store.js';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CredentialInfo } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';

/** References identify existing restricted files. Listing never opens key contents. */
export function credentialRegistry(configuration: TrialConfiguration, managed = new ManagedCredentialStore(configuration.projectRoot)) {
  const entries = new Map<string, { file: string; provider: string }>();
  for (const model of Object.values(configuration.models)) {
    const id = model.provider + '-' + createHash('sha256').update(model.credentialFile).digest('hex').slice(0, 12);
    entries.set(id, { file: model.credentialFile, provider: model.provider });
  }
  const all = () => { const result = new Map(entries); for (const entry of managed.entries()) result.set(entry.id, {file:entry.file,provider:entry.provider}); return result; };
  return {
    managed,
    ref(file: string, provider: string): string { const found = [...all()].find(([, value]) => value.file === file && value.provider === provider); if (!found) throw new Error('Unknown credential'); return found[0]; },
    file(ref: string, provider: string): string {
      const entry = entries.get(ref) ?? all().get(ref);
      // Revision-zero first-run history retains its missing placeholder; it is never offered as a newly saved key.
      if(!entry&&(provider==='deepseek'||provider==='dashscope')){const placeholder=resolve(managed.directory,'unconfigured-'+provider+'.key');if(ref===managedCredentialId(placeholder,provider))return placeholder;}
      if (!entry || entry.provider !== provider) throw new Error('Unknown credential reference'); return entry.file;
    },
    list(): CredentialInfo[] {
      return [...all()].map(([id, entry]) => {
        let status: CredentialInfo['status'] = 'unavailable';
        try {
          const actual = realpathSync(entry.file), info = statSync(actual), local = relative(realpathSync(configuration.projectRoot), actual);
          if (isAbsolute(entry.file) && isOutside(realpathSync(configuration.projectRoot), actual) && isPrivateFileSync(actual,info)) status = 'configured';
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') status = 'missing'; }
        return { id, provider:entry.provider as 'dashscope'|'deepseek', managed:!entries.has(id), label: (entry.provider === 'dashscope' ? '百炼凭据' : 'DeepSeek凭据') + ' · ' + id.slice(-6), status, masked: '••••••••' };
      });
    },
  };
}
