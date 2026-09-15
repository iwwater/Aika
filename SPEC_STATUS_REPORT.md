> **2026-09-15 状态（最新，读这一行）**：本文件**已被取代，不得作为当前状态依据**。0.5 主线（MVP-01～06）六份 SPEC 已全部执行完毕——收口与遗留清单见 [docs/HANDOFF_MVP_0.5.md](docs/HANDOFF_MVP_0.5.md)，需要用户亲自验的项见 [docs/ACCEPTANCE_PLAN.md](docs/ACCEPTANCE_PLAN.md)。下文多处结论已失效：「3 红」在最新全量回归中不复现（**153 文件 / 1659 项通过、0 失败**）；「LLM-04/05 未开始」不成立（LLM-04 已于 09-13 交付、LLM-05 已 PARTIAL）；「FE-27～30 待实现」不成立（FE-27/28/29 已 SUPERSEDED、FE-30 为部分替代，桌宠改走 PET 线）。
>
> 2026-09-13复核提示：以下是历史执行报告，不是当前回归结论。工作区已有speechOutput契约夹具异步等待修复，三红需定向复核，不能仅凭旧失败归因生产实现。LLM-04编号已澄清，DeepSeek usage有后续真实报告；当前执行依据见[文档审阅](docs/REVIEW_V0.5_AND_BACKLOG.md)。

# Aika SPEC 完成情况与冒烟测试报告（2026-09-13）

> 由鹏城信息AI专家执行。结论基于 6 个模块 SPEC.md 索引、各模块 reports/ 验收报告，以及本次实跑的 `npm run build` 与 `npm test`。

## 一、前后端冒烟测试结果

本项目是 Tauri + React/Vite 桌面应用：**没有独立 HTTP 后端服务**，后端逻辑即随前端打包的 TypeScript runtime（内核/编排/语音/Trace 等）。因此"后端"以 vitest 套件做运行时冒烟，"前端"以 `tsc + vite build` 做编译门禁。

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 前端编译 | `npm run build`（tsc && vite build） | ✅ 通过，EXIT_CODE=0；1971 模块，23.02s 产出 dist/（仅 1 条 vite 动态导入警告，非错误） |
| 运行时冒烟 | `npm test`（vitest run） | ⚠️ 989 passed / **3 failed** / 1 skipped（77 文件，15.54s） |
| 前端 dev server | `npm run dev -- --port 5173` | ❌ 无法在沙箱启动：`EACCES: permission denied 127.0.0.1:5173`（沙箱禁止监听套接字，环境限制，非代码问题） |

### 3 个失败用例（实打实的缺陷）
全部位于 `src/services/voice/speechOutput.conformance.test.ts`，describe 块 **`SpeechOutputEngine contract: cloudTtsOutput`**：
- `conformance.ts:58` `expect(starts).toHaveLength(1)` → 收到 0
- `conformance.ts:100` `expect(fixture.probe.stopCalls()).toBeGreaterThanOrEqual(1)` → 收到 0
- `conformance.ts:121` `expect(starts).toHaveLength(1)` → 收到 0

含义：`cloudTtsOutput` 这个 `SpeechOutputEngine` 实现没有按契约发出 start/end 事件、也没有调用 stop。**这与 SPEC 中"输出用例包由 webSpeechOutput 与 cloudTtsOutput 两实现全绿"的声明直接冲突**——实际上 cloudTtsOutput 契约目前是红的。建议作为 BLOCKED/回归项处理，而非"已自测全绿"。

---

## 二、各模块 SPEC 完成度

### CORE（docs/core/SPEC.md）— 9 个全部"已自测 / 待审阅"
CORE-01～CORE-09 均已完成模块自测并写了验收报告，状态统一为 **待审阅（不新增完成声明）**。
- 均非"未开始"，但都未经过人工评审，严格说不算"做完"。
- 风险点（索引原文）：CORE-03 没通过前"其余 SPEC 不得声称编排已统一"；CORE-06 没执行则本模块不算完成（两路径共存是最坏中间态）。当前 CORE-06 已完成。

### LLM（docs/llm/SPEC.md）
| SPEC | 索引定义 | 状态 | 结论 |
| --- | --- | --- | --- |
| LLM-01 | Soul/三模式/输出协议 | 已自测，待审阅；真实模型质量 NOT RUN | 自测过，待审 |
| LLM-02 | Runtime/Context/取消 | 已自测，待审阅；真实模型+Hook NOT RUN | 自测过，待审 |
| LLM-03 | Memory/User Soul | 已自测，已接存储；真实模型 10/10 命中 | 自测过，待审 |
| **LLM-04** | **单次 Agent / 后台写回** | **索引标"未开始"** | ❌ 原规划未做 |
| **LLM-05** | **Knowledge / RAG** | **索引标"未开始"，无验收报告** | ❌ 未开始 |
| LLM-06～10 | Trace 协议/接入/来源/reply 事件/Provider usage | 已自测，待审阅；真实平台 NOT RUN | 自测过，待审 |

⚠️ **文档不一致**：仓库里存在 `docs/llm/reports/LLM-04_ACCEPTANCE.md`，但其范围是"设置页模型列表拉取与下拉选择"（39 测试通过），与索引定义的"单次 Agent / 后台写回"**不是同一件事**。即索引的 LLM-04 范围未交付，且存在编号重用的歧义，需要把 SPEC.md 与报告对齐。

### TTS（docs/tts/SPEC.md）— 索引无状态列
- TTS-01 分句与队列、TTS-02 停止与交付状态：**索引无状态列**，完成度未记录（CORE-05-G 恢复 cloudTtsOutput 时一并落地，但无显式验收标注）。
- **TTS-03 音频验收：DEFERRED**（需真实声音/设备，本环境不可做）。
- 索引"待下发"还登记了 **2 项未启动工作**（尚未有 SPEC 编号）：
  1. 设置页能选输出链路并填云端配置；`note/degraded` 必须一路送到界面（点名要云端却配置不全时降级要当错误显示）；
  2. 一次真实云 TTS 试听（音质/延迟/计费），当前证据全走假 `HttpFetch`。

### STT（docs/stt/SPEC.md）— 索引无状态列
- STT-01 输入契约与识别适配、STT-02 分段排序与回合提交：**无状态列**，完成度未记录。
- **STT-03 设备与识别验收：DEFERRED**（需真机麦克风）。
- STT-04 识别语言判定不再自锁：**待审阅**（自测过，待评审）。

### Frontend（docs/frontend/SPEC.md）— 索引无状态列，但 WORKBENCH 计划有交付记录
- FE-04～FE-12：已交付（见 `docs/PLAN_DEV_DEBUG_WORKBENCH.md` 与对应验收报告），覆盖双语去重、失败重试、撤回/重生成、Rewind、点击朗读、Trace/能力视图/数据流图、记忆管理页、存储浏览页。
- FE-13 语音页露出识别语言并允许改掉：**待审阅**。
- FE-01/02/03（Runtime 桥接与消息状态、模式场景设置、语音状态与字幕）：**索引与 reports/ 均无状态/报告**，完成状态未核实（疑似早期随 Core 重构完成但缺正式验收记录）。

### Integration（docs/integration/SPEC.md）
| 阶段 | 状态 |
| --- | --- |
| INT-01 文本与接口 | **NOT RUN**（core 多次登记"兼容增量待执行"，无真实模型/产品构建） |
| INT-02 语音联动 | **DEFERRED**（需真人语音验收） |
| INT-03 发布门禁 | **NOT RUN**（未执行全量 npm test + cargo test + tauri build） |

> 文档原文多次强调："本次没有启动真实模型、音频设备或 Tauri 产品构建""以上集成检查均为 NOT RUN"。

---

## 三、结论：还有哪些 SPEC 没做完

### 🔴 明确未开始 / 未交付
1. **LLM-04（原规划：单次 Agent / 后台写回）** — 索引标未开始；现存的 LLM-04 验收报告是另一个范围（模型列表下拉），原规划缺口未补。
2. **LLM-05（Knowledge / RAG）** — 未开始，无验收报告。
3. **TTS-03（音频验收）** — DEFERRED，需真实声音/设备。
4. **STT-03（设备与识别验收）** — DEFERRED，需真机麦克风。
5. **超出已编号 SPEC 的未启动工作**：TTS 待下发 2 项（输出链路选择 UI + 降级当错误显示、真实云 TTS 试听）；调试工作台 **F9 Ops 成本页**（无 SPEC 编号，依赖 LLM-10 数据，未开始）。

### 🟡 自测完成、但"待审阅"= 不算正式做完（需人工评审）
- CORE-01～09、LLM-01～03、LLM-06～10、STT-04、FE-13（共约 19 个）。

### 🟠 完成状态未记录（索引/报告缺状态）
- TTS-01/02、STT-01/02、FE-01/02/03（建议补状态列与验收报告，避免"做没做说不清"）。

### 🔧 实测暴露的回归/缺陷（与"已自测全绿"声明冲突）
- `cloudTtsOutput` 的 `SpeechOutputEngine` 契约 3 个用例失败（见第一节）。建议把 CORE-05"输出用例包全绿"的结论修正为"webSpeechOutput 绿、cloudTtsOutput 红"，并补修 cloudTtsOutput。

### ⚪ 集成层全部 NOT RUN
- INT-01 / INT-02 / INT-03 均未执行——任何"模块通过"都不能替代"全流程/真机"验收，发布前必须走 INT-03（全量 npm test + cargo test + tauri build + 安装启动回归）。

---

## 四、下一步建议（按优先级）
1. **修 cloudTtsOutput 契约失败**（3 红），让输出用例包真正全绿。
2. **对齐 LLM-04 文档**：明确"单次 Agent / 后台写回"是否仍要做，并修订 SPEC.md 与验收报告的范围歧义。
3. **补状态记录**：给 TTS-01/02、STT-01/02、FE-01/02/03 补状态列/验收报告。
4. **推进未启动 SPEC**：LLM-05（RAG）、TTS 待下发 2 项、F9 Ops 成本页。
5. **排期 INT-01/03**：在真机/真实 Provider 可用时做集成与发布门禁。
