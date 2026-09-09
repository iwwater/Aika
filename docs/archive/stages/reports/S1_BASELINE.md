# S1.0 Voice Runtime 基线登记

- SPEC：`S1_VOICE_RUNTIME.md`（2026-09-10 版本）
- 日期：2026-09-10
- 验收人：Codex 工程执行任务（待原任务逐 AC 审阅）
- 修复前 commit：`fdb735bcb40dc6aa3ffcdd3ba3b39c8fa425eaed`
- 主工程：`F:/AIVoice/Aika/aika-crossplatform`
- 工作树：基线时保留用户既有未提交的 SPEC/导航修改；本报告属于本阶段新增证据

## 运行环境与可观测边界

- Node.js：`v24.18.0`
- npm：`11.16.0`
- `rustc` / `cargo`：不在当前 PATH；`npm run tauri build` 无法执行 Rust metadata
- Windows 硬件查询：`Get-CimInstance` 被当前权限拒绝；未将 CPU/GPU 型号写成已知事实
- 麦克风 / 外放：本轮未获得可验证的设备枚举或人工声学记录
- Whisper：`127.0.0.1:8080` 未发现监听进程；无本地 ASR 服务/模型证据
- Provider：未使用真实 API 凭证；无真实 LLM/TTS/网络延迟测量

## 修复前自动基线

| 命令 | 结果 | 退出码 | 实际结果 |
| --- | --- | ---: | --- |
| `npm test` | PASS | 0 | 21 个测试文件、265 个测试通过 |
| `npm run build` | PASS | 0 | `tsc` 与 Vite 生产构建通过；同步 2 个 ORT runtime 文件 |
| `npm run tauri build` | BLOCKED | 1 | Tauri CLI 报 `cargo metadata` 失败：`cargo` 不存在 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | NOT RUN | — | 当前环境没有 `cargo`，未伪造 Rust 结果 |

既有自动基线没有覆盖完整 Hook 的虚拟时钟、ASR 段乱序、取消后的持久化/记忆副作用和事件时序；这些是本阶段新增回归测试的目标。

## 修复前冻结的目标

以下目标在代码改动前登记，修复后不得为迁就结果下调：

1. 调度开销：`turnCommitted − max(asrFinal, speechEnd + 尾静音阈值)` 的实机 P95 ≤ **250 ms**（来自 S1-AC04）。
2. 首音频：必须在同一设备、同一输入引擎、同一 Provider/TTS 参数下完成修复前至少 20 个无打断回合，才能冻结绝对 P50/P95 数值。本基线缺少麦克风、ASR、Provider、TTS 和实际播放事件，**绝对首音频目标尚未注册，S1-AC04 先记 BLOCKED**；本报告不以合成计时或自动测试冒充声学基线。
3. 确定性安全目标：取消后旧轮不得再播放、追加完整回复、写入记忆或触发后台记忆抽取；新轮可独立完成；重复取消不抛异常。
4. 确定性回合目标：输入事件携带音频结束时间和来源精度；ASR 乱序按音频顺序合并；迟到 ASR 不重新启动完整尾静音等待；单轮无空提交、无重复提交。

## 修复前代码风险登记

- `src/hooks/useVoiceConversation.ts` 的 `onFinal` 会调用 `markVoice()`，以 ASR 返回时刻重置静音起点；当前事件协议没有音频结束时间/来源精度字段。
- `src/services/voice/whisperInput.ts` 为每个 VAD 段并发发起转写，事件没有 `segmentId` 或音频区间，结果可能按网络完成顺序进入缓冲区。
- `src/hooks/useVoiceConversation.ts` 只用 `turnRef` 屏蔽界面回调；`useCompanionSession.send` 仍会在旧请求完成后落库完整 assistant 消息并启动后台记忆工作。
- `src/services/providerClient.ts` 没有向 LLM/TTS/流式读取传递取消信号；当前“取消”主要是忽略 UI 回调，不是请求取消。
- `speechQueue` 已有 generation 防迟到 `onEnd`/chunk 的测试，但 Hook 到会话/持久化边界尚无同等契约测试。

## S1.0 结论

技术基线可复现：前端现有测试与构建通过；Rust/Tauri 构建因工具链缺失阻塞。语音实机基线、首音频绝对目标、真实取消延迟和回声证据均未测量。下一步只实施 S1.1→S1.2，并在 `S1_ACCEPTANCE.md` 中按 AC 逐项区分技术完成与阶段整体验收。
