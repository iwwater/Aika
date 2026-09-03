/**
 * 麦克风能量监听：她说话时用户开口，立刻打断。
 *
 * 这不是 VAD 的最终形态——M3 的 Silero VAD 上来之后整块换掉。现在只回答一个是非题：
 * 播放期间有没有人在说话。
 *
 * 回声是唯一的难点：她的声音从音箱出来会被麦克风收回去，处理不好她会自己打断自己。
 * 两道防线：getUserMedia 打开 echoCancellation 交给 WebView2 做回声抑制；
 * 再要求能量连续若干帧超过噪声底，短促的敲键盘和咳嗽不算开口。
 *
 * 已知代价：从检测到开口再启动识别有两三百毫秒，用户的第一个音节可能丢。
 * 这条要等本地管线自己持有音频缓冲区才能真正解决——那时候可以往前回补。
 */

export interface MicActivityOptions {
  /** 连续多少帧超过阈值才算开口。 */
  frames?: number;
  /** 采样间隔，毫秒。 */
  intervalMs?: number;
  /** 阈值相对噪声底的倍数。 */
  gain?: number;
  /** 阈值的绝对下限，避免极安静的房间里被微小噪声触发。 */
  floor?: number;
}

export interface MicActivityMonitor {
  isAvailable(): boolean;
  /** 开始监听。检测到开口只回调一次，之后自动停下，由调用方决定要不要再开。 */
  start(onSpeech: () => void): Promise<void>;
  stop(): void;
  /** 释放麦克风与音频上下文。退出语音页时调用。 */
  dispose(): Promise<void>;
}

export function createMicActivityMonitor(options: MicActivityOptions = {}): MicActivityMonitor {
  const frames = options.frames ?? 4;
  const intervalMs = options.intervalMs ?? 50;
  const gain = options.gain ?? 3.2;
  const floor = options.floor ?? 0.02;

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let timer: number | null = null;
  let buffer: Float32Array | null = null;
  let noiseFloor = floor;
  let hits = 0;

  function available() {
    return typeof AudioContext !== "undefined"
      && typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async function ensureGraph() {
    if (analyser) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    buffer = new Float32Array(analyser.fftSize);
    context.createMediaStreamSource(stream).connect(analyser);
  }

  function rms(): number {
    if (!analyser || !buffer) return 0;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
    return Math.sqrt(sum / buffer.length);
  }

  function clearTimer() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  return {
    isAvailable: available,

    async start(onSpeech) {
      if (!available()) throw new Error("当前环境没有可用的音频输入接口");
      await ensureGraph();
      await context?.resume();
      clearTimer();
      hits = 0;
      noiseFloor = floor;

      timer = window.setInterval(() => {
        const level = rms();
        const threshold = Math.max(noiseFloor * gain, floor);

        if (level < threshold) {
          // 安静的帧才更新噪声底，否则说话声会把底噪抬上去，越说越难触发。
          noiseFloor = noiseFloor * 0.9 + level * 0.1;
          hits = 0;
          return;
        }

        hits += 1;
        if (hits < frames) return;
        clearTimer();
        hits = 0;
        onSpeech();
      }, intervalMs);
    },

    stop() {
      clearTimer();
      hits = 0;
    },

    async dispose() {
      clearTimer();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      analyser = null;
      buffer = null;
      await context?.close().catch(() => undefined);
      context = null;
    },
  };
}
