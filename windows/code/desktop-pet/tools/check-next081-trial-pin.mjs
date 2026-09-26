#!/usr/bin/env node
/**
 * tools/check-next081-trial-pin.mjs
 *
 * N081-06: 判定当前检出能否启动真实试用产品链（G1～G5 前置）。
 *
 * 它只读配置与文件摘要，不启动任何进程、不修改 pin、不绕过 `verifyTrialRuntime`。
 * 退出码：0 = 可启动；3 = 环境不可行（pin 不匹配）；2 = 配置缺失/非法。
 *
 * 用法：node tools/check-next081-trial-pin.mjs [--config <config.json>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { config: '' };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--config') options.config = argv[++index];
    else if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write([
    'N081-06 trial pin check',
    '',
    '  node tools/check-next081-trial-pin.mjs [--config config.json]',
    '',
    'Reports whether this checkout can satisfy the trial pin, and which files diverge.',
    'It reads only; it never starts the product and never rewrites the pin.',
    '',
  ].join('\n'));
  process.exit(0);
}

// The trial configuration lives under windows/.local/, two levels above this package.
const configFile = options.config || resolve(root, '..', '..', '.local/model-evaluation/trial/user-trial/config.json');
if (!existsSync(configFile)) {
  console.error(`NOT_RUN: no trial configuration at ${configFile}.`);
  process.exit(2);
}

let configuration;
try { configuration = JSON.parse(readFileSync(configFile, 'utf8')); }
catch { console.error('NOT_RUN: the trial configuration is not valid JSON.'); process.exit(2); }

const projectRoot = configuration.projectRoot;
const runtimeFiles = configuration.runtimeFiles ?? {};
const pin = String(configuration.sourceRevision ?? '');

const diverged = [];
const missing = [];
let matched = 0;
for (const [relative, digest] of Object.entries(runtimeFiles)) {
  const full = resolve(projectRoot, relative);
  if (!existsSync(full)) { missing.push(relative); continue; }
  const actual = createHash('sha256').update(readFileSync(full)).digest('hex');
  if (actual === digest) matched++;
  else diverged.push(relative);
}

/** Categorize so a reader can tell release drift from a specific feature's changes. */
const categorize = list => ({
  compiledOutput: list.filter(name => name.includes('/dist/')).length,
  shippedDesktop: list.filter(name => name.includes('/desktop/') && !name.includes('/dist/')).length,
  tools: list.filter(name => name.includes('/tools/')).length,
  other: list.filter(name => !name.includes('/dist/') && !name.includes('/tools/')
    && !(name.includes('/desktop/') && !name.includes('/dist/'))).length,
});

/** Is the pinned revision even present in this repository? */
let pinInRepository = null;
try {
  const result = spawnSync('git', ['cat-file', '-t', pin], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  pinInRepository = result.status === 0;
} catch { pinInRepository = null; }

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  projectRoot: 'declared-by-config',
  pinnedSourceRevision: pin,
  pinnedRevisionPresentInRepository: pinInRepository,
  pinnedFiles: Object.keys(runtimeFiles).length,
  matched,
  diverged: diverged.length,
  missing: missing.length,
  divergenceByArea: categorize(diverged),
  launchable: diverged.length === 0 && missing.length === 0,
  sample: diverged.slice(0, 15),
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');

if (!report.launchable) {
  process.stderr.write([
    '',
    'NOT_RUN: this checkout cannot satisfy the trial pin, so G1-G5 on real hardware cannot run here.',
    pinInRepository === false
      ? `  The pinned revision ${pin} does not exist in this repository; the pin belongs to a build made elsewhere.`
      : '  Pinned files diverge from the configuration.',
    '  Do NOT bypass verifyTrialRuntime: it guards against version drift, and evidence obtained',
    '  by bypassing it would not describe the real product.',
    '  Provide an integrated build matching the pin, or re-issue a pin for the current revision.',
    '',
  ].join('\n'));
  process.exit(3);
}

process.stderr.write('\nOK: this checkout satisfies the trial pin.\n');
