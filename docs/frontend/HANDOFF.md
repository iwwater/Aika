# 前端 SPEC Handoff · 三维度交接清单

日期：2026-09-14。范围：`docs/frontend/specs/` 全部 32 份 SPEC（FE-01～32）及其验收报告。源码根 `aika-crossplatform/`。
用途：任何接手者（人或 worker）据此确定「还有什么没做、什么需要真实服务、什么需要人」。

## 当前快照

- FE-01～13：状态层/自动 AC 已过（REVIEWED_AUTO 或已补证），遗留项集中在人工目视与真实对话证据。
- FE-14（协议内核）、FE-23～26（工作台/成本页）：AUTO_PASS，遗留目视与真实数据。
- FE-15/16/17（远程输出线）：PARTIAL——本地与 Rust 单元侧完成，真实宿主/公网项未验。**注意：FE-16 索引行仍写 READY，但报告 `FE-16_ACCEPTANCE.md` 已存在（PARTIAL），索引待同步**。
- FE-18～22（环境感知线，本轮 2026-09-14 完成）：模块内/逻辑轨 PASS，真机与组合项 NOT RUN（详见下）。
- FE-27～32：**全部未实现**（DRAFT / 待实现）。FE-30 含新增 J～N（FE-31/32 组合验收），必须最后执行。
- 仓库有大量未提交改动（FE-18～22 实现 + FE-31/32 规格新增 + 索引/PRD 更新）；按仓库规则不由 worker 自行提交。

---

## 一、待办 SPEC（未实现 / 未执行）

| SPEC | 交付 | 依赖 | 关键约束 |
| --- | --- | --- | --- |
| [FE-27](specs/FE-27.md) | Live2D 素材/运行时核实、manifest 校验、表现契约（character.presentation.v1） | 无 | 素材与 SDK 条款须核实登记；无合法包时 FE-27-C 记 BLOCKED，不得整份标 PASS |
| [FE-28](specs/FE-28.md) | 真实 Live2D 渲染、表情动作、失败回退 | FE-27；pet 集成需 FE-20 | 真实 WebGL 截图/视频留证；缺包 B/E BLOCKED |
| [FE-29](specs/FE-29.md) | 实际播放能量、口型、打断同步 | FE-27；真实 pet 口型需 FE-20/28 | 先核查播放后端能量支持矩阵；口型偏差 ≤150ms/打断 ≤300ms 需外录音画 |
| [FE-31](specs/FE-31.md) | 桌宠陪伴会话、active/quiet 模式、点击读屏、pet 普通输入、暂停/结束 | FE-18/19/20/22 + FE-32 端口 | 新建 `CompanionSessionController`（off/active/quiet）；`pet.intent.v1` 受控意图协议；可 fake 外部端口先验逻辑 |
| [FE-32](specs/FE-32.md) | 中英文屏幕文本上下文与按需读屏（`ScreenContextSource.readOnce`） | FE-18/19/21 | eng+chi_sim 离线资源；摘录进模型需独立授权（覆盖 FE-21「仅词表」限制）；排除 pet/主窗自读；TTL 60s、并发 1、10 次/分钟 |
| [FE-30](specs/FE-30.md) | 组合链路、权限、性能与设备验收（A～I + **新增 J～N**） | FE-18～22、27～29、31、32 的生产实现 | **必须最后执行**；J～N 覆盖 FE-31/32 组合（COMP-07），旧九份通过不构成完整交付；30 分钟组合负载 + 安装包离线资源验证 |

执行顺序建议：FE-27→28→29（角色线）与 FE-31←FE-32（陪伴线，FE-31 逻辑可先做）可并行推进；FE-30 收口。FE-30 的 J～N 具体条目见 `specs/FE-30.md` 场景矩阵。

另有两件小待办（非 SPEC 主体）：
- `SPEC.md` 索引：FE-16 行状态过期（写 READY，实际报告为 PARTIAL），待同步。
- FE-04 报告识别出「error 气泡重试按钮」需新增 storage 删除消息端口 + 双适配器实现，属未立项的独立 SPEC。

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
| FE-30（未来） | 30 分钟组合负载（帧率 P95/CPU/内存增量/OCR 队列/音频首声延迟）、权限拒绝/坏包/WebGL 失败降级、动态攻击出口检查、安装包离线资源 | 上述各项开启 + FE-27～29/31/32 完成 |

---

## 接手注意事项

1. **FE-30 不可提前**：J～N 为用户新增必需范围；仅 FE-20 窗口、FE-21 五词识别或主窗聊天通过，不构成桌宠陪伴闭环。
2. **FE-31/32 worker 规则**（索引原文）：先核对已有实现/报告、对新增 AC 逐项列缺口再补代码与定向测试；不得只改文档状态；未经真实中英文读屏、pet 点击对话、安静模式、真实音频/角色验证，不得宣称完成。
3. **FE-22 固化的契约**：环境触发器时钟必须与 monitor 时钟同源（`deps.environment.clock`），否则摘要 TTL 判定错位——已在 CONTRACTS.md 登记，改装配时勿破坏。
4. **隐私红线**（贯穿 FE-19/21/22/32）：默认全关、采集与摘要授权分层、OCR 原文/截图不落盘不外发不进 Trace；FE-32 新增的「摘录进模型」是独立授权且替代范围仅限该 SPEC。
5. 未提交改动包含本轮全部实现与规格更新；提交/推送按用户明确授权执行。
