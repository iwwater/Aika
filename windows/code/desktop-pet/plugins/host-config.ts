/**
 * K65-02 (02-B): the host-config side of package registration — four states recorded separately and
 * importPackage with explicit idempotency semantics.
 *
 * What this module does NOT do (owned elsewhere, unchanged here):
 *   * staging/copy/registry data structure: `package-import.ts` (K65-01) stays the single authority;
 *     this module CONSUMES its registry shape (InstalledPackageRecord / PackageRegistry) and never
 *     invents a second registry format;
 *   * discovery, enablement, loading: `host-runtime.ts`.
 *
 * The four states (CONTRACTS.md §3) are recorded separately, never collapsed into one boolean:
 *   installed    — the registry.json record exists (K65-01's InstalledPackageRecord);
 *   enabled      — host-config.json marks the package enabled (intent, not load);
 *   ready        — a per-request readiness gate (02A+); K65-02 has none, so the field exists and is
 *                  honestly absent-null in the config, not a silently true default;
 *   loaded       — runtime state in host-runtime.ts, NEVER written here.
 *
 * Idempotency is explicit: importPackageHost re-exports the K65-01 atomic import, then returns an
 * `idempotent` flag so a caller (CLI, 03, 09) can distinguish "newly installed" from "already there"
 * without diffing registry snapshots. A registry that cannot be read before the import is surfaced
 * instead of silently overwritten (the K65-01 corruption rule propagates through this wrapper).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginIssue } from '../contracts/plugin.js';
import {
  importPackage, packageRegistryPath, readPackageRegistry,
  PACKAGE_REGISTRY_SCHEMA_VERSION,
  type ImportPackageResult, type InstalledPackageRecord, type PackageRegistry,
} from './package-import.js';

/** Schema of `host-config.json` beside the K65-01 `packages/registry.json`. */
export const HOST_CONFIG_SCHEMA_VERSION = 1 as const;

/** The four states of CONTRACTS.md §3, recorded separately. `enabled=false` + a registry record is "已安装未启用". */
export interface HostPackageEnablement {
  readonly packageId: string;
  readonly version: string;
  /** User intent. Recording it never loads anything. */
  readonly enabled: boolean;
  /** Set by a request-time readiness gate; K65-02 records `null` (no gate has run) and 02A owns it. */
  readonly ready: boolean | null;
  readonly updatedAtEpochSeconds: number | null;
}

export interface HostConfig {
  readonly schemaVersion: typeof HOST_CONFIG_SCHEMA_VERSION;
  readonly packages: HostPackageEnablement[];
}

export const hostConfigPath = (hostRoot: string): string => resolve(hostRoot, 'host-config.json');

/** Reads host-config.json; a missing file is a pristine config, a corrupt one is an error, never rewritten. */
export function readHostConfig(hostRoot: string): { ok: true; config: HostConfig } | { ok: false; issue: PluginIssue } {
  const path = hostConfigPath(hostRoot);
  if (!existsSync(path)) return { ok: true, config: { schemaVersion: HOST_CONFIG_SCHEMA_VERSION, packages: [] } };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    return { ok: false, issue: { category: 'manifest_invalid', path: 'host-config.json', detail: `host-config.json is not valid JSON: ${(error as Error).message}` } };
  }
  const config = parsed as HostConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || config.schemaVersion !== HOST_CONFIG_SCHEMA_VERSION || !Array.isArray(config.packages)
    || config.packages.some(entry => !entry || typeof entry !== 'object' || typeof entry.packageId !== 'string')) {
    return { ok: false, issue: { category: 'manifest_invalid', path: 'host-config.json', detail: `host-config.json is not a v${HOST_CONFIG_SCHEMA_VERSION} enablement config` } };
  }
  return { ok: true, config };
}

/** Writes the config through a temp file + atomic rename, mirroring the registry swap. */
export function writeHostConfig(hostRoot: string, config: HostConfig): void {
  const path = hostConfigPath(hostRoot);
  const temp = resolve(hostRoot, `.host-config-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

export interface ImportPackageHostRequest {
  readonly sourceRoot: string;
  readonly hostRoot: string;
  readonly nowEpochSeconds?: number;
}

export interface ImportPackageHostResult {
  readonly ok: boolean;
  readonly issues: readonly PluginIssue[];
  readonly record: InstalledPackageRecord | null;
  /** True when the identity was already installed with identical content and nothing changed. */
  readonly idempotent: boolean;
  /** True when this call created the enablement record (a first install of this identity). */
  readonly enablementCreated: boolean;
}

/**
 * Imports with explicit idempotency: a NEW identity lands unenabled in host-config.json; a repeat of
 * the SAME content is a no-op that leaves the existing enablement untouched; different content under
 * the same identity is refused by the K65-01 immutable-version rule before any write.
 */
export function importPackageHost(request: ImportPackageHostRequest): ImportPackageHostResult {
  const configRead = readHostConfig(request.hostRoot);
  if (!configRead.ok) return { ok: false, issues: [configRead.issue], record: null, idempotent: false, enablementCreated: false };
  const config = configRead.config;
  const registryRead = readPackageRegistry(request.hostRoot);
  if (!registryRead.ok) return { ok: false, issues: [registryRead.issue], record: null, idempotent: false, enablementCreated: false };
  const result: ImportPackageResult = importPackage(request);
  if (!result.ok || !result.record) {
    return { ok: false, issues: result.issues, record: null, idempotent: false, enablementCreated: false };
  }
  const existing = config.packages.find(entry => entry.packageId === result.record!.packageId);
  if (existing) {
    return { ok: true, issues: [], record: result.record, idempotent: true, enablementCreated: false };
  }
  const nextConfig: HostConfig = {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION,
    packages: [...config.packages, {
      packageId: result.record.packageId, version: result.record.version,
      enabled: false, ready: null, updatedAtEpochSeconds: request.nowEpochSeconds ?? null,
    }],
  };
  writeHostConfig(request.hostRoot, nextConfig);
  return { ok: true, issues: [], record: result.record, idempotent: false, enablementCreated: true };
}

/**
 * Records or clears the enable intent for an installed package. Only the intent is written here —
 * discovery and loading read it, none of them is triggered by it (02-A). Refuses enablement of a
 * packageId that has no registry record, so "enabled" can never mean a package the host does not have.
 */
export function setPackageEnablement(request: {
  readonly hostRoot: string;
  readonly packageId: string;
  readonly enabled: boolean;
  readonly nowEpochSeconds?: number;
}): { ok: true; config: HostConfig } | { ok: false; issue: PluginIssue } {
  const registryRead = readPackageRegistry(request.hostRoot);
  if (!registryRead.ok) return { ok: false, issue: registryRead.issue };
  const configRead = readHostConfig(request.hostRoot);
  if (!configRead.ok) return { ok: false, issue: configRead.issue };
  const record = registryRead.registry.packages.find(entry => entry.packageId === request.packageId);
  if (!record) {
    return {
      ok: false,
      issue: { category: 'dependency_unsatisfied', path: 'packageId', detail: `cannot ${request.enabled ? 'enable' : 'disable'} ${request.packageId}: it is not installed (no registry record)` },
    };
  }
  const others = configRead.config.packages.filter(entry => entry.packageId !== request.packageId);
  const prior = configRead.config.packages.find(entry => entry.packageId === request.packageId);
  const next: HostConfig = {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION,
    packages: [...others, {
      packageId: request.packageId, version: record.version,
      enabled: request.enabled, ready: null, updatedAtEpochSeconds: request.nowEpochSeconds ?? null,
    }],
  };
  writeHostConfig(request.hostRoot, next);
  return { ok: true, config: next };
}

/**
 * Installs an enablement record for an identity already in the registry without one (a host tree
 * written by an older writer). Unlike enablement it does NOT decide intent; it records that the
 * package exists and has never been enabled through this config. Deliberately NOT called by
 * importPackageHost — 02 does not rewrite config behind the importer.
 */
export function ensureEnablementRecordForInstalledPackage(hostRoot: string, record: InstalledPackageRecord, nowEpochSeconds?: number): HostConfig {
  const configRead = readHostConfig(hostRoot);
  const config: HostConfig = configRead.ok ? configRead.config : { schemaVersion: HOST_CONFIG_SCHEMA_VERSION, packages: [] };
  if (config.packages.some(entry => entry.packageId === record.packageId)) return config;
  const next: HostConfig = {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION,
    packages: [...config.packages, {
      packageId: record.packageId, version: record.version,
      enabled: false, ready: null, updatedAtEpochSeconds: nowEpochSeconds ?? null,
    }],
  };
  writeHostConfig(hostRoot, next);
  return next;
}

/** Unchanged re-export so a consumer needs only this module's import list. */
export { PACKAGE_REGISTRY_SCHEMA_VERSION, packageRegistryPath };
export type { ImportPackageResult, InstalledPackageRecord, PackageRegistry };
