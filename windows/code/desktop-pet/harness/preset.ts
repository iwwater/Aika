import {isPrivateFileSync,restrictPrivatePathSync} from '../core/platform-files.js';
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export const RELAY_PRESET_ID = 'desktop-pet-relay-v1';
const presetName = (id: string) => { if (!/^desktop-pet-relay-v1(?:-trial-[a-f0-9]{8})?$/.test(id)) throw Error('Invalid relay preset identity'); return id; };
export interface RelayPresetLocation { dshHome: string; projectRoot: string; nodeExecutable: string; managementDescriptor: string }
export function relayPresetContents(location: RelayPresetLocation): string {
  for (const value of Object.values(location)) if (!isAbsolute(value) || value.includes('\0') || value.includes('\n')) throw Error('Invalid relay location');
  return `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    complete: true
    includeRuntimeContext: false
    prefix: >-
      You are only a message relay. Use send_confirmed once for the supplied operationId.
      The tool owns the user-confirmed target and original text. Return its receipt verbatim.
      Codex owns all ideas, planning, architecture and execution. Do not plan or write code.
      If a result is unknown, report unknown without retry. Status checks do not send work.
- id: confirmed-relay
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: desktop_pet
    transport: stdio
    command: ${JSON.stringify(location.nodeExecutable)}
    args: ${JSON.stringify([join(location.projectRoot, 'code/desktop-pet/tools/harness-relay-mcp.mjs'), location.managementDescriptor])}
    toolCallTimeoutMs: 20000
    failOnStartupError: true
`;
}
export async function relayPresetReady(location: RelayPresetLocation, id = RELAY_PRESET_ID): Promise<boolean> {
  try { const file = join(location.dshHome, '.agent-presets', presetName(id), 'agent.cordis.yml'), info = await lstat(file);
    return info.isFile() && isPrivateFileSync(file,info) && await readFile(file, 'utf8') === relayPresetContents(location);
  } catch { return false; }
}
/** Explicit one-time deployment step. Never replace global defaults or an unrelated/user-edited preset. */
export async function installRelayPreset(location: RelayPresetLocation, id = RELAY_PRESET_ID): Promise<void> {
  presetName(id);
  if (await relayPresetReady(location, id)) return;
  const directory = join(location.dshHome, '.agent-presets', id);
  await mkdir(join(location.dshHome, '.agent-presets'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  restrictPrivatePathSync(directory);
  await writeFile(join(directory, 'agent.cordis.yml'), relayPresetContents(location), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'preset.yml'), 'name: Desktop pet relay\ndescription: Forward confirmed requests to existing Codex tasks.\n', { flag: 'wx', mode: 0o600 });
}
/** Read only the existing launcher's first URL; credential text never leaves the backend. */
export async function harnessLaunchUrl(log: string): Promise<string> {
  const info = await lstat(log); if (!isPrivateFileSync(log,info)) throw Error('Harness launcher unavailable');
  const file = await import('node:fs/promises').then(fs => fs.open(log, 'r'));
  try { const bytes = Buffer.alloc(8192); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const match = bytes.subarray(0, bytesRead).toString('utf8').match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (!match?.[1]) throw Error('Harness launcher unavailable'); return match[1];
  } finally { await file.close(); }
}

export const WORK_PRESET_ID = 'desktop-pet-work-v1';
/** Existing native tools/skills/compaction. Sandbox, approval, persistence and model host are unchanged. */
export const WORK_PRESET_CONTENTS = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    suffix: Your working directory is {{cwd}}.\n    prefix: >-\n      Complete only the user-confirmed task using your native tools. Do not create or delegate to agents. Respect project instructions and native approval requests. You are powered by {{model}}.\n\n- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n\n# \u2500\u2500 shell \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n# `shell-env` stays in the HOST composition: `apps/cli/src/web.ts` injects it to\n# publish `DSH_WEB_URL`/`DSH_WEB_MODE`, and a host row that injects a service is\n# the criterion for host-plane ownership \u2014 injection resolves before any session\n# exists, so there is no agent to key by. Behind a preset realm those variables\n# never reached the model's shell at all. Both shell tools consume the host\n# registry from here; their executors (`bash-sandbox`/`pwsh-sandbox`) are\n# host-plane too.\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'\n\n- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'\n\n# \u2500\u2500 filesystem \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n# Both register into the host `tools` registry and provide nothing, so\n# they need no realm. The `fs` service and its policy stay in the host.\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false\n\n# \u2500\u2500 background jobs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n# Only the model-facing controls. The task REGISTRY stays on the host plane:\n# its producers sit outside any realm this file could put it in \u2014 `tool-bash`\n# above resolves it with `ctx.get`, and an entry-local realm here is invisible\n# to every sibling row, so `run_in_background` would answer \"background jobs\n# unavailable\" while these controls sat in the catalog. The registry is keyed by\n# owning agent anyway, so one host instance serves every session. What a preset\n# chooses is whether its agent can collect and stop background work at all.\n- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'\n\n# \u2500\u2500 skills \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n# The skill REGISTRY lives in the host composition and is layered per scope:\n# these rows register into THIS preset's layer of it, so they need no realm.\n# `skill-filesystem` contributes local-root discovery for agents on this preset, and\n# `tool-skill` gives them the catalog and loader; the merged catalog also\n# carries whatever the deployment registered globally (repository plugins).\n- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n\n- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'\n\n- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n    compaction: true\n    toolResultPruner: true\n  config:\n    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n\n    - id: command-compact\n      name: '@deepseek-ai/dsh-command-compact'\n\n    - id: tool-result-pruner\n      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'\n      config:\n        thresholdChars: 8192\n        headChars: 4096\n        tailChars: 1024\n\n- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'\n\n- id: tool-todo\n  name: '@deepseek-ai/dsh-tool-todo'\n  config:\n    allowParallelInProgress: true\n\n# The `web` service and its search provider stay in the host composition; only\n# the model-facing tool is per-session.\n- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    fetch: true\n    searchTimeoutMs: 60000\n\n- id: present\n  name: '@deepseek-ai/dsh-tool-present'\n";
export async function workPresetReady(location: Pick<RelayPresetLocation,'dshHome'>):Promise<boolean>{
  try{const file=join(location.dshHome,'.agent-presets',WORK_PRESET_ID,'agent.cordis.yml'),info=await lstat(file);
    return info.isFile()&&isPrivateFileSync(file,info)&&await readFile(file,'utf8')===WORK_PRESET_CONTENTS;
  }catch{return false;}
}
export async function installWorkPreset(location: Pick<RelayPresetLocation,'dshHome'>):Promise<void>{
  if(await workPresetReady(location))return;
  const directory=join(location.dshHome,'.agent-presets',WORK_PRESET_ID);
  await mkdir(join(location.dshHome,'.agent-presets'),{recursive:true,mode:0o700});
  await mkdir(directory,{mode:0o700});
  restrictPrivatePathSync(directory);
  await writeFile(join(directory,'agent.cordis.yml'),WORK_PRESET_CONTENTS,{flag:'wx',mode:0o600});
  await writeFile(join(directory,'preset.yml'),'name: Desktop pet work\ndescription: Execute a confirmed small task with native tools and approvals.\n',{flag:'wx',mode:0o600});
}
