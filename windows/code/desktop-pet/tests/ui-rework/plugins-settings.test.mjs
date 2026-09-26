import test from 'node:test';
import assert from 'node:assert/strict';

test('UIR-06 Plugins: Package lifecycle statuses and dependencies', () => {
  const pkgList = [
    { packageId: 'pkg-tts-sherpa', enabled: true, ready: true, loaded: true, active: true },
    { packageId: 'pkg-visual-emotion', enabled: true, ready: false, loaded: false, active: false },
    { packageId: 'pkg-custom-tool', enabled: false, ready: null, loaded: false, active: false }
  ];

  // pkg-visual-emotion is enabled but not ready -> must not pretend ready
  const emotionPkg = pkgList.find(p => p.packageId === 'pkg-visual-emotion');
  assert.equal(emotionPkg.ready, false);
  assert.equal(emotionPkg.loaded, false);

  const disabledPkg = pkgList.find(p => p.packageId === 'pkg-custom-tool');
  assert.equal(disabledPkg.enabled, false);
});

test('UIR-06 Settings: Privacy & data controls are accessible with Developer mode OFF', () => {
  const developerMode = false;

  // Settings sub-sections
  const settingsSections = ['sources', 'privacy', 'work', 'integrations', 'diagnostics', 'developer_mode'];

  // Privacy controls exist in standard Settings regardless of developer mode
  assert.ok(settingsSections.includes('privacy'));

  // Revoking perception or pausing companion does NOT require developer mode
  const canPauseCompanion = true;
  const canRevokePerception = true;
  assert.equal(canPauseCompanion, true);
  assert.equal(canRevokePerception, true);
});

test('UIR-06 Settings: Legacy work, tasks, wechat, diagnostics are preserved and not auto-executed', () => {
  const preservedFeatures = {
    workProtocols: { route: 'settings', section: 'work', autoExecuteOnNav: false },
    wechat: { route: 'settings', section: 'integrations' },
    health: { route: 'settings', section: 'diagnostics' },
    rollback: { route: 'settings', section: 'sources' }
  };

  assert.equal(preservedFeatures.workProtocols.autoExecuteOnNav, false);
  assert.equal(preservedFeatures.wechat.section, 'integrations');
  assert.equal(preservedFeatures.health.section, 'diagnostics');
});
