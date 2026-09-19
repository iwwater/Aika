import { assertCompanionDataConfiguration } from './companion-data.js';
import { isOutside } from '../core/platform-files.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration, TrialNotReadyError, type TrialConfiguration } from './trial-config.js';

export function trialFiles(projectRoot: string) {
  const directory = resolve(projectRoot, '.local/model-evaluation/trial/user-trial');
  return { configFile: resolve(directory, 'config.json'), activationFile: resolve(directory, 'activation.json') };
}

/** Pin the actual launch artifacts, including ignored compiled output, before starting a process. */
export async function verifyTrialRuntime(configuration: TrialConfiguration): Promise<void> {
  const root = await realpath(resolve(configuration.projectRoot, 'code/desktop-pet'));
  for (const [path, digest] of Object.entries(configuration.runtimeFiles)) {
    try {
      const actual = await realpath(resolve(configuration.projectRoot, path));
      const local = relative(root, actual);
      if (!local || isOutside(root, actual)) throw new Error('Outside runtime');
      if (createHash('sha256').update(await readFile(actual)).digest('hex') !== digest) throw new Error('Changed runtime');
    } catch { throw new TrialNotReadyError('试用程序文件缺失或已变化，请使用集成后的同一版本。'); }
  }
}

export async function prepareTrialLaunch(projectRoot: string, nodePath: string, environment: NodeJS.ProcessEnv = {}) {
  const files = trialFiles(projectRoot);
  const configuration = await readActiveTrialConfiguration(files.configFile, files.activationFile);
  if (configuration.purpose !== 'user-trial') throw new TrialNotReadyError('当前是集成检查配置，用户试用入口尚未启用。');
  assertCompanionDataConfiguration(configuration);
  if (resolve(configuration.projectRoot) !== resolve(projectRoot)) throw new TrialNotReadyError('试用配置与当前项目不一致。');
  await verifyTrialRuntime(configuration);
  const desktop = resolve(projectRoot, 'code/desktop-pet/desktop');
  const electron = configuration.desktopHost === 'electron';
  if (process.platform === 'win32' && !electron) throw new TrialNotReadyError('This configuration targets macOS. Configure the Windows host first.');
  return {
    version: configuration.sourceRevision,
    executable: electron ? createRequire(import.meta.url)('electron') as string : resolve(desktop, 'build/星月陪伴.app/Contents/MacOS/DesktopPet'),
    arguments: [...(electron ? [resolve(desktop, 'electron/main.mjs')] : []), '--root', desktop, '--backend', resolve(projectRoot, 'code/desktop-pet/dist/app/trial-backend.js'), '--node', nodePath],
    environment: { ...environment, ELECTRON_RUN_AS_NODE: undefined, PET_TRIAL_CONFIG: files.configFile, PET_TRIAL_ACTIVATION: files.activationFile },
  };
}

export async function launchTrial(projectRoot: string): Promise<void> {
  const plan = await prepareTrialLaunch(projectRoot, process.execPath, process.env);
  process.stdout.write(`正在启动AAAAGENT ${plan.version.slice(0, 7)}。退出请用应用菜单${process.platform === 'win32' ? '或 Alt-F4' : '或 Command-Q'}。\n`);
  const child = spawn(plan.executable, plan.arguments, { env: plan.environment, windowsHide: true, stdio: 'inherit' });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new TrialNotReadyError('试用程序未正常退出，请保留这个窗口的信息。')));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  launchTrial(root).catch(error => {
    process.stderr.write((error instanceof TrialNotReadyError ? error.message : '试用启动失败，请检查已登记的程序与配置。') + '\n');
    process.exitCode = 1;
  });
}
