import { describe, expect, it } from "vitest";
import { createPetIntentBridge } from "./intentBridge";
import { PET_INTENT_EVENT, PET_INTENT_SCHEMA, type PetIntentV1 } from "./petIntent";

/**
 * FE-31-F：主窗侧意图接收端。形状不对的东西到不了控制器。
 */

function setup(options?: { epoch?: string }) {
  const handlers: Array<(payload: unknown) => void> = [];
  const received: Array<{ intent: PetIntentV1; epoch: string }> = [];
  const events: string[] = [];
  const bridge = createPetIntentBridge({
    bridge: {
      async listen(event, handler) {
        events.push(event);
        handlers.push(handler);
        return () => {
          handlers.length = 0;
        };
      },
    },
    sink: {
      async handleIntent(intent, petEpoch) {
        received.push({ intent, epoch: petEpoch });
        return true;
      },
    },
    currentPetEpoch: () => options?.epoch ?? "epoch-1",
  });
  return { bridge, handlers, received, events };
}

describe("createPetIntentBridge（FE-31-F）", () => {
  it("订阅的是 pet://intent；合法意图带着当前 epoch 交给控制器", async () => {
    const { bridge, handlers, received, events } = setup();
    await bridge.start();
    expect(events).toEqual([PET_INTENT_EVENT]);

    // Tauri listen 的 { payload } 包装与裸载荷都接。
    handlers[0]({ payload: { schemaVersion: PET_INTENT_SCHEMA, requestId: "r1", petEpoch: "epoch-1", kind: "open_main" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
    expect(received[0].intent.kind).toBe("open_main");
    expect(received[0].epoch).toBe("epoch-1");
  });

  it("形状不对的载荷被丢弃，不进控制器", async () => {
    const { bridge, received } = setup();
    for (const bad of [
      null,
      "pause_reading",
      { kind: "pause_reading" },
      { schemaVersion: "pet.intent.v2", requestId: "r", petEpoch: "e", kind: "talk", text: "x" },
      { schemaVersion: PET_INTENT_SCHEMA, requestId: "r", petEpoch: "e", kind: "outbound_publish" },
    ]) {
      expect(await bridge.handlePayload(bad)).toBe(false);
    }
    expect(received).toEqual([]);
    expect(bridge.rejected()).toBe(5);
  });

  it("stop 之后解绑订阅", async () => {
    const { bridge, handlers } = setup();
    await bridge.start();
    expect(handlers).toHaveLength(1);
    bridge.stop();
    expect(handlers).toHaveLength(0);
  });
});
