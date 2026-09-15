# 前端 SPEC Handoff · 三维度交接清单

日期：2026-09-14（**FE-31/32 执行后更新**；2026-09-15 加注，与 [HANDOFF_MVP_0.5.md](../HANDOFF_MVP_0.5.md) 对齐）。范围：`docs/frontend/specs/` 全部 32 份 SPEC（FE-01～32）及其验收报告。源码根 `aika-crossplatform/`。
> **2026-09-15 注（两条）**：
> 1. MVP-03 已删除 Legacy Pet（`src/pet/`、`usePetWindow.ts`、`petWindow.rs` 等），本文件中涉及旧自研桌宠窗口的待办已随之失效；MVP 0.5 六份 SPEC 的收口状态与遗留清单见 [HANDOFF_MVP_0.5.md](../HANDOFF_MVP_0.5.md)。
> 2. FE-33 仍**未做自身真机复验**；09-15 的 MVP-04-D 只覆盖了环境链路的一段（真实 OCR → 真实 Provider → 桌宠受理），不能替代 FE-33 的逐 AC 复验（见 [frontend/SPEC.md](SPEC.md) 的 FE-33 行）。
用途：任何接手者（人或 worker）据此确定「还有什么没做、什么需要真实服务、什么需要人」。

## 当前快照

- FE-01～13：状态层/自动 AC 已过（REVIEWED_AUTO 或已补证），遗留项集中在人工目视与真实对话证据。
- FE-14（协议内核）、FE-23～26（工作台/成本页）：AUTO_PASS，遗留目视与真实数据。
- FE-15/16/17（远程输出线）：PARTIAL——本地与 Rust 单元侧完成，真实宿主/公网项未验。（FE-16 索引行已于本轮同步为 PARTIAL。）
- FE-18～22（环境感知线，本轮 2026-09-14 完成）：模块内/逻辑轨 PASS，真机与组合项 NOT RUN（详见下）。
- **FE-31/32：本轮已实现，状态 PARTIAL**——会话控制、意图协议、摘录投影与调度限流的生产逻辑全过（定向测试 + Rust 单元），但没有任何真实读屏、真实回复或真机演示；中文识别所缺的 `chi_sim.traineddata` 不在仓库。详见 [FE-31](reports/FE-31_ACCEPTANCE.md) / [FE-32](reports/FE-32_ACCEPTANCE.md) 验收报告。
- FE-20 / FE-27 / FE-28 / FE-29：**已 SUPERSEDED（09-14 桌宠新路线）**，不再按原顺序派发；Live2D 条件接入归 [PET-08](specs/PET-08.md)（DEFERRED，0.6，**需用户先做路线选择**）。**FE-30 为部分替代**：0.5 桌宠表现按 PET-07 验收，环境、授权、OCR 与陪伴业务项及 A～I + J～N 继续保留。
- **环境线装配断点已修**：此前 FE-18～22 的 PASS 全是「模块内」——生产装配里 `environmentPlugin` 从未被装、两个 source 无调用方、busy 观测者无提供方、FE-19 上下文源没进 `contextSourcesPlugin`、`ScreenState` 没 `.manage()`。本轮在 FE-31 文件范围内补齐，但**新装配从未在真实 Tauri 进程里跑过**。
- 仓库有大量未提交改动（FE-18～22 实现 + FE-31/32 规格新增 + 索引/PRD 更新）；按仓库规则不由 worker 自行提交。

---

## 一、待办 SPEC（2026-09-15 复核：FE-27/28/29 已 SUPERSEDED、FE-30 部分替代）

| SPEC | 交付 | 依赖 | 状态与关键约束 |
| --- | --- | --- | --- |
| [FE-27](specs/FE-27.md) | Live2D 素材/运行时核实、manifest 校验、表现契约（character.presentation.v1） | 无 | **SUPERSEDED（09-14 桌宠新路线）**——不建自有 manifest/renderer 体系，映射 profile 归 PET-01/02（已交付）。历史约束保留：素材与 SDK 条款须核实登记；无合法包时 FE-27-C 记 BLOCKED，不得整份标 PASS |
| [FE-28](specs/FE-28.md) | 真实 Live2D 渲染、表情动作、失败回退 | FE-27；pet 集成需 FE-20 | **SUPERSEDED**——Live2D 条件接入归 [PET-08](specs/PET-08.md)（DEFERRED，0.6，需用户先选路线）。历史约束：真实 WebGL 截图/视频留证；缺包 B/E BLOCKED |
| [FE-29](specs/FE-29.md) | 实际播放能量、口型、打断同步 | FE-27；真实 pet 口型需 FE-20/28 | **SUPERSEDED**——0.5 不实现桌宠口型，TTS 仍由 Aiki 播放。历史约束：口型偏差 ≤150ms/打断 ≤300ms 需外录音画 |
| [FE-30](specs/FE-30.md) | 组合链路、权限、性能与设备验收（A～I + **新增 J～N**） | FE-18～22、31、32 的生产实现 | **部分替代，未执行**——0.5 桌宠表现按 PET-07 验收，自研窗口/Live2D 组合项不作其门禁；环境、授权、OCR 与陪伴业务项继续保留，**A～I + J～N 不得省略**；30 分钟组合负载 + 安装包离线资源验证 |

| [FE-33](specs/FE-33.md) | 环境链路真机装配验收（不含 Live2D） | FE-18～22/31/32 已实现且装配已接通 | **下一个该做的**；只验「新接上的生产装配在真机上是否真的通」，收口 FE-19/20/21/22/31/32 的设备遗留项；需真机 + 用户在场 + 一份 Provider 凭据；**不替代 FE-30** |

执行顺序建议（09-15 修订）：**先做 [FE-33](specs/FE-33.md)**（不依赖任何素材，只需一次真机 + 用户在场），收口 FE-19/20/21/22/31/32 的设备遗留项。**角色线不再是 FE-27→28→29**——先做「是否走 0.6 NyaDeskPet/Live2D」的路线决策，再决定是否启动 [PET-08](specs/PET-08.md)。最后 FE-30 收口（A～I + J～N），具体条目见 `specs/FE-30.md` 场景矩阵。

另有两件小待办（非 SPEC 主体）：
- ~~`SPEC.md` 索引 FE-16 行状态过期~~ —— 本轮已同步为 PARTIAL。
- FE-04 报告识别出「error 气泡重试按钮」需新增 storage 删除消息端口 + 双适配器实现，属未立项的独立 SPEC。

### FE-31/32 执行后新增的阻塞项（需要用户决定）

| 项 | 影响 | 需要什么 |
| --- | --- | --- |
| ~~`node_modules` 缺 `tesseract.js` / `ws`~~ | 已解决：`npm install` 后全量 1533 passed / 0 failed、`tsc` 0 错误，FE-21-F 冻结集评估恢复可复现（P=1.00/R=1.00/热 P95=85ms） | — |
| ~~`chi_sim.traineddata` 不在仓库~~ | 已解决：随包登记 tessdata_fast 4.1.0（Apache-2.0），`public/tessdata/` 与 `fixtures/` 各一份，哈希登记在 THIRD_PARTY_NOTICES.md 并由 `ocrText.test.ts` 核对；生产装配改为 `eng+chi_sim`，生产代码路径实测中文/混排识别正确（置信度 0.94 左右） | — |
| **FE-32-A 要求的 60 张非私人真实画面与人工转录** | 中英文识别**质量（CER）**仍没有任何证据。第二轮那 3 张是本机渲染的冒烟图（用了不可再分发的系统字体、未入库），**不能当冻结集** | 用户提供素材，或授权一种采集方式 |
| **真机跑一次** | 新接进生产装配的环境链路 + FE-31/32 的真机 AC 全部待验 | 一次真实桌面启动（见下表「本轮新增」） |

---

## 二、待真实 API / 服务验收（需要真实 Provider、真实宿主进程、真实传输）

| 归属 | 待验项 | 证据来源 |
| --- | --- | --- |
| 真实对话（一次性点亮多项） | 一轮真实对话同时补齐：Trace 页真实事件、能力调用视图、数据流图 F6②、F1 六项消息交互（重试/撤回/重新生成/朗读/Rewind/双语去重）——目前均只有空态/状态层证据 | [UI_SMOKE_BROWSER.md](reports/UI_SMOKE_BROWSER.md) |
| Provider 协议覆盖 | openai-responses / anthropic / gemini 三种协议的 usage 解析仍只有 fixture 证据（openai-compatible 已真实验过 3 轮） | [REAL_TURN_VERIFICATION.md](reports/REAL_TURN_VERIFICATION.md) |
| FE-15（Tauri 传输） | 真实 Tauri 进程 HTTP 端到端（B/C 的真实并发压力）；手机真机（iOS/Android Safari/Chrome）长轮询/中文输入目视；多 WebView 越权（第二 WebView 调 `outbound_publish` 被拒） | [FE-15_ACCEPTANCE.md](reports/FE-15_ACCEPTANCE.md) |
| FE-16（dev-relay） | ① 超限/慢消费者真实连接负例（可自动补，建议 3 条）；② 宿主装配接线：浏览器宿主如何拿 relayUrl+ticket 并装进 outboundPlugin（需 producer 进程 + ticket 签发通路，接近 headless harness 部署）；③ Tauri 侧手机页经 relay 的配对/重连 | [FE-16_ACCEPTANCE.md](reports/FE-16_ACCEPTANCE.md) |
| FE-17（网关收口） | 真实 Tauri 进程端到端（`remote_start` 真监听、手机页真取帧/发命令）；命令下行真实进程复测（手机页/CDP → Runtime.submit）；`exposurePolicy`/`credentials` 接入 Rust HTTP 认证链路（另立范围）；**public 层 BLOCKED**：真实 TLS 入口/反代来源白名单需实际部署 | [FE-17_ACCEPTANCE.md](reports/FE-17_ACCEPTANCE.md) |
| FE-21（OCR 资源） | webview 内 tesseract worker/wasm 打包 + 安装包离线资源验证（`langPath=/tessdata` 已就位，归 FE-30 构建验证） | [FE-21_ACCEPTANCE.md](reports/FE-21_ACCEPTANCE.md) |
| FE-22（环境主动） | 真实游戏 OCR 场景 → policy → Runtime 端到端触发证据（归 FE-30-C） | [FE-22_ACCEPTANCE.md](reports/FE-22_ACCEPTANCE.md) |
| FE-26（成本页） | 真实费用：真实 Provider 凭据与官方账单比对（页内金额目前一律标「估算/非官方账单」） | [FE-26_ACCEPTANCE.md](reports/FE-26_ACCEPTANCE.md) |
| 语音链路 | 语音链路真实端到端验证（当前只有浏览器观察 1 条，属 STT/TTS 模块协同） | [REAL_TURN_VERIFICATION.md](reports/REAL_TURN_VERIFICATION.md) |

---

## 三、待人工验收（UI 目视、设备/真机、真人操作）

### 3.1 既有页面（INT-01 人工队列）

| 归属 | 待验项 |
| --- | --- |
| FE-01 | 页面视觉证据（当前仅 hook/presenter 状态层） |
| FE-02 | AC-C：键盘可访问 + 窄屏布局 |
| FE-03 | 浏览器操作记录与截图；真实麦克风/TTS 声学（STT-03/TTS-03 DEFERRED） |
| FE-04～08、11、12 | 真实模型对话下的界面目视确认 |
| FE-09/10 | Trace 页/能力页/数据流图真机目视（SVG 观感、横向滚动） |
| FE-13 | 真人发音与真机麦克风；桌面 Tauri WebView2 的 Web Speech 可用性；桌面鼠标复验；20 秒延迟根因（光标修复≠延迟修复） |
| FE-23/24/25 | 拖拽/键盘关闭/窄窗胶囊/浮层/滚动并行目视 |
| FE-26 | UI 目视（页签布局、表单交互、空态文案） |
| 通用 | 桌面真机（Tauri + SQLite/`plugin-sql`）全量走查（浏览器降级实现验过，桌面侧 SQL 一行未跑）；生产构建下 `import.meta.env.DEV` 取值 |

### 3.2 本轮 FE-18～22 遗留设备项（需用户配合）

| SPEC | 待验项 | 前置条件 |
| --- | --- | --- |
| FE-19 | VSCode↔浏览器↔游戏切换延迟 <1s 与进程名正确；连续开关 20 次无泄漏；锁屏与 150% DPI 下 busy 观测 | 用户开启「前台应用感知」开关 |
| FE-20 | 真实透明/无边框/置顶/任务栏属性；拖拽、右键菜单、点击穿透实测；独占全屏游戏置顶表现（如实记录差异）；移出屏幕/改布局后从主窗找回（DPI 100%/150% 各一次）；pet 窗口动态恶意调用被拒 | 用户开启桌宠开关 |
| FE-21 | 真机 3×10 分钟（LOL 结算/视频/IDE 各 10 分钟，≥20 次人工标注 ROI 内目标出现）命中/漏报/误报与热 OCR P95 ≤2000ms；独占全屏 WGC 黑帧表现 | 用户开启「屏幕感知」开关并准备**非敏感测试画面** |
| FE-31 | 真机逐项演示（FE-31-G）：主窗最小化下 active / quiet / 点击读屏 / 普通输入 / 暂停 / 结束；拖动结束不算点击、双击不发两轮的目视确认 | 桌宠 + 屏幕感知开启，且已确认陪伴范围 |
| FE-32 | 真机中文文章 / 英文文档 / 混排 IDE 各 5 例预标问答（FE-32-B，需真实 Provider）；真实窗口热读屏 P95 ≤3000ms；断网下双语资源加载 | 需先解决 `chi_sim` 资源与 `npm install`（见上表） |
| 环境线装配 | 新接进生产装配的 `environmentPlugin` / `environmentHostPlugin` / 上下文源注册，**需要在真实 Tauri 进程里跑一次**：传感器能否真的 running、`environment_capture_window` 是否返回 ok、摘要与摘录是否真的进了请求 | 一次真实桌面启动 |
| FE-30（未来） | 30 分钟组合负载（帧率 P95/CPU/内存增量/OCR 队列/音频首声延迟）、权限拒绝/坏包/WebGL 失败降级、动态攻击出口检查、安装包离线资源 | 上述各项开启 + FE-27～29/31/32 完成 |

---

## 接手注意事项

1. **FE-30 不可提前**：J～N 为用户新增必需范围；仅 FE-20 窗口、FE-21 五词识别或主窗聊天通过，不构成桌宠陪伴闭环。
2. **FE-31/32 worker 规则**（索引原文）：先核对已有实现/报告、对新增 AC 逐项列缺口再补代码与定向测试；不得只改文档状态；未经真实中英文读屏、pet 点击对话、安静模式、真实音频/角色验证，不得宣称完成。
3. **FE-22 固化的契约**：环境触发器时钟必须与 monitor 时钟同源（`deps.environment.clock`），否则摘要 TTL 判定错位——已在 CONTRACTS.md 登记，改装配时勿破坏。
4. **隐私红线**（贯穿 FE-19/21/22/32）：默认全关、采集与摘要授权分层、OCR 原文/截图不落盘不外发不进 Trace；FE-32 新增的「摘录进模型」是独立授权且替代范围仅限该 SPEC。
5. 未提交改动包含本轮全部实现与规格更新；提交/推送按用户明确授权执行。
