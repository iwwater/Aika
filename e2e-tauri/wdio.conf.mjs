import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tauriTargetDir = path.join(rootDir, 'src-tauri', 'target', 'debug');
const appBinaryName = process.platform === 'win32' ? 'petshell.exe' : 'petshell';
const appBinaryPath = path.join(tauriTargetDir, appBinaryName);
const tauriDriverBinary =
  process.env.TAURI_DRIVER ??
  path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver');
const tauriDriverArgs = process.env.TAURI_NATIVE_DRIVER
  ? ['--native-driver', process.env.TAURI_NATIVE_DRIVER]
  : [];

let tauriDriver;
let tauriDriverExitExpected = false;

export const config = {
  runner: 'local',
  host: '127.0.0.1',
  port: 4444,
  specs: [path.join(rootDir, 'e2e-tauri', 'specs', '**', '*.mjs')],
  maxInstances: 1,
  logLevel: process.env.WDIO_LOG_LEVEL ?? 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application: appBinaryPath,
      },
      // WebView2 的 console 是判断「到底是加载失败还是没画出来」的唯一现场；
      // 排查真机问题时比反复加断点有用。
      'goog:loggingPrefs': { browser: 'ALL' },
    },
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    // Live2D 首次要拉 Core + 模型 + 贴图；真机比浏览器慢，超时必须大于用例内部的
    // 等待（90s），否则超时会把「确定失败」掩盖成「跑太久」。注意 Mocha 的
    // it(title, fn, ms) 不接受第三个参数（那是 Jasmine），只能在配置里设。
    timeout: 180_000,
  },

  onPrepare: () => {
    if (process.platform === 'darwin') {
      throw new Error('Tauri WebDriver desktop tests are supported on Windows and Linux only.');
    }

    if (process.env.OPENPET_SKIP_TAURI_BUILD === '1') {
      return;
    }

    const result = runPnpm(['tauri', 'build', '--debug', '--no-bundle']);

    if (result.status !== 0) {
      throw new Error(`Tauri debug build failed with exit code ${result.status ?? 'unknown'}.`);
    }
  },

  beforeSession: () => {
    tauriDriverExitExpected = false;
    tauriDriver = spawn(tauriDriverBinary, tauriDriverArgs, {
      cwd: rootDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    tauriDriver.on('error', (error) => {
      console.error('tauri-driver error:', error);
      process.exit(1);
    });

    tauriDriver.on('exit', (code) => {
      if (!tauriDriverExitExpected) {
        console.error('tauri-driver exited unexpectedly with code:', code);
        process.exit(1);
      }
    });
  },

  afterSession: () => {
    closeTauriDriver();
  },

  onComplete: () => {
    closeTauriDriver();
  },
};

function runPnpm(args) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: rootDir,
      stdio: 'inherit',
    });
  }

  return spawnSync('pnpm', args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function closeTauriDriver() {
  tauriDriverExitExpected = true;

  if (tauriDriver && !tauriDriver.killed) {
    tauriDriver.kill();
  }
}

function registerShutdownCleanup() {
  process.once('exit', () => {
    closeTauriDriver();
  });

  const exitAfterCleanup = (code) => {
    closeTauriDriver();
    process.exit(code);
  };

  process.once('SIGINT', () => exitAfterCleanup(130));
  process.once('SIGTERM', () => exitAfterCleanup(143));
  process.once('SIGHUP', () => exitAfterCleanup(129));

  if (process.platform === 'win32') {
    process.once('SIGBREAK', () => exitAfterCleanup(130));
  }
}

registerShutdownCleanup();
