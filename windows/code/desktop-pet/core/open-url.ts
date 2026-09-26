import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

export async function openLocalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (!(url.protocol === 'codex:' && url.hostname === 'threads' && /^\/[a-f0-9-]{36}$/i.test(url.pathname))
    && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw Error('Expected a local application URL');
  if (process.platform === 'win32') {
    const source = "$ErrorActionPreference = 'Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; Start-Process -FilePath $env:AAAAGENT_OPEN_URL";
    await promisify(execFile)(win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, env: { ...process.env, AAAAGENT_OPEN_URL: url.href } });
  } else await promisify(execFile)(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url.href]);
}
