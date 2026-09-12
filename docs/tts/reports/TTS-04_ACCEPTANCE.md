# TTS-04 验收报告 · 云端输出设置与降级错误

- 执行：goal worker（2026-09-13）。SPEC：[TTS-04](../specs/TTS-04.md)。基线 commit：`942b750`。
- 状态：**AUTO_PASS（待人工验收）**——可自动 AC 全过；真实试听属 TTS-05，UI 视觉验证属人工。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `services/voice/tokens.ts`：`SpeechEngines` 新增 `output: VoiceOutputStatus`（selected/actual/note/degraded）与 `resolveOutput(config)` | — |
| `services/voice/outputEngine.ts`：`ResolvedOutputEngine` 增加 `actual`，工厂如实标注实际链路 | 既有用例包全绿 |
| `services/voice/outputSettings.ts` 新增：设置端口（结构字段进 `voice.output` 设置；Key 存 SecretStore `tts.cloud.apiKey`；空 Key=保持；删除显式；校验失败不写任何存储） | `outputSettings.test.ts` 5 例 |
| `presentation/voicePresenter.ts`：`applyVoiceOutput`（停旧队列→重建引擎/队列→更新 outputStatus）、`initialOutputConfig` 启动应用、快照暴露 `outputStatus` | `voicePresenter.outputSwitch.test.ts` 3 例 |
| `presentation/companionPresenter.ts`：`setVoiceOutput`（持久化成功才切内存与引擎；失败错误可见）、`removeVoiceApiKey`、快照 `voiceOutput`（不含 Key，只报 hasApiKey） | — |
| `app/plugins/voicePlugin.ts`：`defaultSpeechEngines` 透出 output/resolveOutput | — |
| `app/plugins/presentationPlugin.ts`：SecretStoreToken optional；桥接 companion→voice（lastVoiceOutput 闭包缓存，惰性构造不丢配置） | — |
| `hooks/useCompanionSession.ts`、`App.tsx`：设置表单（输出链路/地址/模型/音色/语速/Key 保存与删除按钮）+ 降级状态显示 | — |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/voice/outputSettings.test.ts src/presentation/voicePresenter.outputSwitch.test.ts` | 8 passed | 0 |
| `npx vitest run src/services/voice src/presentation src/app/plugins src/app/composition.test.ts src/hooks` | 36 文件 / 233 passed | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| TTS-04-A 保存/重开一致；Key 不进 Trace/普通设置导出 | `保存后重开读回一致；Key 只进 SecretStore`（settings JSON 断言不含 Key）；Key 不进快照（只 hasApiKey）；持久化用内存假存储（临时库验证由既有 storage 契约承担） | PASS | production+fixture |
| TTS-04-B 配置不全显示错误及实际 system，不显示云端成功 | outputEngine 既有降级语义（点名云端缺字段→degraded=true+system）+ 新增 `点名云端但配置不全：degraded=true 持久可见`；UI 侧 ⚠+note 持久显示 | PASS（逻辑层；UI 视觉留人工） | production+fixture |
| TTS-04-C 切引擎停旧队列；旧回调不覆盖新轮；auto 降级原因可见 | `切换时停掉旧队列，新轮次走新队列，实际链路与 note 可见`；旧回调隔离依赖 TTS-02 stop 语义（用例包全绿） | PASS | production+fixture |
| TTS-04-D 两引擎契约测试 + Presenter 错误传播通过 | speechInput/speechOutput 契约包（两实现）既有全绿；Presenter 传播经 outputSwitch 3 例 + 保存失败错误可见（`校验失败直接抛错，不写任何存储`）。真实试听另属 TTS-05 | PASS | production+fixture |

## 实现中做的判断

1. **保存失败不得只切内存**：`setVoiceOutput` 先经端口持久化（秘密→设置），任一失败抛错并进可见错误列表，内存配置原样保留。
2. **惰性构造下的配置不丢**：presentationPlugin 用闭包保存最后一份配置，voicePresenter 构造时以 `initialOutputConfig` 应用——保存早于语音页首次打开也生效。
3. **Key 的快照面**：companion 快照只暴露 hasApiKey；原始 Key 只在保存调用里出现，不进快照/Trace/设置 JSON。
4. **零隐式网络调用**：保存/重开/选 auto 全程不合成；`resolveOutput` 只做配置检查（复用 outputEngine 既有语义），试听入口留 TTS-05。

## 共享接口 / 消费者

- `SpeechEngines` 新增必填字段 `output`/`resolveOutput`（破坏性变更）：受影响消费者 = voicePlugin（已实现）、capabilityPlugins.test 的 denied stub（已更新）、presentationPlugin（已接线）。
- `ResolvedOutputEngine` 新增 `actual`（向后兼容式追加，工厂内部填充）。
- `SETTING_KEYS.voiceOutput = "voice.output"` 新增； SecretStore 命名 `tts.cloud.apiKey` 已在 [CONTRACTS](../../modules/CONTRACTS.md) 口径内（Key 走 SecretStore，不入业务表）。

## 未测/人工项

- 真实云 TTS 试听（音质/延迟/计费）：TTS-05，NOT RUN。
- UI 视觉/键盘操作：人工（浏览器冒烟或真机）。
- 桌面 DPAPI secrets.json 实际落盘：INT-01。
