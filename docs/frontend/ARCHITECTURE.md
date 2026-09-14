# 前端架构与接口

> 2026-09-14 桌宠架构变更：新的独立桌宠采用 [Integration RPD](RPD_DESKTOP_PET_INTEGRATION.md) 与 [接入契约v1（拟定）](DESKTOP_PET_CONTRACT.md)。下文自研pet窗口/CharacterRenderer等不再作为新路线派发依据；现有主应用架构与单一CompanionRuntime约束保留。

Components→UI Hooks/Presenter→Runtime Port；Runtime 快照/事件→ViewModel→Components。UI 不引用 Provider 实现、Memory 排名算法或 ASR/TTS 具体后端。

```ts
interface CompanionViewModel {
  activeTurnId: string | null;
  busy: boolean;
  messages: readonly MessageView[];
  mode: ModeConfig;
  error: string | null;
}
interface CompanionPresenter {
  getSnapshot(): CompanionViewModel;
  subscribe(listener: () => void): () => void;
  send(text: string): void;
  cancel(): void;
  setMode(config: ModeConfig): Promise<void>;
  exitScenario(): Promise<void>;
  dispose(): void;
}
```

MessageView 含 id/turnId/role/text/translation/deliveryStatus；复用领域 DTO，不复制模型回复 JSON 协议。Presenter 通过注入 Runtime 与 ModeStore 创建，可使用同契约 fake 独立运行；订阅清理与取消不依赖组件重渲染次数。

FE-01 对接消息状态与取消；FE-02 提供模式/场景设置，不乐观假称持久化成功；FE-03 消费 InputEvent/OutputEvent，发出立即发送/清空命令，高亮按 sentenceId 或经核实的文本范围。语音桥接的 STT→Runtime cancel→TTS stop 是跨模块编排，在 INT-02 验，不在展示层偷偷启动真实服务。
