// FIX61-11 wiring for FIX61-07: the DOM half of the desktop microphone test.
//
// `mic-test.mjs` holds the testable controller; this module is the thin browser bootstrap that binds it
// to the real page. Everything device-related stays here so the controller can be unit-tested against an
// injected media boundary, while the production window uses the real MediaDevices and AudioContext.
//
// It requests AUDIO ONLY. `video` is never present in any constraint it builds, so a mic test can never
// light the camera, start ASR, call the LLM or write Timeline — it is a local device check.
//
// Persistence: the renderer cannot touch a file, and must not import the Node-only preference store (that
// would drag `node:fs/promises` into the browser bundle). The device id is read from and written to the
// shell instead, which stores it beside its own display preferences.
import { MicTestController } from './mic-test.ts';
import { MicrophoneTestLease } from '../media/microphone-test.ts';

/**
 * The renderer's view of the machine-local preference. It is deliberately the same shape as
 * `MicrophonePreferenceStore` (deviceId()/save()), so the lease and the controller are unchanged, but every
 * read and write goes through the shell — the shell owns the file, the renderer never sees a path.
 */
class ShellPreference {
  constructor(shell, initial) { this.shell = shell; this.selected = initial ?? null; }
  deviceId() { return this.selected; }
  async save(deviceId) { await Promise.resolve(this.shell({ type: 'mic_test_preference', deviceId })); this.selected = deviceId; }
}

/** Real browser media, including the object-URL lifetime the controller must manage. */
function browserMedia() {
  return {
    createMediaRecorder: stream => new MediaRecorder(stream),
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url)
  };
}

/**
 * The displayed level comes from an AnalyserNode fed by the ONE stream the test lease opened. The tap is
 * used for nothing but a display value: no sample is retained, buffered, or sent anywhere.
 */
class LevelTap {
  constructor(stream, onLevel) {
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.onLevel = onLevel;
    this.running = true;
    this.context.createMediaStreamSource(stream).connect(this.analyser);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }
  frame() {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    this.analyser.getFloatTimeDomainData(this.buffer);
    let peak = 0, sum = 0;
    for (const sample of this.buffer) {
      const value = Math.abs(sample);
      if (value > peak) peak = value;
      sum += sample * sample;
    }
    // Clamp to the documented 0..1 range; a signal beyond it is a display ceiling, not a new measurement.
    this.onLevel(Math.min(1, Math.sqrt(sum / this.buffer.length)), Math.min(1, peak));
  }
  close() { this.running = false; void this.context.close().catch(() => {}); }
}

/**
 * Mounts the microphone test view.  `get(id)` is the page's element lookup, `shell(value)` posts a typed
 * message to Electron main, and `busy()` reports whether a conversation capture currently owns the
 * device — the two must never run at once (FIX61-07 §2: "不能同时打开会话采集").
 *
 * Returns `null` when the page has no microphone section, so a page without the DOM is inert rather than
 * throwing during boot.
 */
export function installMicrophoneTest({ get, shell, busy }) {
  const view = get('mic-test');
  if (!view) return null;
  let controller = null, lease = null, tap = null, preference = null, opened = false, storedDeviceId = null;

  const show = snapshot => {
    const recording = snapshot.state === 'recording';
    get('mic-start').hidden = recording;
    get('mic-stop').hidden = !recording;
    get('mic-start').disabled = recording;
    get('mic-refresh').disabled = recording;
    get('mic-device').disabled = recording;
    get('mic-meter').hidden = !recording;
    if (snapshot.level) {
      get('mic-meter-fill').style.width = Math.round(snapshot.level.rms * 100) + '%';
      get('mic-meter').dataset.loud = String(snapshot.level.peak >= 0.98);
      get('mic-level').textContent = `正在试麦 · 实测电平 ${(snapshot.level.rms * 100).toFixed(1)}%（峰值 ${(snapshot.level.peak * 100).toFixed(1)}%）· 最长 ${Math.round(snapshot.maxDurationMs / 1000)} 秒`;
    } else if (recording) get('mic-level').textContent = `正在试麦 · 尚未收到音频样本 · 最长 ${Math.round(snapshot.maxDurationMs / 1000)} 秒`;
    get('mic-playback').hidden = !snapshot.playable;
    if (snapshot.playable && controller) { const audio = get('mic-audio'); if (audio.src !== controller.objectUrl) audio.src = controller.objectUrl; }
    // Unknown stays unknown: a field the device did not report is shown as unknown, never defaulted.
    const facts = [['实测采样率', snapshot.sampleRate === null ? '未知（设备未报告）' : snapshot.sampleRate + ' Hz'],
      ['实测声道', snapshot.channelCount === null ? '未知（设备未报告）' : String(snapshot.channelCount)],
      ['设备名称', snapshot.label ?? '未知（可能尚未授权）'],
      ['当前选择', snapshot.deviceId === null ? '系统默认设备' : snapshot.deviceId],
      ['上限', Math.round(snapshot.maxDurationMs / 1000) + ' 秒，仅内存']];
    get('mic-facts').replaceChildren(...facts.flatMap(([term, value]) => {
      const dt = document.createElement('dt'); dt.textContent = term;
      const dd = document.createElement('dd'); dd.textContent = value; return [dt, dd];
    }));
    const diagnosis = get('mic-diagnosis');
    diagnosis.dataset.tone = snapshot.diagnosis ? 'error' : 'ok';
    diagnosis.textContent = snapshot.diagnosis ? snapshot.diagnosis.message
      : snapshot.state === 'ready' ? '这次试麦正常结束了。录音只在本机内存中，关闭面板即销毁。'
        : snapshot.state === 'failed' ? '这次试麦没有完成。' : '';
  };

  /**
   * The machine-local preference, as last reported by the shell. The shell owns the file; the renderer
   * only ever sends or receives a device id, never a path. Until the shell has reported a value the choice
   * is kept for this session only rather than written somewhere unmanaged.
   */
  function openPreference() {
    preference ??= new ShellPreference(shell, storedDeviceId);
    return preference;
  }

  const ensure = async () => {
    if (controller) return controller;
    const store = await openPreference();
    lease = new MicrophoneTestLease({ media: navigator.mediaDevices, store });
    controller = new MicTestController({ media: browserMedia(), lease,
      // The recorder and the level tap both attach to the stream the lease opened, so one test opens the
      // device exactly once.
      streamFor: id => lease.stream(id),
      captureBusy: busy, onChange: show });
    return controller;
  };

  async function refreshDevices() {
    const instance = await ensure();
    if (!instance || instance.active) return;
    const snapshot = await instance.listDevices();
    const chosen = preference?.deviceId() ?? null;
    const options = [{ deviceId: '', label: '系统默认设备' }, ...snapshot.devices];
    // A device label is only visible after permission is granted; the list still enumerates, and the
    // diagnosis below explains why a name is missing instead of hiding the entry.
    get('mic-device').replaceChildren(...options.map(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || (device.deviceId ? '未命名输入设备' : '系统默认设备');
      if (device.deviceId === (chosen ?? '')) option.selected = true;
      return option;
    }));
    show(snapshot);
    // A stored microphone that is gone is reported, never silently replaced by another device.
    if (chosen && !snapshot.devices.some(device => device.deviceId === chosen)) {
      get('mic-diagnosis').dataset.tone = 'error';
      get('mic-diagnosis').textContent = '上次选择的麦克风已不在设备列表中（可能已被拔出）。请重新选择，或改用系统默认设备。';
    }
  }

  async function start() {
    const instance = await ensure();
    if (!instance) return;
    if (busy()) { show({ ...instance.snapshot(), state: 'failed', diagnosis: { code: 'capture_busy', message: '正在对话录音，无法同时试麦。请先结束这一轮对话。' } }); return; }
    const deviceId = get('mic-device').value || null;
    // The choice is remembered only as an explicit user decision, and only when the test actually opens.
    const snapshot = await instance.start(deviceId);
    if (snapshot.state === 'recording') {
      try { await preference?.save(deviceId); } catch { /* a preference write failure never blocks the test */ }
      tap?.close(); tap = null;
      try {
        // The tap attaches to the SAME stream the test opened. A second getUserMedia here would open the
        // device twice for one test.
        const source = instance.levelSource;
        if (source) tap = new LevelTap(source, (rms, peak) => instance.reportLevel({ rms, peak }));
      } catch { tap = null; /* a missing tap leaves the level unknown, never fabricated */ }
    }
    show(instance.snapshot());
  }

  async function stop() {
    tap?.close(); tap = null;
    if (!controller) return;
    await controller.stop();
    show(controller.snapshot());
  }

  async function close() {
    tap?.close(); tap = null;
    if (controller) await controller.close();
  }

  get('mic-close').onclick = () => { void close(); panel(false); };
  get('mic-refresh').onclick = () => { void refreshDevices(); };
  get('mic-start').onclick = () => { void start(); };
  get('mic-stop').onclick = () => { void stop(); };
  get('mic-device').onchange = event => { void Promise.resolve(preference?.save(event.target.value || null)).catch(() => {}); };
  // Leaving the window, hiding it or losing focus cancels the test and drops the recording and its URL.
  document.addEventListener('visibilitychange', () => { if (document.hidden) void close(); });
  window.addEventListener('blur', () => { void close(); });
  window.addEventListener('pagehide', () => { void close(); });

  function panel(open) {
    if (opened === open) return;
    opened = open;
    view.hidden = !open;
    view.inert = !open;
    if (open) {
      get('mic-diagnosis').textContent = '';
      // The explicit lease request: Electron only grants microphone permission while a test is open.
      void shell({ type: 'mic_test_request' });
      void refreshDevices();
    } else {
      void close();
      void shell({ type: 'mic_test_release' });
    }
  }
  return { open: panel, close, isOpen: () => opened,
    /**
     * The shell reports the stored device id. A device that is still stored is applied to the picker on
     * the next refresh, and a stored id whose device has gone is reported rather than silently replaced.
     */
    setStoredDevice: deviceId => { storedDeviceId = typeof deviceId === 'string' && deviceId ? deviceId : null; },
    /**
     * FIX61-10 (FIX61-07 07-C): the device the conversation capture should use — the stored machine-local
     * choice once it has been reported by the shell, otherwise the id chosen in this session. Null keeps
     * meaning the explicit system default; the driver applies it with an `exact` constraint when set.
     */
    selectedDeviceId: () => preference?.deviceId() ?? (storedDeviceId || null) };
}
