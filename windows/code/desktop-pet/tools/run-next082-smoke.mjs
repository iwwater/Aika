#!/usr/bin/env node
/**
 * tools/run-next082-smoke.mjs
 *
 * N082-00/TESTING: 显式 smoke 档启动器（主动与被动陪伴模式）。
 *
 * 职责边界（严格）：
 *  - 只准备一个独立的临时数据根，并把该根与 profile 一起传给正式产品链。
 *  - 不签发任何来源授权（grant）；模式默认 passive 且 paused=true，来源仍须由用户在 Settings 显式启用。
 *  - 退出时只清理该临时根下的受管副本；用户原始文件永不触碰。
 *
 * 用法：
 *   node tools/run-next082-smoke.mjs [--root <dir>] [--keep]
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

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
    'N082-00 smoke launcher',
    '',
    '  node tools/run-next082-smoke.mjs [--root <dir>] [--keep]',
    '',
    '  --root <dir>  Use a specific isolated smoke data root.',
    '  --keep        Keep the smoke data root after exit (default: managed copies are cleaned).',
    '',
    'The 0.82 smoke profile uses 5s observation interval, 10min retention, 64 MiB managed capacity,',
    '4 items / 24 MiB queue limits, and strictly isolated data root.',
    '',
  ].join('\n'));
  process.exit(0);
}

const normalDataRoot = resolve(root, '..', '..', '.local', 'data');
const smokeRoot = options.root
  ? resolve(options.root)
  : resolve(tmpdir(), `aika-next082-smoke-${randomBytes(6).toString('hex')}`);

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
  version: '0.82',
  dataRoot: smokeRoot,
  managedAssets,
  staging,
  policy: {
    observationIntervalMs: 5_000,
    dailyLocalTime: '20:00',
    timezone: 'Asia/Shanghai',
    sampleRetentionMs: 600_000,
    managedByteLimit: 67_108_864,
    queueItemLimit: 4,
    queueByteLimit: 25_165_824,
    grantMaxDurationMs: 1_800_000,
  },
  autoGrantedSources: [],
}, null, 2) + '\n');

const environment = {
  ...process.env,
  Aika_COMPANION_PROFILE: 'smoke',
  Aika_COMPANION_DATA_ROOT: smokeRoot,
  Aika_COLLECTION_PROFILE: 'smoke',
  Aika_COLLECTION_DATA_ROOT: smokeRoot,
  Aika_COLLECTION_ASSETS_ROOT: managedAssets,
  Aika_COLLECTION_STAGING_ROOT: staging,
};

process.stdout.write([
  'N082-00 smoke data root prepared.',
  `  Data root:      ${smokeRoot}`,
  `  Managed assets: ${managedAssets}`,
  `  Staging root:   ${staging}`,
  '  Policy:         5s observation, 10m TTL, 64 MiB limit (isolated)',
  '',
].join('\n'));

const child = spawn(process.execPath, [resolve(root, 'tools/dev-desktop.mjs')], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', code => {
  process.exitCode = code ?? 0;
});
