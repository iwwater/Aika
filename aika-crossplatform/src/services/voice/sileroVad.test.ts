import { beforeEach, expect, it, vi } from "vitest";
import { createSileroVad } from "./sileroVad";

const model = vi.hoisted(() => ({
  inputNames: ["input", "state", "sr"],
  inputs: [] as { data: Float32Array; dims: number[] }[],
}));

vi.mock("onnxruntime-web/wasm", () => {
  class Tensor {
    constructor(public type: string, public data: Float32Array | BigInt64Array, public dims: number[]) {}
  }
  return {
    Tensor,
    env: { wasm: {} },
    InferenceSession: {
      create: async () => ({
        inputNames: model.inputNames,
        run: async (feeds: Record<string, Tensor>) => {
          model.inputs.push({ data: Float32Array.from(feeds.input.data as Float32Array), dims: [...feeds.input.dims] });
          return { output: new Tensor("float32", new Float32Array([0.8]), [1]), stateN: feeds.state, hn: feeds.h, cn: feeds.c };
        },
        release: async () => {},
      }),
    },
  };
});

beforeEach(() => {
  model.inputNames = ["input", "state", "sr"];
  model.inputs = [];
});

it("v5 prepends prior audio context and clears it on reset", async () => {
  const vad = createSileroVad();
  const first = Float32Array.from({ length: 512 }, (_, i) => i / 512);
  await vad.probability(first);
  expect(model.inputs[0].dims).toEqual([1, 576]);
  expect(model.inputs[0].data.slice(0, 64)).toEqual(new Float32Array(64));
  expect(model.inputs[0].data.slice(64)).toEqual(first);
  await vad.probability(new Float32Array(512));
  expect(model.inputs[1].data.slice(0, 64)).toEqual(first.slice(-64));
  vad.reset();
  await vad.probability(new Float32Array(512));
  expect(model.inputs[2].data.slice(0, 64)).toEqual(new Float32Array(64));
  await vad.dispose();
});

it("v5 uses 32 context samples at 8 kHz", async () => {
  const vad = createSileroVad(8000);
  await vad.probability(new Float32Array(256));
  expect(model.inputs[0].dims).toEqual([1, 288]);
  await vad.dispose();
});

it("v4 preserves the original frame without v5 context", async () => {
  model.inputNames = ["input", "h", "c", "sr"];
  const vad = createSileroVad();
  const frame = new Float32Array(512).fill(0.25);
  await vad.probability(frame);
  expect(model.inputs[0]).toEqual({ data: frame, dims: [1, 512] });
  await vad.dispose();
});
