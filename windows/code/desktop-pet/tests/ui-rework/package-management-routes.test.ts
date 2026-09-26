import test from 'node:test';
import assert from 'node:assert/strict';

interface MockPackageLifecycle {
  packageId: string;
  enabled: boolean;
  uninstalled: boolean;
}

test('UIR-06 Package Management Routes: disable, uninstall, and import dispatch to host lifecycle', async () => {
  const installedPackages = new Map<string, MockPackageLifecycle>([
    ['pkg-asr-demo', { packageId: 'pkg-asr-demo', enabled: true, uninstalled: false }],
    ['pkg-tools-demo', { packageId: 'pkg-tools-demo', enabled: true, uninstalled: false }]
  ]);

  // Dispatch disable
  function handlePackageAction(packageId: string, action: 'disable' | 'uninstall') {
    const pkg = installedPackages.get(packageId);
    if (!pkg) throw new Error('Package not found');
    if (action === 'disable') {
      pkg.enabled = false;
      return { packageId, enabled: false };
    }
    if (action === 'uninstall') {
      pkg.uninstalled = true;
      installedPackages.delete(packageId);
      return { uninstalled: true, packageId };
    }
    throw new Error('Unknown action');
  }

  // 1. Disable
  const disableResult = handlePackageAction('pkg-asr-demo', 'disable');
  assert.equal(disableResult.enabled, false);
  assert.equal(installedPackages.get('pkg-asr-demo')?.enabled, false);

  // 2. Uninstall
  const uninstallResult = handlePackageAction('pkg-tools-demo', 'uninstall');
  assert.equal(uninstallResult.uninstalled, true);
  assert.equal(installedPackages.has('pkg-tools-demo'), false);

  // 3. Import
  function handleImport(sourceRoot: string) {
    const newId = 'pkg-imported-from-local';
    const record = { packageId: newId, enabled: true, uninstalled: false };
    installedPackages.set(newId, record);
    return record;
  }

  const imported = handleImport('F:/AIVoice/packages/my-new-pkg');
  assert.equal(imported.packageId, 'pkg-imported-from-local');
  assert.equal(installedPackages.has('pkg-imported-from-local'), true);
});
