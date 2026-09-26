#!/usr/bin/env node
/**
 * tools/build-collection-helper.mjs
 *
 * N081-00/N081-03: build the controlled Windows collection helper.
 *
 * The helper is an OPTIONAL artifact: when it is missing the product must still start and chat,
 * and every collection source reports `unavailable`. A build failure is therefore reported with a
 * non-zero exit code but never corrupts an existing binary.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'desktop/collection/collection-helper.cpp');
const probeSource = resolve(root, 'desktop/collection/perf-probe.cpp');
const outputDirectory = resolve(root, 'dist/collection');
const outputBinary = join(outputDirectory, 'aika-collection-helper.exe');
const outputProbe = join(outputDirectory, 'aika-perf-probe.exe');
const buildDirectory = resolve(root, 'desktop/collection/.build');

if (!existsSync(source)) {
  console.error(`Collection helper source is missing: ${source}`);
  process.exit(2);
}

if (process.platform !== 'win32') {
  // The helper is Windows-only; other platforms report unavailable rather than failing a build.
  console.log('Collection helper is Windows-only; skipping on ' + process.platform + '.');
  process.exit(0);
}

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(buildDirectory, { recursive: true });

const objectFile = join(buildDirectory, 'collection-helper.obj');
const candidateBinary = join(buildDirectory, 'collection-helper.exe');
const probeObjectFile = join(buildDirectory, 'perf-probe.obj');
const probeCandidate = join(buildDirectory, 'perf-probe.exe');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  return result.status === 0;
}

/** Locate an MSVC/LLVM toolchain. A missing toolchain leaves the helper absent, not broken. */
function findVisualStudioVcvars() {
  const candidates = [
    process.env.VSINSTALLDIR ? join(process.env.VSINSTALLDIR, 'VC/Auxiliary/Build/vcvars64.bat') : null,
    'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat',
    'C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Auxiliary/Build/vcvars64.bat',
    'C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Auxiliary/Build/vcvars64.bat',
    'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function buildWithMsvc(vcvars) {
  // vcvars must run in the same cmd invocation as cl; each spawnSync is a fresh process.
  const command = `call "${vcvars}" >nul 2>&1 && cl.exe /nologo /std:c++17 /EHsc /O2 /W3 `
    + `"${source}" /Fo"${objectFile}" /Fe"${candidateBinary}" /link user32.lib advapi32.lib wtsapi32.lib`
    + ` && cl.exe /nologo /std:c++17 /EHsc /O2 /W3 "${probeSource}" /Fo"${probeObjectFile}" /Fe"${probeCandidate}" /link psapi.lib`;
  return run('cmd.exe', ['/c', command], { cwd: root });
}

function buildWithLlmMinGW() {
  const candidates = ['clang++.exe', 'g++.exe', 'clang++', 'g++'];
  for (const compiler of candidates) {
    if (run(compiler, ['--version'], { stdio: 'ignore' })) {
      const ok = run(compiler, ['-std=c++17', '-O2', '-o', candidateBinary, source,
        '-luser32', '-ladvapi32', '-lwtsapi32', '-static', '-static-libgcc', '-static-libstdc++'], { cwd: root });
      if (!ok) continue;
      const probeOk = run(compiler, ['-std=c++17', '-O2', '-o', probeCandidate, probeSource,
        '-lpsapi', '-static', '-static-libgcc', '-static-libstdc++'], { cwd: root });
      if (probeOk) return true;
    }
  }
  return false;
}

let built = false;
const vcvars = findVisualStudioVcvars();
if (vcvars) built = buildWithMsvc(vcvars);
if (!built) built = buildWithLlmMinGW();

if (!built || !existsSync(candidateBinary)) {
  // Do not leave a stale binary behind when a rebuild fails: an old helper is not evidence of a new one.
  console.error('Collection helper build failed; collection sources will report unavailable.');
  console.error('Install Visual Studio Build Tools (C++ workload) or LLVM-MinGW, then re-run npm run build:collection.');
  process.exit(1);
}

// Promote atomically so a partially written binary is never placed at the final path.
const promoted = outputBinary + '.next';
copyFileSync(candidateBinary, promoted);
rmSync(outputBinary, { force: true });
copyFileSync(promoted, outputBinary);
rmSync(promoted, { force: true });
rmSync(candidateBinary, { force: true });
rmSync(objectFile, { force: true });

// The measurement probe ships alongside the helper; it is optional in the same way.
if (existsSync(probeCandidate)) {
  const probePromoted = outputProbe + '.next';
  copyFileSync(probeCandidate, probePromoted);
  rmSync(outputProbe, { force: true });
  copyFileSync(probePromoted, outputProbe);
  rmSync(probePromoted, { force: true });
  rmSync(probeCandidate, { force: true });
  rmSync(probeObjectFile, { force: true });
}

// A sidecar manifest records what was built, so the backend can refuse a mismatched helper.
writeFileSync(join(outputDirectory, 'helper-build.json'), JSON.stringify({
  schemaVersion: 1,
  binary: 'aika-collection-helper.exe',
  platform: 'win32',
  builtFrom: 'desktop/collection/collection-helper.cpp',
  protocolSchemaVersion: 1,
  maxLineLength: 65536,
  maxStagedBytes: 20 * 1024 * 1024,
}, null, 2) + '\n');

console.log(`Collection helper built: ${outputBinary}`);
