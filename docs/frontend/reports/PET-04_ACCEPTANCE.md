# PET-04 验收报告 · 事件/情绪映射与有界发送器

> 2026-09-14 · 需求 DPI-04 · [SPEC](../specs/PET-04.md) · 契约 [§4/§5](../DESKTOP_PET_CONTRACT.md)
> 前置：PET-02（契约与 Service）。本 SPEC 用 fake adapter / 假 Runtime / 假时钟独立完成，不依赖真实桌宠。

## 1. 改动

新增：

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/desktopPet/eventMapping.ts` | 展示语义映射（纯函数）：thinking / 最终回复复合任务 / 终态 / 受控显式入口 |
| `aika-crossplatform/src/services/desktopPet/commandBuffer.ts` | 有界串行发送器：1 在途 + 16 待发、同轮中间态合并、终态清理、去重缓存、期限与代次校验 |
| `aika-crossplatform/src/presentation/desktopPetPresenter.ts` | 展示桥接：Runtime 公开展示事件 → 命令；状态订阅；测试连接；受控显式入口；手动演示 |
| `aika-crossplatform/src/presentation/desktopPetPresenter.test.ts` | PET-04-A～G 定向测试（17 项） |

修改（定向增量）：

| 文件 | 改动 |
| --- | --- |
| `aika-crossplatform/src/services/desktopPet/fakeDesktopPet.ts` | 假 adapter 支持「按命令类型分别设定结果」（验证 action 失败仍 say） |
| `aika-crossplatform/src/services/desktopPet/desktopPetService.test.ts` | PET-02-E 的静态扫描改为先剥块注释再判（与 `kernel/architecture.test.ts` 同一口径，避免中文注释里的模块名误伤） |

未改：LLM prompt、Memory、Emotion 算法、感知源、TTS 引擎、任何 Runtime/Provider 实现。

## 2. 实际字段 → 语义 → 桌宠命令

执行时对 `services/runtime/companionRuntime.ts` 与 `domain/companion.ts` 的真实定义逐条核对：

| Runtime 实际字段 | 展示语义 | 桌宠命令 |
| --- | --- | --- |
| `type:"state"` + `state:"generating"`（`TurnState` 有 `assembling/generating/awaitingDelivery/completed/cancelled/failed`） | 当前轮开始生成 | `event(thinking, "让我想一下……")` |
| `type:"generated"` + `reply.replyText` | 最终回复 | `say(replyText)`（一轮一次） |
| `reply.motion` / `reply.expression`（`ReplyEnvelopeV1` 可选字段） | 显式动作 | `action(<已验证动画名>)` |
| `reply.mood`（`Mood` 七值枚举） | 情绪 | `emotion(<mood>)`，**仅当 profile 已映射** |
| `type:"settled"` + `state:"completed"` 且本轮无文本 | 无文本任务成功 | `event(success)` |
| `type:"settled"` + `state:"failed"` 且本轮无文本 | 无文本任务失败 | `event(failure)`（不带 errorCode/堆栈） |
| `type:"replyDelta"`（`text`/`cumulative`） | 流式增量 | **不发命令** |
| `type:"error"`（`code`/`retryable`） | 流式错误 | **不发命令**（终态由 `settled` 表达，避免双发） |
| 取消 / 换轮 | 本地撤销 | 不发上游事件，不虚构 `cancelled`/`idle` |

**工具与审阅没有真实公开事件。** `TurnState` 里不存在工具/审阅语义，`ReplyEnvelopeV1` 的 `actions` 只有 `sticker` 一种类型。因此这两条走**受控显式入口** `presenter.notifyActivity("tool-running" | "reviewing")`，绝不根据回复文本去猜。

## 3. 命令与退出码

```text
npx vitest run src/services/desktopPet src/presentation/desktopPetPresenter.test.ts \
    src/kernel/architecture.test.ts src/app/runtimeFacade.test.ts
→ Test Files 5 passed (5) / Tests 91 passed (91) / exit 0
  （PET-02 23 + PET-03 21 + PET-04 17 + 内核门禁 28 + RT-01 facade 门禁 2）
```

只跑本模块与受影响的两条架构门禁，未启动麦克风、OCR、真实 Provider。

## 4. 逐 AC 证据

| AC | 结论 | 证据 |
| --- | --- | --- |
| PET-04-A | **PASS** | 开始（连发两次）+ 3 条 delta + generated + settled：`thinking` 事件恰好 1 个、`say` 恰好 1 条（内容为最终 `replyText`）、`emotion` 恰好 1 次（`happy`）；delta 不产生气泡；有文本的轮次不补 `success` |
| PET-04-B | **PASS** | `emotions: {}` 时 `happy` 只 say，`emotion`/`action` 调用均为 0，且没有任何 `event` 的 type 是 `happy`；`emotions:{happy:…}` 时发的是 `emotion("happy")`（经 adapter 变成已验证 `animationId`）；`motion` 与 `mood` 同时存在时只发 `action("wave")`（显式优先） |
| PET-04-C | **PASS** | A 轮 `generating` → B 轮 `generating` → A 轮迟到的 `generated` 与 `settled`：`say` 调用为 **0**；B 轮正常产出；随后 `demo("演示一下")` 仍返回 `accepted`（无 turn 演示不受轮次作废影响）；`settled: cancelled` 不产生任何 `cancelled` 事件 |
| PET-04-D | **PASS** | 1000 条同轮突发：`inFlightCount()===1`、`pendingCount()===1`、`merged===998`；不同后缀的中间态也只留一个；再入队 17 条终态命令：前 16 条 accepted、第 17 条 `{outcome:"skipped",code:"overloaded"}`、`dropped===1`；`completeTurn` 清掉同轮中间态（`cleaned===1`）；释放后共发送 17 条 |
| PET-04-E | **PASS** | `unknown` 结果只发送 1 次（无补发）；过期命令 `expired===1` 且零发送；禁用状态 `stale` 且零发送；代次变化（`generation` 1→2）零发送；去重缓存上限 4 时最旧的键被挤出并可重新入队（`deduped===1`）；空闲后推进假时钟 60s 与新探测周期，总调用数不变（不重播） |
| PET-04-F | **PASS** | action 返回 `failed/http_error` 时 `say` 仍然发出（内容正确）；有正文的轮次 `success` 事件数为 0；表现失败不改变 `service.snapshot().connection`（仍为 `ready`）；TTL/期限判定全部由假时钟驱动，无真实等待 |
| PET-04-G | **PASS** | `generated` 里塞入 `translation` 哨兵与 `memoryCandidates`：出站 `say` 只有可见正文，`JSON.stringify(出站调用)`、诊断事件、buffer 诊断、presenter 快照**均不含**哨兵；`error.code` 也未出现在出站内容里；桥接 `dispose()` 只解绑订阅，用户的桌宠仍处于启用状态 |

## 5. 语义边界（写清以免被误读）

- 入队返回的 `accepted` 只表示**已入队**，不是已发送、更不是已播放。
- 去重命中返回 `{outcome:"skipped"}` 且**不带 code**：重复不是失败原因，诊断计数（`deduped`）才是它该待的地方。
- 旧轮作废靠两道闸：清掉待发 + 记录已作废轮次（挡住**迟到**的 `generated`/`settled`）。
- 取消不承诺撤回：在途的那一个可能已到上游，本地只保证不再使用其结果、不再补发。
- 手动演示直接走 Service（不排队、不附假 `turnId`），因为它一次只有一条且用户在等。
- 桥接不持有、也不释放 Service——所有权在装配层。

## 6. 共享契约影响

未新增共享类型（沿用 `desktopPet.integration.v1`）。`presentation/desktopPetPresenter.ts` 刻意**不 import** `services/runtime/companionRuntime`：

- 单 Runtime facade 门禁（RT-01-B）不允许，白名单里没有展示层；
- 它声明了一份**结构更窄**的 `DesktopPetRuntimeEvent`，宿主装配时把真实 Runtime 的 `subscribe` 直接传入即可（结构化类型兼容）。

`DesktopPetPresenterToken` 尚未注册（属 PET-06 装配）。

## 7. 遗留项

| 项 | 归属 | 状态 |
| --- | --- | --- |
| 进程端口、所有权、managed 启动 | PET-05 | 未实现（Service 只调用注入端口） |
| 生产装配、设置页、旧桌宠入口迁移、token 注册 | PET-06 | 未实现 |
| 真实 Windows 表现、TTL 消退与已受理 action 的持续行为 | PET-07 | NOT RUN |
| `tool-running`/`reviewing` 依赖真实公开事件；当前只有受控入口 | 后续 | 显式差距，不以文本猜测补齐 |
| 上游点击回传（tap）缺失，陪伴菜单仍在主窗 | PET-06/FE-31 | 已知差距，PET-06 记录 |
