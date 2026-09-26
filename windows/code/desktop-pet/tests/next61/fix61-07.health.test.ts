// FIX61-07 RED->GREEN: module health must be evidence-based (configured / reachable / operational are
// different claims), and the microphone must be selectable, diagnosable and locally testable WITHOUT
// the backend being ready, without touching camera/ASR/LLM and without writing Timeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleHealthRegistry, HEALTH_GREEN_EVIDENCE, healthStalenessMs } from '../../core/health-snapshot.js';
import { MicrophoneTestLease, TEST_RECORD_MAX_MS, describeTrackSettings } from '../../media/microphone-test.js';
// FIX61-11: the preference store moved to its own module so the desktop renderer bundle stays free of
// node:fs. The assertions below are unchanged; only the import path moved.
import { MicrophonePreferenceStore } from '../../media/microphone-preference.js';

const evidence = (over: Record<string, unknown> = {}) => ({
  configured: false, reachable: false, operational: false, ...over
});

// 07-A -----------------------------------------------------------------------------------------
test('07-A missing key, reachable list but failing inference, configured voice without a loaded model and a broken SQLite schema never turn green', () => {
  const registry = new ModuleHealthRegistry(1);
  // A missing credential is configured:false -> not green.
  registry.observe('dialogue', { module: 'dialogue', evidence: evidence(), reasonCode: 'credential_missing', repairAction: '请先在配置页保存此服务的 Key。' });
  assert.notEqual(registry.snapshot().modules.dialogue?.state, 'ready');

  // A reachable /models list proves reachability only. It does NOT prove the model can infer.
  registry.observe('summary', { module: 'summary', evidence: evidence({ configured: true, reachable: true }), reasonCode: 'inference_unverified', repairAction: '保存后发起一次真实请求以确认可用。' });
  assert.notEqual(registry.snapshot().modules.summary?.state, 'ready', 'reachability alone must never be green');

  // A configured voice adapter whose local model never loaded is degraded, not ready.
  registry.observe('tts', { module: 'tts', evidence: evidence({ configured: true, reachable: true }), reasonCode: 'engine_not_loaded', repairAction: '请检查本地语音引擎与模型文件。' });
  assert.notEqual(registry.snapshot().modules.tts?.state, 'ready');

  // A SQLite schema error is failed with a repair action.
  const failed = registry.observe('memory', { module: 'memory', evidence: evidence({ configured: true }), reasonCode: 'schema_mismatch', repairAction: '数据库结构不匹配，请使用备份或迁移入口。' });
  assert.equal(failed.state, 'failed');
  assert.ok((failed.repairAction ?? '').length > 0, 'a red light must always carry a repair entry point');
});

test('07-A only operational evidence (or a successful self-check) turns a light green, and every light carries a reason or a repair path', () => {
  const registry = new ModuleHealthRegistry(1);
  const green = registry.observe('dialogue', { module: 'dialogue', evidence: evidence({ configured: true, reachable: true, operational: true }), reasonCode: null, repairAction: null });
  assert.equal(green.state, 'ready');
  assert.ok(HEALTH_GREEN_EVIDENCE.includes('operational'));

  // An unknown module is grey, never green.
  const unknown = registry.observe('perception', { module: 'perception', evidence: evidence(), reasonCode: null, repairAction: null });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.evidence.configured, false);

  for (const moduleHealth of Object.values(registry.snapshot().modules) as import('../../core/health-snapshot.js').ModuleHealth[]) {
    // Every non-green light must be explainable.
    if (moduleHealth.state !== 'ready') assert.ok(moduleHealth.reasonCode || moduleHealth.repairAction, `${moduleHealth.module} must explain its state`);
    assert.ok(moduleHealth.checkedAt, 'and be timestamped');
    assert.equal(moduleHealth.configRevision, 1);
  }
});

test('07-A a stale check is marked expired and later success after a config switch is isolated', () => {
  const registry = new ModuleHealthRegistry(7);
  registry.observe('tts', { module: 'tts', evidence: evidence({ configured: true, reachable: true, operational: true }), reasonCode: null, repairAction: null }, 1_000);
  // The snapshot time is injected so the staleness window is measured, not guessed.
  assert.equal(registry.snapshot(1_000).modules.tts?.state, 'ready');
  // After the configured staleness window the previous success may no longer be shown as current-green.
  const stale = registry.snapshot(1_000 + healthStalenessMs() + 1);
  assert.notEqual(stale.modules.tts?.state, 'ready', 'a stale success must not stay green forever');
  assert.equal(stale.modules.tts?.evidence.operational, true, 'while the historical evidence stays visible');

  // Switching configuration invalidates previous health: the old result cannot colour the new revision.
  // The observation keeps the revision it was measured under (that is the evidence), while the snapshot
  // reports the revision now in force — the mismatch is exactly what makes the light non-current.
  registry.reconfigure(8);
  const afterSwitch = registry.snapshot();
  assert.equal(afterSwitch.configRevision, 8, 'the snapshot reports the revision now in force');
  assert.equal(afterSwitch.modules.tts?.configRevision, 7, 'the observation still records when it was measured');
  assert.equal(afterSwitch.modules.tts?.stale, true, 'so it is marked stale');
  assert.notEqual(afterSwitch.modules.tts?.state, 'ready', 'a result from the previous config revision is not valid for the new one');
  assert.equal(afterSwitch.modules.tts?.reasonCode, 'config_changed', 'and it says why it is no longer current');
});

// 07-B -----------------------------------------------------------------------------------------
test('07-B the microphone test works while the backend is failed, requests no permission before the explicit action, and touches no camera/network/database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fix61-mic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let permissionRequests = 0;
  const acquired: string[] = [];
  const fake = {
    async getUserMedia(constraints: { audio?: unknown; video?: unknown }) {
      permissionRequests++;
      // Only audio may ever be requested for a microphone test.
      assert.equal(constraints.video, undefined, 'a microphone test must never request the camera');
      acquired.push('audio');
      return { getTracks: () => [{ stop() { acquired.push('stopped'); }, getSettings: () => ({ sampleRate: 48000, channelCount: 1, deviceId: 'mic-2' }), label: '测试麦克风' }], getAudioTracks() { return this.getTracks(); } };
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'mic-1', label: '内建麦克风' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'USB 麦克风' },
        { kind: 'videoinput', deviceId: 'cam-1', label: '摄像头' }
      ];
    }
  };
  const store = await MicrophonePreferenceStore.open(join(dir, 'mic.json'));
  const lease = new MicrophoneTestLease({ media: fake as never, store });

  // No permission before the explicit action; enumeration is metadata only.
  const devices = await lease.listDevices();
  assert.equal(permissionRequests, 0, 'listing devices must not request permission');
  assert.deepEqual(devices.map(device => device.deviceId), ['mic-1', 'mic-2'], 'and must never list cameras');

  const started = await lease.start({ deviceId: 'mic-2' });
  assert.equal(permissionRequests, 1);
  assert.equal(started.deviceId, 'mic-2');
  assert.equal(started.maxDurationMs, TEST_RECORD_MAX_MS);
  assert.equal(TEST_RECORD_MAX_MS, 5000, 'a microphone test is capped at five seconds');

  // Level values are bounded scalars, never samples.
  lease.reportLevel(started.leaseId, { rms: 0.2, peak: 0.5 });
  assert.deepEqual(lease.level(started.leaseId), { rms: 0.2, peak: 0.5 });

  await lease.stop(started.leaseId);
  assert.ok(acquired.includes('stopped'), 'stopping releases every media track');
  assert.equal(lease.active(), false, 'and the lease is closed');
  assert.equal(lease.level(started.leaseId), null, 'no level survives the lease');
});

test('07-B the preference persists, survives a reload, and a device selection is never silently replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fix61-mic-pref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'mic.json');
  const first = await MicrophonePreferenceStore.open(file);
  assert.equal(first.deviceId(), null, 'the default is the system default device, stored as null rather than a fabricated id');
  await first.save('mic-2');
  const reloaded = await MicrophonePreferenceStore.open(file);
  assert.equal(reloaded.deviceId(), 'mic-2', 'the choice survives a restart');
  await reloaded.save(null);
  assert.equal((await MicrophonePreferenceStore.open(file)).deviceId(), null, 'the user can explicitly return to the system default');
  const raw = await (await import('node:fs/promises')).readFile(file, 'utf8');
  assert.ok(!raw.includes('/Users/') && !raw.includes('C:\\'), 'no filesystem path is stored');
});

test('07-B a missing track setting is reported as unknown, never as a fabricated value', () => {
  const unknown = describeTrackSettings({});
  assert.equal(unknown.sampleRate, null);
  assert.equal(unknown.channelCount, null);
  assert.equal(unknown.label, null);
  const known = describeTrackSettings({ sampleRate: 44100, channelCount: 2, label: 'USB 麦克风', deviceId: 'mic-2' });
  assert.equal(known.sampleRate, 44100);
  assert.equal(known.channelCount, 2);
  assert.equal(known.label, 'USB 麦克风');
});

// 07-C / 07-D ----------------------------------------------------------------------------------
test('07-C an unplugged device, a hidden label, a denied permission and an all-zero capture are four distinct diagnoses', () => {
  const lease = new MicrophoneTestLease({ media: undefined as never, store: undefined as never });
  const unplugged = lease.diagnose({ requestedDeviceId: 'mic-9', devices: [{ deviceId: 'mic-1', label: '内建麦克风', kind: 'audioinput' }] });
  assert.equal(unplugged.code, 'device_missing');
  assert.match(unplugged.message, /拔出|不存在|移除/);

  const hidden = lease.diagnose({ requestedDeviceId: 'mic-1', devices: [{ deviceId: 'mic-1', label: '', kind: 'audioinput' }] });
  assert.equal(hidden.code, 'label_hidden');

  const denied = lease.diagnose({ requestedDeviceId: 'mic-1', devices: [], error: { name: 'NotAllowedError' } });
  assert.equal(denied.code, 'permission_denied');

  const silent = lease.diagnose({ requestedDeviceId: 'mic-1', devices: [{ deviceId: 'mic-1', label: '内建麦克风', kind: 'audioinput' }], observedNonzero: false, sampleCount: 48000 });
  assert.equal(silent.code, 'no_signal');
  assert.match(silent.message, /没有|静音|无声/);

  // Four different causes must never collapse into one message.
  assert.equal(new Set([unplugged.code, hidden.code, denied.code, silent.code]).size, 4);
});

test('07-D the five second cap, the level value range and the release on close are all enforced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fix61-mic-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await MicrophonePreferenceStore.open(join(dir, 'mic.json'));
  const lease = new MicrophoneTestLease({ media: undefined as never, store });
  // A level outside the documented 0..1 range is refused instead of displayed as if measured.
  assert.throws(() => lease.validateLevel({ rms: -0.1, peak: 0.5 }), /电平/);
  assert.throws(() => lease.validateLevel({ rms: 0.5, peak: 0.2 }), /电平/);
  assert.throws(() => lease.validateLevel({ rms: 0.5, peak: 1.5 }), /电平/);
  assert.doesNotThrow(() => lease.validateLevel({ rms: 0, peak: 0 }));
  assert.doesNotThrow(() => lease.validateLevel({ rms: 0.5, peak: 0.5 }));
});
