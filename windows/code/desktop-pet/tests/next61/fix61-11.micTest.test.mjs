// FIX61-11 wiring RED->GREEN (FIX61-07 07-B/07-D): the desktop microphone-test controller.
//
// The controller under test is the REAL production object (`desktop/mic-test.mjs`), and the REAL
// `MicrophoneTestLease` from `media/microphone-test.ts` decides devices, the five-second cap, level
// validation and diagnosis. Only the browser boundary (getUserMedia / MediaRecorder / object URLs) is
// injected, because a test must never open a real device.
//
// It exercises the three properties that make 试麦 safe to ship: audio only, five-second bound, and an
// object URL that is always revoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MicTestController, TEST_RECORD_MAX_MS } from '../../dist/desktop/mic-test.js';
// The real production lease and preference store, taken from the compiled output: the TypeScript source
// uses parameter properties, which Node's strip-only loader refuses (the same reason FIX61-05's report
// gives for bundling the renderer). Both objects under test are therefore production code, not doubles.
// The preference store lives in its own module so the renderer bundle stays free of node:fs (FIX61-11).
import { MicrophoneTestLease } from '../../dist/media/microphone-test.js';
import { MicrophonePreferenceStore } from '../../dist/media/microphone-preference.js';

/** A recording double for the browser media boundary. It records exactly what it was asked for. */
function fakeMedia({ devices = [], failWith = null, chunks = ['audio-bytes'] } = {}) {
  const calls = { getUserMedia: [], created: [], revoked: [], stopped: 0, recorderStarts: 0, recorderStops: 0 };
  const streams = [];
  // The lease is the ONE owner of the device; `streamFor` hands that same stream to the controller, so a
  // test must never acquire a second microphone.
  const getUserMedia = async constraints => {
    calls.getUserMedia.push(constraints);
    if (failWith) { const error = new Error('denied'); error.name = failWith; throw error; }
    const stream = { getTracks: () => [{ stop: () => { calls.stopped++; } }], getAudioTracks: () => [{ stop: () => { calls.stopped++; } }] };
    streams.push(stream);
    return stream;
  };
  const media = {
    createMediaRecorder: () => {
      let recorder;
      recorder = {
        start: () => { calls.recorderStarts++; },
        stop: () => {
          calls.recorderStops++;
          // A real recorder emits its last chunk and then stops, in that order.
          for (const chunk of chunks) recorder.ondataavailable?.({ data: chunk });
          recorder.onstop?.();
        },
        ondataavailable: null, onstop: null, onerror: null
      };
      return recorder;
    },
    createObjectURL: () => { const url = 'blob:mic-test/' + (calls.created.length + 1); calls.created.push(url); return url; },
    revokeObjectURL: url => { calls.revoked.push(url); }
  };
  const leaseMedia = { enumerateDevices: async () => devices, getUserMedia };
  return { media, leaseMedia, calls, streams };
}

async function preference(t) {
  const root = await mkdtemp(join(tmpdir(), 'fix61-11-mic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return MicrophonePreferenceStore.open(join(root, 'microphone.json'));
}

async function controllerFor(t, options = {}) {
  const fake = fakeMedia(options);
  const store = await preference(t);
  const lease = new MicrophoneTestLease({ media: fake.leaseMedia, store });
  const controller = new MicTestController({ media: fake.media, lease,
    streamFor: leaseId => lease.stream(leaseId), ...(options.controller ?? {}) });
  return { controller, lease, store, ...fake };
}

test('11-D listing devices never requests permission and never offers a camera', async t => {
  const { controller, calls } = await controllerFor(t, { devices: [
    { kind: 'audioinput', deviceId: 'mic-1', label: '内置麦克风' },
    { kind: 'videoinput', deviceId: 'cam-1', label: '摄像头' },
    { kind: 'audioinput', deviceId: '', label: '空标识必须忽略' }
  ] });

  const snapshot = await controller.listDevices();
  assert.equal(calls.getUserMedia.length, 0, 'listing devices must not request permission');
  assert.deepEqual(snapshot.devices.map(device => device.deviceId), ['mic-1'], 'only real audio inputs are listed');
  assert.equal(snapshot.devices[0].label, '内置麦克风');
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.maxDurationMs, TEST_RECORD_MAX_MS, 'the five-second cap is published to the view');
  assert.equal(snapshot.sampleRate, null, 'nothing was measured yet, so the sample rate is unknown');
});

test('11-D a test is audio-only, bounded to five seconds, and reports real track settings', async t => {
  const timers = [];
  const cleared = [];
  const { controller, calls, streams } = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-2', label: 'USB 麦克风' }],
    controller: { setTimer: (fn, ms) => { timers.push({ fn, ms }); return 'timer-1'; }, clearTimer: handle => cleared.push(handle) } });

  await controller.start('mic-2');
  assert.equal(calls.getUserMedia.length, 1, 'one test opens the device exactly once');
  const constraints = calls.getUserMedia[0];
  assert.equal(constraints.video, undefined, 'a mic test must never request a camera');
  assert.deepEqual(constraints.audio, { deviceId: { exact: 'mic-2' }, echoCancellation: false }, 'the chosen device is requested exactly');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, TEST_RECORD_MAX_MS, 'the local recording is capped at five seconds');

  // An out-of-range level is refused rather than displayed as if it were measured.
  controller.reportLevel({ rms: 0.4, peak: 0.3 });
  assert.equal(controller.snapshot().level, null, 'peak below rms is refused');
  controller.reportLevel({ rms: 0.2, peak: 0.6 });
  assert.deepEqual(controller.snapshot().level, { rms: 0.2, peak: 0.6 });

  await controller.stop();
  assert.equal(cleared.length, 1, 'the display timer is cleared when the test ends');
  assert.ok(calls.stopped >= 1, 'the lease releases every track');
  assert.equal(controller.active, false);
  assert.equal(controller.snapshot().level, null);
  assert.equal(streams.length, 1);
});

test('11-D the recording lives only in memory and its object URL is revoked on close', async t => {
  const { controller, calls } = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: '内置麦克风' }] });

  await controller.start('mic-1');
  await controller.stop();
  assert.equal(calls.created.length, 1, 'one bounded local recording is created');
  assert.equal(calls.created.length - calls.revoked.length, 1, 'the URL is live only while it is playable');
  assert.equal(controller.snapshot().playable, true);
  assert.equal(controller.objectUrl, calls.created[0]);

  await controller.close();
  assert.deepEqual(calls.revoked, calls.created, 'closing the panel revokes every object URL it made');
  assert.equal(controller.snapshot().playable, false, 'the recording is gone from the process');
  assert.equal(controller.objectUrl, null);
});

test('11-D a recording that produced nothing is not offered as playable', async t => {
  const { controller, calls } = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: 'x' }], chunks: [] });
  await controller.start('mic-1');
  await controller.stop();
  assert.equal(calls.created.length, 0, 'an empty recording must not become a playback URL');
  assert.equal(controller.snapshot().playable, false);
});

test('11-D a denied microphone is diagnosed, not hidden, and leaves no resource behind', async t => {
  const { controller, calls } = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: '内置麦克风' }], failWith: 'NotAllowedError' });
  await controller.listDevices();
  const snapshot = await controller.start('mic-1');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.diagnosis.code, 'permission_denied', 'a denied permission has its own distinct cause');
  assert.match(snapshot.diagnosis.message, /权限/);
  assert.equal(controller.objectUrl, null, 'a failed test makes no recording');
});

test('11-D an unplugged device and a hidden label are diagnosed separately', async t => {
  const unplugged = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: '内置麦克风' }], failWith: 'NotFoundError' });
  await unplugged.controller.listDevices();
  const missing = await unplugged.controller.start('mic-gone');
  assert.equal(missing.diagnosis.code, 'device_missing');

  // A device whose label is empty is a permission state, not a broken device.
  const hidden = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: '' }] });
  const listed = await hidden.controller.listDevices();
  assert.equal(listed.diagnosis.code, 'label_hidden');
  assert.match(listed.diagnosis.message, /授权/);
});

test('11-D a test never runs alongside a conversation capture', async t => {
  let busy = true;
  const { controller, calls } = await controllerFor(t, { devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: 'x' }],
    controller: { captureBusy: () => busy } });
  const refused = await controller.start(null);
  assert.equal(calls.getUserMedia.length, 0, 'a busy conversation capture blocks the test outright');
  assert.equal(refused.state, 'failed');
  assert.equal(refused.diagnosis.code, 'capture_busy');

  busy = false;
  const started = await controller.start(null);
  assert.equal(started.state, 'recording');
  assert.deepEqual(calls.getUserMedia[0].audio, { echoCancellation: false }, 'the system default device is an explicit choice, not a missing one');
});

test('11-D the chosen device is stored as machine-local preference and survives a restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fix61-11-mic-pref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'microphone.json');
  const first = await MicrophonePreferenceStore.open(file);
  assert.equal(first.deviceId(), null, 'null means "the system default device", an explicit choice');
  await first.save('mic-usb-2');

  const reopened = await MicrophonePreferenceStore.open(file);
  assert.equal(reopened.deviceId(), 'mic-usb-2');
  await reopened.save(null);
  assert.equal((await MicrophonePreferenceStore.open(file)).deviceId(), null, 'the user can explicitly go back to default');

  // The preference is an identifier, never a filesystem path or a recording.
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes(root), 'the stored preference contains no path');
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['deviceId', 'version']);
});

test('11-C the renderer-side controller is wired into the desktop page, not the console', async t => {
  const { readFile } = await import('node:fs/promises');
  const pet = new URL('../../', import.meta.url);
  const page = await readFile(new URL('desktop/index.html', pet), 'utf8');
  // Without this DOM the view cannot exist, and the function panel's entry would be dead again.
  for (const id of ['mic-test', 'mic-device', 'mic-start', 'mic-stop', 'mic-close', 'mic-meter-fill', 'mic-audio', 'mic-facts', 'mic-diagnosis']) {
    assert.ok(page.includes('id="' + id + '"'), 'the desktop page must contain #' + id);
  }
  const main = await readFile(new URL('desktop/main.mjs', pet), 'utf8');
  assert.match(main, /FUNCTION_CAPABILITIES = \{ skin: true, microphone: true \}/, 'both panel entries are reachable now');
  assert.match(main, /installMicrophoneTest\(/, 'the real controller is installed in the trusted renderer');
  // FIX61-07 §2: the console has no device channel, so the desktop owns the test.
  const server = await readFile(new URL('management/server.ts', pet), 'utf8');
  assert.ok(!/getUserMedia/.test(server), 'the management console never opens a microphone itself');
  const panelSource = await readFile(new URL('desktop/mic-test-panel.mjs', pet), 'utf8');
  assert.ok(!/mediaDevices\.getUserMedia/.test(panelSource), 'the panel never opens a second microphone for the level tap');
  assert.match(panelSource, /instance\.levelSource/, 'the level tap attaches to the stream the test opened');
});

test('11-C the shell grants audio for a mic test without a ready backend, and never the camera', async t => {
  const { readFile } = await import('node:fs/promises');
  const shell = await readFile(new URL('../../desktop/electron/main.mjs', import.meta.url), 'utf8');
  assert.match(shell, /case 'mic_test_request'/, 'an explicit mic-test lease exists in the shell');
  assert.match(shell, /case 'mic_test_release'/, 'the lease can be released explicitly');
  // The shell, not the renderer, owns the preference file; the renderer only sends or receives a device id.
  assert.match(shell, /case 'mic_test_preference'/, 'the shell persists the chosen microphone');
  assert.match(shell, /microphone\.json/, 'the preference is machine-local app data');
  const panelSource = await readFile(new URL('../../desktop/mic-test-panel.mjs', import.meta.url), 'utf8');
  // Only real import statements are checked: the file's comments explain why node:fs is avoided.
  assert.ok(!/^\s*import[^;]*node:/m.test(panelSource), 'the renderer never imports a filesystem module');
  assert.ok(!/^\s*import[^;]*MicrophonePreferenceStore/m.test(panelSource), 'the renderer never imports the Node-only preference store');
  assert.match(panelSource, /class ShellPreference/, 'the renderer stores the choice through the shell');
  // The import graph is what actually decides: the renderer's entry must bundle without node builtins.
  const controllerSource = await readFile(new URL('../../desktop/mic-test.ts', import.meta.url), 'utf8');
  assert.ok(!/^\s*import[^;]*node:/m.test(controllerSource), 'the testable controller itself is filesystem-free');
  // The permission rule spans several lines, so it is matched across them rather than line-by-line.
  const rule = /const mediaAllowed = \(wc, permission, origin, types, mainFrame\) =>[\s\S]*?types\.every\([^;]*;/.exec(shell);
  assert.ok(rule, 'the media permission rule is present');
  assert.match(rule[0], /micTestRequested/, 'a mic test grants audio independently of voiceRequested/wakeRequested');
  assert.match(rule[0], /type === 'video' && voiceRequested/, 'the camera still requires a real voice turn');
  assert.match(rule[0], /voiceRequested \|\| wakeRequested \|\| micTestRequested/, 'audio is granted for a test with no ready backend');
});

test('11-C/FIX61-10 the conversation capture records from the mic the test picked, across a restart', async t => {
  const { readFile } = await import('node:fs/promises');
  const pet = new URL('../../', import.meta.url);
  // The renderer exposes the machine-local choice to the capture path: the stored id once the shell has
  // reported it, otherwise the id chosen this session. The missing case stays null, and null stays the
  // explicit system default — the renderer never invents a fallback device.
  const panel = await readFile(new URL('../../desktop/mic-test-panel.mjs', import.meta.url), 'utf8');
  assert.match(panel, /selectedDeviceId: \(\) => preference\?\.deviceId\(\) \?\? \(storedDeviceId \|\| null\)/,
    'the panel exposes the effective device choice');
  // The trusted renderer passes that choice into the real conversation driver at every capture start.
  const main = await readFile(new URL('../../desktop/main.mjs', import.meta.url), 'utf8');
  const driver = /const driver = new BrowserCaptureDriver\(\{[\s\S]*?\}\);/.exec(main);
  assert.ok(driver, 'the conversation capture constructs its driver in desktop/main.mjs');
  assert.match(driver[0], /deviceId: microphoneTest\?\.selectedDeviceId\(\) \?\? null/,
    'the conversation capture uses the same device the mic test selected');
  // 07-C "重启一致": the shell reports the stored device on every fresh page load, so a restart keeps
  // recording from the same microphone without any user action.
  const shell = await readFile(new URL('../../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const readyCase = /case 'ready':[\s\S]*?start\(\); break;/.exec(shell);
  assert.ok(readyCase, 'the shell handles the renderer ready case');
  assert.match(readyCase[0], /readMicrophonePreference\(\)\.then\(deviceId => deliver\('microphonePreference', deviceId\)\)/,
    'the stored choice is reported on every fresh page');
  // The driver itself consumes the option with an exact, non-falling-back constraint (regression guard).
  const capture = await readFile(new URL('../../media/browser-capture.ts', import.meta.url), 'utf8');
  const constraints = /const selected = this\.options\.deviceId \?\? null;[\s\S]*?deviceId: \{ exact: selected \}/.exec(capture);
  assert.ok(constraints, 'the driver applies the chosen device exactly instead of silently substituting');
});
