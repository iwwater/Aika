import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Next65Management } from '../../management/next65-management.js';
import { ProviderRuntime } from '../../plugins/provider-runtime.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import type { PackageHost } from '../../plugins/host-runtime.js';

const source = resolve(process.cwd(), 'dist/next65/packages/tts');

function createTempHostRoot(): { hostRoot: string; cleanup: () => void } {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'next65-mgmt-test-'));
  importPackageHost({ sourceRoot: source, hostRoot });
  setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: true });

  return {
    hostRoot,
    cleanup: () => {
      try { rmSync(hostRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

test('N075-01 R8: Next65Management reflects live PackageHost loaded state and ProviderRuntime truth', async t => {
  const { hostRoot, cleanup } = createTempHostRoot();
  t.after(cleanup);

  const loadedPackages = new Set<string>();

  // Mock live PackageHost
  const mockHost: Partial<PackageHost> = {
    hostRoot,
    isLoaded: (pkgId: string) => loadedPackages.has(pkgId),
    activePackages: () => [...loadedPackages],
  };

  const providerRuntime = new ProviderRuntime();

  const mgmt = new Next65Management({
    hostRoot,
    host: mockHost as PackageHost,
    providerRuntime,
  });

  // 1. Initial state: package installed and enabled, but NOT yet loaded in live host
  let pkgs = mgmt.packages();
  assert.equal(pkgs.length, 1);
  assert.equal(pkgs[0]!.packageId, 'com.aika.product.tts');
  assert.equal(pkgs[0]!.enabled, true);
  assert.equal(pkgs[0]!.loaded, false, 'Package is not loaded in host initially');
  assert.equal(pkgs[0]!.active, false);

  // 2. Simulate package loading in live PackageHost
  loadedPackages.add('com.aika.product.tts');

  // Verify Next65Management now reports loaded: true (NO LONGER HARDCODED false!)
  pkgs = mgmt.packages();
  assert.equal(pkgs[0]!.loaded, true, 'Next65Management dynamically reflects live PackageHost loaded state');
  assert.equal(pkgs[0]!.active, true);

  // 3. Verify runtimeTruth()
  const truth = mgmt.runtimeTruth();
  assert.equal(truth.installedCount, 1);
  assert.deepEqual(truth.loadedPackages, ['com.aika.product.tts']);
  assert.deepEqual(truth.activePackages, ['com.aika.product.tts']);
  assert.ok(truth.registeredCapabilities.length > 0);

  // 4. Verify live references
  assert.equal(mgmt.liveHost(), mockHost);
  assert.equal(mgmt.liveProviderRuntime(), providerRuntime);
});
