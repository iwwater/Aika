import { PET_INTENT_EVENT, validatePetIntent, type PetIntentV1 } from "./petIntent";

/**
 * 主窗侧的 pet 意图接收端（FE-31）。
 *
 * 链路：pet 页 → `pet_intent_submit`（Rust 校验窗口 label）→ `pet://intent`
 * 定向 emit 给主窗 → 这里做形状白名单校验 → 交给 `CompanionSessionController`。
 *
 * 这一层只做两件事：**丢弃形状不对的东西**、**统计丢弃数量**（诊断用）。
 * epoch、去重、会话状态全部由控制器裁决——权限判断不分散在两处。
 */

export interface PetIntentSink {
  handleIntent(intent: PetIntentV1, petEpoch: string): Promise<boolean>;
}

export interface PetIntentBridgeDeps {
  bridge: {
    listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
  };
  sink: PetIntentSink;
  /** 当前 pet 窗口代数；关窗再开后前移，旧 epoch 的意图被控制器丢弃。 */
  currentPetEpoch(): string;
}

export interface PetIntentBridge {
  start(): Promise<void>;
  stop(): void;
  /** 形状校验未通过而被丢弃的条数（诊断）。 */
  rejected(): number;
  /** 测试与编排入口：处理一条原始载荷。 */
  handlePayload(payload: unknown): Promise<boolean>;
}

export function createPetIntentBridge(deps: PetIntentBridgeDeps): PetIntentBridge {
  let unlisten: (() => void) | null = null;
  let rejected = 0;
  let running = false;

  async function handlePayload(payload: unknown): Promise<boolean> {
    // Tauri 的 listen 回调给的是 { payload } 包装；两种形状都接。
    const raw = payload !== null && typeof payload === "object" && "payload" in (payload as Record<string, unknown>)
      ? (payload as Record<string, unknown>).payload
      : payload;
    const intent = validatePetIntent(raw);
    if (!intent) {
      rejected += 1;
      return false;
    }
    return deps.sink.handleIntent(intent, deps.currentPetEpoch());
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      unlisten = await deps.bridge.listen(PET_INTENT_EVENT, (payload) => {
        void handlePayload(payload);
      });
    },

    stop(): void {
      running = false;
      unlisten?.();
      unlisten = null;
    },

    rejected(): number {
      return rejected;
    },

    handlePayload,
  };
}
