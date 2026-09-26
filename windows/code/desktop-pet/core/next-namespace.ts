// Aika Next owns a separate user-data namespace; the legacy AAAAGENT tree must never be written or read.
import { resolve } from 'node:path';
export const LEGACY_DATA_ROOT = 'AAAAGENT';
export const NEXT_DATA_ROOT = 'AikaNext';
export type DesktopDataMode = 'desktop' | 'preview' | 'smoke-test';

export function legacyUserDataRoot(appData: string): string {
  return resolveSubdir(appData, LEGACY_DATA_ROOT);
}
export function legacyUserDataDir(appData: string, mode: DesktopDataMode): string {
  return resolveSubdir(legacyUserDataRoot(appData), mode);
}
export function nextUserDataRoot(appData: string): string {
  return resolveSubdir(appData, NEXT_DATA_ROOT);
}
export function nextUserDataDir(appData: string, mode: DesktopDataMode): string {
  return resolveSubdir(nextUserDataRoot(appData), mode);
}

function resolveSubdir(base: string, segment: string): string {
  if (!base.trim() || !segment.trim()) throw new Error('Data namespace segments must be non-empty');
  return resolve(base, segment);
}
