#!/usr/bin/env node
/**
 * tools/run-next081-smoke.mjs
 *
 * N081-00/TEST_PROFILES: 显式 smoke 档启动器。
 *
 * 职责边界（严格）：
 *  - 只准备一个独立的临时数据根，并把该根与 profile 一起传给正式产品链。
 *  - 不签发任何来源授权（grant）；键盘/目录/剪贴板仍须由用户在 Settings 里显式启用。
 *  - 不指向真实 Pictures/Screenshots 或历史图库；目录由用户在选择器里指定。
 *  - 退出时只清理该临时根下的受管副本；用户原始截图永不触碰。
 *
 * 用法：
 *   node tools/run-next081-smoke.mjs [--root <dir>] [--keep]
 */

import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { keep: false, root: undefined };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--keep') options.keep = true;
    else if (value === '--root') { options.root = argv[++index]; }
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write([
    'N081-00 smoke launcher',
    '',
    '  node tools/run-next081-smoke.mjs [--root <dir>] [--keep]',
    '',
    '  --root <dir>  Use a specific isolated smoke data root.',
    '  --keep        Keep the smoke data root after exit (default: managed copies are cleaned).',
    '',
    'The smoke profile uses 1s activity buckets, 2s quiet, 15s AFK, 10min retention and 64 MiB',
    'managed capacity. It still requires explicit per-source authorization and never starts capture',
    'on its own.',
    '',
  ].join('\n'));
  process.exit(0);
}

// 独立数据根：绝不复用 normal 根，也不在仓库产品目录下。
// 正式产品链的数据根是 windows/.local/data（见 app/trial-config.ts / serve-management 的 windowsRoot 解析）。
const normalDataRoot = resolve(root, '..', '..', '.local', 'data');
const smokeRoot = options.root
  ? resolve(options.root)
  : resolve(tmpdir(), `aika-next081-smoke-${randomBytes(6).toString('hex')}`);

const normalLower = normalDataRoot.toLowerCase();
const smokeLower = smokeRoot.toLowerCase();
const separator = process.platform === 'win32' ? '\\' : '/';
if (smokeLower === normalLower || smokeLower.startsWith(normalLower + separator)
  || normalLower.startsWith(smokeLower + separator)) {
  process.stderr.write('Refusing to start: the smoke root must be independent from the normal data root.\n');
  process.exit(2);
}

mkdirSync(smokeRoot, { recursive: true });
const managedAssets = join(smokeRoot, 'collection-assets');
const staging = join(smokeRoot, 'collection-staging');
mkdirSync(managedAssets, { recursive: true });
mkdirSync(staging, { recursive: true });

const descriptorFile = join(smokeRoot, 'smoke-descriptor.json');
writeFileSync(descriptorFile, JSON.stringify({
  schemaVersion: 1,
  profile: 'smoke',
  dataRoot: smokeRoot,
  managedAssets,
  staging,
  // 记录启动时的策略数值，便于现场核对界面标记是否来自后端有效策略。
  policy: {
    keyboardBucketMs: 1_000,
    keyboardQuietMs: 2_000,
    afkMs: 15_000,
    sampleRetentionMs: 600_000,
    managedByteLimit: 67_108_864,
    queueItemLimit: 4,
    queueByteLimit: 25_165_824,
    crossSourceWindowMs: 2_000,
    grantMaxDurationMs: 1_800_000,
  },
  // 明确记录“未自动授权”，避免把启动误读成已开始采集。
  autoGrantedSources: [],
}, null, 2) + '\n');

const environment = {
  ...process.env,
  Aika_COLLECTION_PROFILE: 'smoke',
  Aika_COLLECTION_DATA_ROOT: smokeRoot,
  Aika_COLLECTION_ASSETS_ROOT: managedAssets,
  Aika_COLLECTION_STAGING_ROOT: staging,
};

process.stdout.write([
  'N081-00 smoke data root prepared.',
  `  profile          : smoke`,
  `  data root        : ${smokeRoot}`,
  `  managed assets   : ${managedAssets}`,
  `  staging          : ${staging}`,
  `  descriptor       : ${descriptorFile}`,
  '',
  'Authorized sources : none (you must enable each source in Settings)',
  'Policy             : 1s bucket / 2s quiet / 15s AFK / 10min retention / 64 MiB',
  '',
].join('\n'));

// 实际启动正式 Windows 产品链。未安装依赖或缺少配置时如实报告，不伪造已启动。
const { spawn } = await import('node:child_process');
const entry = resolve(root, 'dist', 'app', 'trial-launcher.js');
if (!existsSync(entry)) {
  process.stderr.write(`Production entry is missing (${entry}). Run "npm run build" first.\n`);
  process.exitCode = 3;
} else {
  const child = spawn(process.execPath, [entry], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  const cleanup = () => {
    if (!options.keep) {
      // 只清理本临时根的受管副本与 staging；用户原始文件不在其中。
      try { rmSync(managedAssets, { recursive: true, force: true }); } catch { /* managed copies only */ }
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* staging only */ }
      process.stdout.write(`Smoke managed copies cleaned under ${smokeRoot} (descriptor retained).\n`);
    }
  };
  await new Promise(done => child.once('exit', done));
  cleanup();
  process.exitCode = child.exitCode ?? 0;
}
