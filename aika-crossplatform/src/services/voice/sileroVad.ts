/**
 * Silero VAD。
 *
 * 只负责一件事：给一帧 512 个采样，返回「这是人声」的概率。
 * 切段的规则在 `domain/vadSegmenter.ts`，那边是纯逻辑、能测；这里是模型调用。
 *
 * 输入输出的名字在运行时从 session 读，不写死：v4 用 h / c 两个状态张量，
 * v5 合并成一个 state。用户换了模型文件也不至于直接报错。
 *
 * onnxruntime 走动态 import：它连 wasm 有十几兆，只有真的用本地识别时才该付这个代价，
 * 退回 Web Speech 的用户不该为它等启动。
 */

type Ort = typeof import("onnxruntime-web/wasm");
type OrtTensor = import("onnxruntime-web").Tensor;
type OrtSession = import("onnxruntime-web").InferenceSession;

/** 模型和 wasm 运行时都走本地文件，不连 CDN——这是本地管线，不能依赖网络。 */
const MODEL_URL = "/models/silero_vad.onnx";
const WASM_PREFIX = "/ort/";

export interface VoiceActivityModel {
  /** 一帧的人声概率，0 到 1。 */
  probability(frame: Float32Array): Promise<number>;
  /** 换一轮对话时清空模型的循环状态，上一轮的尾音不要影响这一轮。 */
  reset(): void;
  dispose(): Promise<void>;
}

interface StateLayout {
  kind: "v5" | "v4";
  /** v5 是 state / stateN；v4 是 h、c / hn、cn。 */
  inputs: string[];
  outputs: string[];
  shape: number[];
}

function detectLayout(session: OrtSession): StateLayout {
  const inputs = session.inputNames;
  if (inputs.includes("state")) {
    return { kind: "v5", inputs: ["state"], outputs: ["stateN"], shape: [2, 1, 128] };
  }
  if (inputs.includes("h") && inputs.includes("c")) {
    return { kind: "v4", inputs: ["h", "c"], outputs: ["hn", "cn"], shape: [2, 1, 64] };
  }
  throw new Error(`无法识别的 Silero 模型结构，输入是：${inputs.join(", ")}`);
}

function zeros(ort: Ort, shape: number[]): OrtTensor {
  const size = shape.reduce((total, value) => total * value, 1);
  return new ort.Tensor("float32", new Float32Array(size), shape);
}

export function createSileroVad(sampleRate = 16_000): VoiceActivityModel {
  let ort: Ort | null = null;
  let session: OrtSession | null = null;
  let layout: StateLayout | null = null;
  let state: OrtTensor[] = [];
  let loading: Promise<void> | null = null;

  function resetState() {
    if (!layout || !ort) return;
    state = layout.inputs.map(() => zeros(ort!, layout!.shape));
  }

  async function load() {
    // 只要 wasm 后端：VAD 才 2 MB，WebGPU 那一份是白搭的十几兆。
    ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = WASM_PREFIX;
    // 单线程：VAD 一帧只要一两毫秒，开线程要 SharedArrayBuffer 和跨源隔离头，不值得。
    ort.env.wasm.numThreads = 1;

    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    layout = detectLayout(session);
    resetState();
  }

  async function ready() {
    if (session) return;
    if (!loading) loading = load();
    await loading;
  }

  return {
    async probability(frame) {
      await ready();
      if (!ort || !session || !layout) return 0;

      const feeds: Record<string, OrtTensor> = {
        input: new ort.Tensor("float32", frame, [1, frame.length]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(sampleRate)]), []),
      };
      layout.inputs.forEach((name, index) => {
        feeds[name] = state[index];
      });

      const result = await session.run(feeds);
      state = layout.outputs.map((name, index) => (result[name] as OrtTensor) ?? state[index]);

      const output = result.output as OrtTensor | undefined;
      const value = output?.data as Float32Array | undefined;
      return value?.[0] ?? 0;
    },

    reset() {
      resetState();
    },

    async dispose() {
      await session?.release().catch(() => undefined);
      session = null;
      layout = null;
      state = [];
      loading = null;
      ort = null;
    },
  };
}
