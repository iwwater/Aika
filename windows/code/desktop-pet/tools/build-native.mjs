import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
if (process.platform === 'darwin') {
  const result = spawnSync('zsh', [fileURLToPath(new URL('../desktop/build-native.sh', import.meta.url))], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} else if (process.platform === 'win32') {
  await access(createRequire(import.meta.url)('electron'));
  console.log('Windows Electron host is ready. Use npm run dev for offline editing or npm start after configuration.');
} else throw Error('The desktop host is supported on Windows and macOS.');
