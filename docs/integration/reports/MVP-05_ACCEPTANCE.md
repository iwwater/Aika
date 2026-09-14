# MVP-05 验收 · 模块隔离矩阵

2026-09-14。依据 [RPD](../../RPD_MVP_0.5.md) MVP-R05、[SPEC](../specs/MVP-05.md)。前置 MVP-02～04 已收口。

## 结论

| AC | 状态 | 一句话 |
| --- | --- | --- |
| A | **PASS** | 全开 / Pet OFF / OCR OFF / Memory OFF 四行：该工作的在工作，关掉的是真的关了，缺能力仍能回答 |
| B | **PASS** | Pet 错误 / OCR 错误 / RAG 拒绝三行互不传播；recent context 保留；注入的错误原文一句都没进 prompt |
| C | **PASS** | 可选能力控制器与桌宠集成各 20 轮启停：订阅/请求零泄漏，旧 generation 不复活 |
| D | **PASS（device）** | 真实 OpenPet 进程被杀 → Aiki 存活；端点恢复 → 10 秒周期探测立即恢复（重连取证）。native 同进程崩溃隔离按 SPEC 不在承诺内 |
| E | **PASS** | 新增「四个可选模块互不 import 对方实现」静态门禁 + 调度器共享装配门禁；既有 architecture/CORE-05 门禁复跑通过 |

## 1. 矩阵用例（`src/app/mvp05IsolationMatrix.test.ts`，11 项）

规矩：**端口 fake，核心生产**。真正在跑的是生产 `screenSource`（词表在它内部）、`monitor`、`environmentTrigger` + `ruleProactivePolicy`、`CompanionRuntime`、`DesktopPetService`+`Presenter`、`MemoryRepository`+`MemorySource`、`KnowledgeIndex`+`KnowledgeContextSource`；fake 的只有外部世界（屏幕采集、OCR 引擎、LLM Provider、桌宠进程）。

每行记录：模型调用数、观察（主动轮）次数、桌宠 say/emotion 调用数、长期读次数、是否回答、注入错误是否外泄。

| RPD 行 | 用例 | 关键断言 |
| --- | --- | --- |
| ON/ON/ON | 全开 | 回答 ✓、观察 ≥1、桌宠 say/emotion ≥1、记忆读取 ≥1 |
| OFF/ON/ON | Pet OFF | 回答 ✓、观察 ≥1、桌宠**零**调用 |
| ON/OFF/ON | OCR OFF | 回答 ✓、观察 **0**、桌宠仍被用户那一轮驱动（1 次） |
| ON/ON/OFF | Memory OFF | 回答 ✓、长期读 **0**、观察与表现不受影响 |
| Pet 错误 | adapter 每条命令都 `failed` | 回答 ✓、Aiki 侧 `diagnostics.failed ≥1`、不上抛 |
| OCR 错误 | 引擎按契约返回 null | 回答 ✓、观察降级为 0、桌宠与对话继续 |
| RAG 拒绝 | 知识库查询抛错（带哨兵串） | 回答 ✓、**哨兵串不出现在 prompt**、记忆源照常被读 |

测试命令与结果：`npx vitest run src/app/mvp05IsolationMatrix.test.ts` → **11 passed / exit 0**。

## 2. AC-C 连续启停 20 次

- **可选能力控制器**（MVP-01 `createOptionalCapability`）：20 轮 `start/stop`，每次恰好一次 cleanup（订阅零泄漏），每轮终态 `off`，generation 单调递增；**迟到的启动**（stop 已撤销 generation 之后才 resolve）不得把能力复活成 `running`。
- **桌宠集成**：20 次 `enable/disable`，每次 enable 恰好一次探测（`probesPerEnable` 全为 1）——没有「关了还在探测」也没有「开一次探多次」；期间零 say/emotion。

## 3. AC-D 真实进程退出与重连（device）

本机实测（debug 宿主 `--features custom-protocol`，桌宠集成按用户配置启用）：

1. OpenPet（`%LOCALAPPDATA%\OpenPet\openpet.exe`，pid 45844）与 Aiki（pid 45128）同时运行。
2. **强杀真实 OpenPet 进程** → 12 秒后 Aiki 仍存活（`aiki-still-alive=True`）。
3. 端口恢复后（同一 `127.0.0.1:17321`、同一协议的记录替身），Aiki 在 10 秒周期上**恢复探测**：`23:07:00 → 23:08:10` 连续 8 次 `GET /api/status`（间隔 10.0s），即重连成功。取证脚本 `aika-crossplatform/tmp/probe_listener.py`（未入库，gitignored）。

如实标注：步骤 3 的响应方是协议等价的记录替身而非 OpenPet 本体——「进程退出后 Aiki 存活」用的是**真实 OpenPet 进程**，「重连」的观察点是替身的请求日志（OpenPet 自身不提供请求计数）。native 同进程崩溃隔离按 SPEC 原文不在承诺内。「OCR worker 失败不影响桌宠」由矩阵的 OCR 错误行覆盖（fixture 轨）。

## 4. AC-E 静态门禁

- **新增**（本 SPEC）：`services/{environment,desktopPet,memory,knowledge}` 四个可选模块的实现**互不 import 对方模块**（`import type` 除外——类型依赖不产生运行时耦合，knowledge 复用 memory 的 `SqlExecutor` 类型属此类）。RPD 原文的「OCR 不直接 import 桌宠；Memory 不 import 两者的实现」从此有自动化守卫。
- **新增**：宿主装配必须把同一份采集调度器传给词表轨（`createScreenSource`）与 `environmentHostPlugin`——见 §5。
- **复跑通过**：`kernel/architecture.test.ts`（内核边界 / CORE-03~06 门禁）、`app/ports.swapMatrix.test.ts`（CORE-07 替换矩阵）、`app/capabilityPlugins.test.ts`、`app/hosts/hostAssembly.test.ts`（生产宿主装配门禁）。

## 5. 本轮修掉的契约违背：OCR 额度「名义共享、实际两份」

`contracts.ts` 与 `screenSource.ts` 都写明词表轨与全文轨**共用同一份每分钟 10 次**，但宿主装配构造 `createScreenSource` 时没传 `scheduler`，于是两轨各建一份调度器，最坏 20 次/分钟——MVP-04 报告 §4 已登记。

本轮在 MVP-05 的「生产装配」范围内修掉：`environmentHostPlugin` 支持注入 `scheduler`，`app/hosts/index.ts` 建一次并同时注入两处；并加了上面那条装配门禁，防止「契约写了共享、实现各算一份」再次悄悄出现。

## 6. 测试与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/app/mvp05IsolationMatrix.test.ts` | 11 passed；exit 0 |
| `npx vitest run src/services/environment src/presentation src/app src/domain src/kernel` | **82 files / 960 passed / 1 skipped；exit 0** |
| `npx tsc --noEmit` | exit 0 |

共享接口影响：`EnvironmentHostPluginOptions.scheduler?` 可选新增（不传=插件自建，既有测试不变）；`hosts/index.ts` 装配处多建一个调度器实例并注入两处。无跨模块公共契约变化。
