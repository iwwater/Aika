import { resolve } from 'node:path';
import type { TrialConfiguration } from './trial-config.js';

export const COMPANION_DATA_PROFILE = 'companion-v1' as const;
/** Business data lives beside the code project and is not a build or task artifact. */
export function companionDatabaseFile(projectRoot: string): string {
  return resolve(projectRoot, '.local/data/companion.sqlite');
}
export function legacyTrialDatabaseFile(projectRoot: string): string {
  return resolve(projectRoot, '.local/model-evaluation/trial/user-trial/state.sqlite');
}
/** Metadata gate before settings, store creation or credentials. Never infers or migrates old data. */
export function assertCompanionDataConfiguration(configuration: TrialConfiguration): void {
  if (configuration.product !== COMPANION_DATA_PROFILE || configuration.database !== companionDatabaseFile(configuration.projectRoot))
    throw new Error('新角色的数据位置尚未完成更新，请使用已核验的单角色配置。');
}
