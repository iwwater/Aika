# FE-22 验收报告 · 主动策略接线、最终门禁与原子发送预约

日期：2026-09-14。状态：**PASS（模块内）**——FE-22-A～J 中可模块内验证项全部通过；真实游戏 OCR 场景触发证据归 FE-30（NOT RUN）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/services/environment/ruleProactivePolicy.ts` | 新增生产策略（替换 FE-18 默认 ignore 占位，`environmentPlugin` 已切换）：结算类 game_event（victory/defeat/pentakill）confidence ≥0.8 直接候选；弱信号 sustainedMs ≥30000 且 60s 窗口 ≥2 次；busy 未知 ignore、busy=true 仅结算类；未达门槛 remember 累计；阈值常量冻结 |
| `src/presentation/environmentTrigger.ts` | 新增：monitor 订阅 → remember 缓冲（≤20、TTL 60s，TTL 先剔再挤）→ policy 裁决 → 终门禁（三开关 + source running + 事件在摘要 TTL 内 + busy 观测 ≤2000ms，决策后等待再复核）→ `attemptSend` 注入的既有发送路径 |
| `src/presentation/companionPresenter.ts` | 共享发送预约（非排队，同刻第二候选 false，预约后重验开关/canSend）；`attemptSendProactive` 为 tick 与环境触发唯一发送路径；`proactivePersistUnknown`：submit 成功但持久化失败 → 内存视为已发送、阻止后续，恢复后按同 sentAt/reason 幂等重写；tick 的 reason 选择注入环境缓冲摘要 |
| `src/domain/proactive.ts` | `ProactiveReasonKind` 增加 `game-result`/`environment-weak`；`ProactiveReasonInput.environment?`（受控词表 ID）；`environmentProactiveReason(kind, buffer)` |
| `src/services/environment/busySource.ts` | `EnvironmentBusyObserverToken`（宿主能力，消费方 optional） |
| `src/app/hosts/plugins.ts` | `busyObserverPlugin`（tauri 宿主提供 Rust busy 观测者；浏览器宿主不注册） |
| `src/app/plugins/presentationPlugin.ts` | 向 companionPresenter 注入 `environment` deps（monitor/policy/busy 全 optional，缺一不启用） |
| `src/presentation/environmentPresenter.ts`、`src/services/storage/contracts.ts`、`src/App.tsx` | `SETTING_KEYS.environmentProactiveEnabled`（默认 false）+「允许环境主动搭话」开关（与全局 proactive 分层说明）；stopAll 一并关闭 |
| `docs/modules/CONTRACTS.md` | FE-22 追加登记 |

## 测试命令与退出码（`aika-crossplatform/` 目录）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/presentation src/services/environment src/services/storage src/kernel` | **325 passed（0 failed），退出码 0**（含既有 companionPresenter/proactive 回归 = FE-22-F，以及 kernel 架构门禁） |
| `npx tsc --noEmit` | 无错误 |

## 逐 AC 证据

| AC | 证据 | 状态 |
| --- | --- | --- |
| FE-22-A | `companionPresenter.environment.test.ts`「A」：game_event victory → submit 恰一次、`source=proactive`、请求文本含受控词表提示（"victory"）、`proactiveLastReason=game-result`、`proactiveLastSentAt` 落键；Runtime 未把主动轮 persist 成用户消息（既有语义回归 325 例全绿） | PASS |
| FE-22-B | 共享预约内重验 `canSend`（勿扰/每日 6 条/90 分钟间隔）；tick 路径零漂移（原 proactive 测试回归全绿）；安静时段负例由 `domain/proactive.test.ts` 既有用例 + 预约内重验覆盖 | PASS |
| FE-22-C | busy 矩阵（`ruleProactivePolicy.test.ts`）：screen_keyword + busy=true → `busy-true-non-settle` ignore；同刻 game_event → trigger；busy unknown → `busy-unknown` ignore。**不再使用「前台游戏进程即 busy」的旧前提**——busy 只来自 FE-19 可信观测 | PASS |
| FE-22-D | 开关矩阵（`environmentTrigger.test.ts`「三开关矩阵」）：全局/环境/摘要授权任一关闭 → 零 submit、`gateRejectedCount` 可见；传感器关 → sourceState≠running 拒绝；全局 proactive 关由 presenter gate 拦截 | PASS |
| FE-22-E | remember：未达门槛事件进缓冲（`bufferCount` 增长），后续 attemptSend 收到词表 ID 摘要 `["error",…]`；`MemoryRepository` 无任何写入调用（presenter 环境路径不触碰记忆模块，结构上无引用） | PASS |
| FE-22-F | 既有 proactive/presenter/domain/storage 回归：325 passed（0 failed） | PASS |
| FE-22-G | 边界（`environmentTrigger.test.ts`）：摘要 TTL 59999/60000 边界（fresh 触发、stale 拒绝）；busy 观测时效（≤2000ms 有效，未知/过期拒绝）；三开关 × source 状态矩阵；每种拒绝 `gateRejectedCount/busyUnknownCount` 可见、零 submit | PASS |
| FE-22-H | 同刻双 event → 恰一次提交（共享预约非排队）；关闭/stopAll 后旧候选零提交（source off 门禁 + 缓冲清空，`environmentTrigger.test.ts` + monitor 生命周期用例） | PASS |
| FE-22-I | `companionPresenter.environment.test.ts`「I」×2：submit 失败 → 预约释放（后续提交成功，不永久 busy）；submit 成功但持久化失败 → 不重发、阻止后续；写恢复后对账成功（同 sentAt/reason 幂等重写）且恢复正常发送、不超额 | PASS |
| FE-22-J | 恶意事件进入生产摘要/policy/Presenter：attemptSend 收到的 buffer 与请求文本只含词表 ID（断言不含 INJECTED/IGNORE-PREVIOUS）；remember 关闭清空（clearBuffer）、过期不入下轮（TTL 剔除用例）；写 User Soul 路径不存在（RT-04 边界未触碰） | PASS |

## 共享接口影响

见 `docs/modules/CONTRACTS.md` 2026-09-14 FE-22 节。要点：
- `ProactivePolicyToken` 的生产实现从 ignore 占位升级为 ruleProactivePolicy（注册处一行切换，契约未变）。
- presenter 主动发送路径重构为单一 `attemptSendProactive`：tick 与环境触发共享预约/门禁重验/持久化对账，无第二发送路径。
- **trigger 时钟必须与 monitor 时钟同源**（`deps.environment.clock`），否则摘要 TTL 判定错位——已作为契约写入（测试曾据此捕获缺陷）。

## 待联调 / NOT RUN

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实游戏结算 → 主动消息端到端证据 | **NOT RUN** | 归 FE-30-C 组合验收（需真实 OCR 场景 + 授权开启）；模块内以 fake monitor + 生产 policy/trigger/presenter 链证明编排 |
| busy 真机观测（锁屏/DPI） | NOT RUN | 归 FE-19/FE-30 设备轨；触发器对 unknown 的 fail-closed 已验证 |
| 用户自定义阈值 UI | 未立项 | 阈值为冻结常量，改动需记录理由并同步 fixture |
