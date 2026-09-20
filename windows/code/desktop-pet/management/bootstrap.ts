import type { EmotionManagement } from '../contracts/emotion-state.js';
import { createSelfSetup } from './self-setup.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MemoryImportManagement } from '../contracts/memory-import.js';
import {ProviderBalances,readBalanceKey} from './balances.js';
import {FinanceCredentials} from './balance-credentials.js';
import {effectiveTrialConfiguration} from './settings.js';
import type { WakeManagement } from '../contracts/wake.js';
import type { WeChatManagement } from '../contracts/wechat.js';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PresentationControls } from '../contracts/presentation-presets.js';
import { presentationAssetRoutes } from './presentation-assets.js';
import type { ManagementMemoryPort } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import { ManagementSettingsStore } from './settings-store.js';
import { availableAdapters } from './settings.js';
import { credentialRegistry } from './credentials.js';
import { ManagementRuntime } from './runtime.js';
import { startManagementServer } from './server.js';
import type {PendingMemoryManagement} from './pending-memory.js';
import {accountingSnapshot} from './accounting.js';
import { SqliteProjectIndex } from '../projects/sqlite-project-index.js';
import { restrictPrivatePathSync } from '../core/platform-files.js';
import { homedir } from 'node:os';
import { HarnessForwarding } from '../harness/forwarding.js';
import { ForwardReceipts } from '../harness/receipts.js';
import { HarnessConnection } from '../harness/connection.js';
import { CodexAppConnection, verifyCodexAppBuild } from '../harness/codex-app.js';
import { CodexWindowsConnection } from '../harness/codex-windows.js';
import { harnessLaunchUrl, relayPresetReady, workPresetReady, RELAY_PRESET_ID } from '../harness/preset.js';
import { harnessAccounting } from '../harness/accounting.js';
import { EvaluationBudget } from '../core/evaluation-budget.js';
import { AikaProfileStore } from './aika-profile.js';
import { AikaTimelineStore, AikaTimelineRecorder } from './aika-timeline.js';
import { aikaManagement, ModelDiscoveryService } from './aika-routes.js';
import { AikaDiscoveryDraftStore } from './model-discovery-draft.js';
import { readSetupKey } from './self-setup.js';
import { healthManagement, microphoneManagement } from './health-routes.js';
import { MicrophonePreferenceStore, MicrophoneTestLease } from '../media/microphone-test.js';
import { applyAikaProfile } from './aika-profile.js';
import type { NextTurnPort } from '../core/turn-port.js';

export async function startRuntimeManagement(base: TrialConfiguration, configFile: string, settings: ManagementSettingsStore,
  runtime: ManagementRuntime, memory: ManagementMemoryPort, presentation?: PresentationControls, pendingMemory?:PendingMemoryManagement, wechat?:WeChatManagement, wake?:WakeManagement, memoryImport?:MemoryImportManagement, emotion?:EmotionManagement,
  /** FIX61-01: the Aika console reads and writes the same live profile the composition root applies. */
  aika?: { store: AikaProfileStore; timeline: AikaTimelineStore; turn?: NextTurnPort },
  /** FIX61-06: knowledge library management for the same console; absent leaves the section unavailable. */
  knowledge?: import('../contracts/knowledge.js').KnowledgeManagement,
  /** FIX61-07: microphone preference is machine-local; the desktop renderer owns the device itself. */
  microphone?: import('../media/microphone-test.js').MicrophonePreferenceStore) {
  /** The registry already publishes which provider owns a reference; no key material is read here. */
  const credentialOwner = (ref: string, list: readonly { id: string; provider?: string }[]) => {
    const owner = list.find(entry => entry.id === ref)?.provider;
    if (!owner) throw new Error('Unknown credential reference');
    return owner;
  };
  const effective=effectiveTrialConfiguration(base,settings.effective);
  const selfSetup=createSelfSetup({base,settings,instanceId:runtime.instanceId,mode:'runtime',runtimeReady:()=>{
    try{const raw=readFileSync(configFile,'utf8'),activation=JSON.parse(readFileSync(resolve(dirname(configFile),'activation.json'),'utf8'));
      return activation.status==='active'&&activation.phaseId===base.phaseId&&activation.configSha256===createHash('sha256').update(raw).digest('hex')&&JSON.stringify(JSON.parse(raw))===JSON.stringify(base);
    }catch{return false;}
  }});

  const deepseek=Object.values(effective.models).find(m=>m.provider==='deepseek'&&new URL(m.endpoint).hostname==='api.deepseek.com');
  const balances=new ProviderBalances({credentials:new FinanceCredentials(base.projectRoot),deepseekKey:()=>readBalanceKey(deepseek?.credentialFile)});
  let projects: SqliteProjectIndex | undefined;
  try { projects = new SqliteProjectIndex(resolve(base.projectRoot, '.local/data/project-index.sqlite')); }
  catch { process.stderr.write('Project index unavailable; companion data unchanged.\n'); }
  const descriptorFile = resolve(dirname(configFile), 'management-session.json');
  const location = { dshHome: resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh')), projectRoot: base.projectRoot, nodeExecutable: process.execPath, managementDescriptor: descriptorFile };
  let tasks: HarnessForwarding | undefined;
  let receipts: ForwardReceipts | undefined;
  const harnessDirectory = process.env.PET_HARNESS_HOME || (process.platform === 'win32' ? resolve(process.env.APPDATA || homedir(), 'DeepSeek Harness') : resolve(homedir(), 'Library/Application Support/DeepSeek Harness'));
  const windowsCodex = process.platform === 'win32' ? new CodexWindowsConnection(resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'))) : undefined;
  const makeForwarding = (receipts: ForwardReceipts) => {
    const harness = new HarnessConnection(() => harnessLaunchUrl(resolve(harnessDirectory, 'web.log')));
    return new HarnessForwarding({ receipts, projects:projects!,
      codex: windowsCodex ?? new CodexAppConnection(resolve(homedir(), '.codex')), compatible: windowsCodex ? () => windowsCodex.compatible() : verifyCodexAppBuild,
      harness, nativeWork: harness, workPresetReady: () => workPresetReady(location),
      presetReady: () => relayPresetReady(location), presetId: RELAY_PRESET_ID,
      workspace: resolve(harnessDirectory, 'workspace'),
      recordMetrics: harnessAccounting(new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros)),
    });
  };
  if (projects) try {
    receipts = new ForwardReceipts(resolve(base.projectRoot, '.local/data/harness-relay.sqlite'));
    tasks = makeForwarding(receipts);
  } catch { process.stderr.write('Task relay unavailable; companion data unchanged.\n'); }
  let server: Awaited<ReturnType<typeof startManagementServer>>;
  // The Aika console is served by the same backend, so it must reach the real profile store rather than a
  // separate copy. A missing store leaves the console's Aika section unavailable instead of failing launch.
  // FIX61-02: model discovery runs here, never in the browser. The key is read from the same restricted
  // local credential store the slots use, only for the reference the user picked, and is never cached.
  const aikaDiscovery = aika ? await (async () => {
    const credentials = credentialRegistry(base);
    return new ModelDiscoveryService({ credentials: { key: ref => readSetupKey(credentials.file(ref, credentialOwner(ref, credentials.list())), base.projectRoot) },
      draft: await AikaDiscoveryDraftStore.open(resolve(base.projectRoot, '.local/data/aika-model-discovery.json')) });
  })() : undefined;
  const aikaPort = aika ? aikaManagement(aika.store, aika.timeline, aikaDiscovery) : undefined;
  const aikaRecorder = aika?.turn ? new AikaTimelineRecorder(aika.turn, aika.timeline) : undefined;
  const stopRecorder = aikaRecorder?.start();
  try { server = await startManagementServer({ ...(emotion?{emotion}:{}), selfSetup, ...(memoryImport?{memoryImport}:{}), balances, ...(wake?{wake}:{}), uiRoot: resolve(base.projectRoot, 'code/desktop-pet/management/ui'), settings, memory, ...(aikaPort?{aika:aikaPort}:{}), ...(knowledge?{knowledge}:{}), health: healthManagement(runtime.health),
      ...(microphone?{microphone: microphoneManagement(microphone)}:{}), ...(wechat?{wechat}:{}), ...(projects ? { projects } : {}), ...(tasks ? { tasks } : {}), ...(pendingMemory?{pendingMemory}:{}), ...(presentation ? { presentation, presentationAssets: await presentationAssetRoutes(base.projectRoot) } : {}),
    snapshot: async () => ({ apiVersion: 1, balances:balances.snapshot(), accounting:await accountingSnapshot(base), runtime: runtime.identity(), modules: runtime.modules(), events: runtime.recentEvents(),
      settings: settings.snapshot(), adapters: availableAdapters(base, settings.registeredVoices), credentials: credentialRegistry(base).list(), characters: memory.characters() }) });
  } catch (error) { stopRecorder?.(); await selfSetup.close(); await tasks?.close(); await projects?.close(); throw error; }
  const file = resolve(dirname(configFile), 'management-session.json');
  const descriptor = { version: 1, pid: process.pid, instanceId: runtime.instanceId, sourceRevision: base.sourceRevision, url: server.url };
  const temporary = file + '.' + runtime.instanceId + '.next';
  try {
    await writeFile(temporary, JSON.stringify(descriptor) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    // The console-open path rejects session files without private ACLs; mode 0o600 is a no-op on Windows.
    restrictPrivatePathSync(file);
  } catch (error) { try { balances.close(); await selfSetup.close(); await server.close(); await memoryImport?.close(); } finally { await tasks?.close(); await projects?.close(); } throw error; }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  tasks?.startUsageObservation();
  return { ...server, tasks, projects, receipts, createWorkChannel(directory: string) {
    if(!projects)throw Error('Project index unavailable');
    const channelReceipts=new ForwardReceipts(resolve(directory,'harness-relay.sqlite'));
    const forwarding=makeForwarding(channelReceipts);forwarding.startUsageObservation();
    return {receipts:channelReceipts,forwarding,projects};
  }, async close() {
    stopRecorder?.();
    try { balances.close(); await selfSetup.close(); await server.close(); await memoryImport?.close(); } finally { await tasks?.close(); await windowsCodex?.close(); await projects?.close(); }
    try { const current = JSON.parse(await readFile(file, 'utf8')); if (current.instanceId === runtime.instanceId) await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
