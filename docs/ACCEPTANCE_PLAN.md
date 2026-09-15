# 验收计划：留给你的验收清单（2026-09-13 立稿 · 2026-09-15 回填）

来源：[GOAL_FINAL_STATUS.md](GOAL_FINAL_STATUS.md) + [GOAL_RUN_LEDGER.md](GOAL_RUN_LEDGER.md) + 阶段 1 真实轨结果 + 本次会话（命令下行收口）。
本文件回答一件事：**哪些必须你亲自验、怎么验、验到什么算过**。每条都给了可复现步骤、预期结果与「不通过怎么办」。

---

## 〇 · 2026-09-15 状态回填（**以本节为准**）

下文各节保留 09-13/09-14 当时的步骤原文（仍可照做），但**多项状态已被 09-15 的 MVP 0.5 收口与 INT-03 门禁覆盖或改写**。逐项当前状态：

| 项 | 09-15 状态 | 说明 / 去向 |
| --- | --- | --- |
| A1 命令下行真实进程复测 | **NOT RUN（仍未做）** | 未见 09-14 之后的取证记录；执行条件已具备（09-15 release 宿主可启动、可渲染历史）。步骤见 §一 · A1 |
| A2 DeepSeek 账单对账 | **NOT RUN** | FE-26 真实费用仍待；成本页金额一律标「估算 / 非官方账单」 |
| A3 LLM-01/05 质量结论回填 | **部分完成** | LLM-05 真实门槛已于 09-15 补跑 **10/10 PASS**（MVP-06-F 转 PASS，首轮 8/10 判为判定器假阴性）；**LLM-01 六条质量检查点仍 `REVIEW REQUIRED`，待人工判定** |
| A4 27 份 AUTO_PASS 报告审阅 | **未完成** | 人工审阅仍待；09-15 新增的 INT-03 报告同样待审阅 |
| B1 界面与交互目视 | **部分** | INT-03 的重开渲染回归已取主窗像素（角色区 / 对话区 / 侧栏渲染正常、历史从库加载成功）；FE-23/24/25/26、TTS-04、FE-02 各专项页签**未逐一目视** |
| B2 INT-01 桌面列六项 | **部分** | Tauri+plugin-sql 列已取部分设备证据（真机读到历史消息；`trace_events` 由真实应用经 plugin-sql 建表并写入）；**「错误 UI」「生产 DEV 默认开关」未目视** → 整列不 PASS |
| B3 多 WebView 越权边界 | **NOT RUN** | 无变化 |
| B4 真实手机连宿主 | 转待办 | 见 §八 |
| B5 长跑与恢复 | **NOT RUN** | RT-05 真实宿主长跑未做。另有一个开放观测：宿主进程偶发自行退出（3～24 分钟，无 panic、无崩溃转储，**未定论**，不排除窗口被手动关闭） |
| N3 plugin-sql 真实迁移（12→16） | **部分** | plugin-sql 真实读写已证（建表 + 写入 `trace_events`）；**旧库 `try-ALTER` 12→16 的升级路径未单独复现**，不整项 PASS |
| N5 FE-17-host 逐宿主验收 | **部分** | tauri ✅；**dev-relay NOT RUN**（缺宿主 producer 入口与 ticket 通路，需单独立 SPEC） |
| N7 GW-04 宿主侧接线 | **NOT RUN** | 无变化 |
| §五 INT-03 发布门禁 | **已执行（部分 PASS）** | [INT-03 报告](integration/reports/INT-03_ACCEPTANCE.md)：全量 1659 项 / `tsc` / `npm run build` / `cargo test --lib` 41 项 / **MSI 打包** / 启动 + 重开渲染回归全绿；**NSIS 打包 BLOCKED**（工具链 `timeout: global`）、**安装 / 卸载回归 NOT RUN**（需授权做系统级安装） |

**不再从本文件找入口的部分**：0.5 主线（MVP-01～06，六份 SPEC 已全部执行完毕）的收口状态与遗留清单见 [HANDOFF_MVP_0.5.md](HANDOFF_MVP_0.5.md)；索引见 [integration/SPEC_MVP_0.5.md](integration/SPEC_MVP_0.5.md)。本文件此后只维护「需要用户亲自验」的清单。

---

环境事实（已核实）：

- 真实凭证现用：DeepSeek `deepseek-flash`（`aika-crossplatform/.env`）；预算上限 **3 CNY**，已用估算 ≤1 CNY，阶段 1 付费跑批已停。
- 本机有 cargo/rustc、Node；无 codex/claude CLI；无 Telegram/飞书凭证。
- 桌面端白屏已修（缺 `custom-protocol` feature），**现在能起来**——下面 B 组验收此前卡在这里，现已解锁。
- **2026-09-14 00:07 更新：手机验收暂不具备条件**，相关项已全部转入第八节待办，近期不安排。受影响的只有"真机/跨设备"类；**命令下行复测（A1）改走本机浏览器路径，不需要手机，仍可正常推进**。

---

## 零、本次会话已收口（不需要你再做）

| 项 | 结果 |
| --- | --- |
| 命令下行两处断点 | 已修：Rust `handle_commands` 受理后补 `emit("outbound://command")`、生产装配补 `commandAuthorizer` |
| 本地测试 | wiring 10/10、outbound+hosts 53/53、cargo test 19/19、tsc 0 |
| 产物 | `dist` 22:52 → exe 22:54（已重嵌入），构建命令 `cargo build --release --features custom-protocol` |
| 提交 | 7 个按 SPEC 拆分的 commit，**未推送**（详见文末第七节） |
| 唯一遗留 | **命令下行的真实进程复测**——本沙箱无法保持 GUI 进程，只能你在宿主环境做（见 A1） |

---

## 一、现在就能做（无外部依赖，建议今晚先做 A1~A3）

### A1 · 命令下行真实进程复测 ★最高优先级（10 分钟）

这是本轮唯一未闭合项：本地证据只到「HTTP 202 + 单元/装配测试」，**没有真实进程级证据**证明命令真的流到了桌面 Runtime。

**前置**：本轮产物已就绪。若之后你或别的 agent 改过前端，需要先重建：
```bash
cd aika-crossplatform && npx vite build
cd src-tauri && (touch src/lib.rs 或改一下时间戳) && cargo build --release --features custom-protocol
```

**步骤**

> **不需要手机**：Rust 默认只绑 loopback（跨设备本来就连不上），所以本机浏览器打开的就是同一个"手机页"。真机验收已转待办，见第八节。

1. 启动 `aika-crossplatform/src-tauri/target/release/aika-crossplatform.exe`（确认界面正常，不再是白/黑屏）。
2. 桌面端 → 设置/远程 → 打开「手机远程」开关（`App.tsx` 远程开关，默认端口 **8765**），界面显示地址与 token。
3. **在本机浏览器打开 `http://127.0.0.1:8765/`**，按页面提示填入界面上显示的 token。
4. 发一条可判定的消息，例如：「请只回复四个字：收到命令」。
5. 观察桌面端界面是否出现这条用户消息并产生回复；再看浏览器页面是否收到回帧。
6. （可选）想绕开页面直接验证协议层，可用命令行发同一条命令，需先用页面完成一次配对拿到 token：
   `curl -X POST http://127.0.0.1:8765/api/v1/commands -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"schemaVersion":1,"type":"submit","messageId":"m1","text":"请只回复四个字：收到命令"}'`

**预期结果**

- 桌面聊天界面出现这条用户消息并产生回复 → 说明命令真的到了 `Runtime.submit`（此前是「202 但桌面毫无反应」）。
- 手机页在数秒内收到回帧（长轮询上限 25s，正常远快于此）。
- 同一条（相同 messageId）重发不会重复执行 → 重放去重生效。

**判定与不通过怎么办**

| 现象 | 判定 | 排查方向 |
| --- | --- | --- |
| 桌面执行 + 手机收到回帧 | **PASS** | 收口完成，可回填台账 |
| 只回 202、桌面无反应 | FAIL-A | emit 或授权链路仍断：查 Rust 是否 emit 成功、`outbound://command` 监听是否注册（`composition` 里 await `ready()` 是否真执行） |
| 桌面执行了、手机收不到回帧 | FAIL-B | 查 `registerTarget` 映射与会话键（principal:conversation 是否与手机侧一致） |
| 手机打不开页面 | 环境问题 | 先确认开关已开、端口未被占、宿主与手机同网段；Rust 默认只绑 loopback，跨设备需 LAN 参数（当前 `useRemoteAccess` 未传 `lanEnabled`） |

**证据留存**：手机 F12 网络面板（commands 响应码 + 回帧 payload）+ 桌面界面截图 + 如有，Rust 侧日志。

### A2 · DeepSeek 账单对账（10 分钟）

1. 登录 DeepSeek 控制台 → 用量/账单，核对 2026-09-13 当日调用次数与金额是否在 **3 CNY** 内。
2. 把控制台显示的 `deepseek-flash` 单价（输入/输出每百万 token）告诉我。
3. 我把它填进 FE-26 价目表（版本化 `PriceEntryV1`），成本页金额即从 unpriced 变为真实金额。

**判定**：金额 ≤3 CNY 且单价可取 = 该 AC 最后一步完成；超预算立即停跑。

### A3 · LLM-01/05 质量结论回填（10~20 分钟）

1. 打开 `docs/llm/reports/evidence/LLM_01_REAL_DEEPSEEK_FLASH_SAMPLES.json`，重点看 `qualityScreens` 有标记的 14 条，判断角色自然度与边界表达。
2. 看 `LLM_05_REAL_AC_D_DEEPSEEK_FLASH.json` 的 `noAnswerBonus`：模型把问"她"的问题理解成问自己——你决定是否要求 Prompt 收紧（澄清行为）。
3. 给出判定：LLM-01 六条历史质量失败是否关闭、LLM-05 是否判 PASS。

**判定**：把报告结论从 REVIEW REQUIRED 改为你的人工判定（PASS 或退回定向修复）。

### A4 · 27 份 AUTO_PASS 报告审阅（贯穿，随时抽查，30~60 分钟）

优先安全敏感与计费相关：**GW-02/05/06**（渠道验签与越权）、**AGT-02/03**（进程与权限边界）、**RT-03**（Windows 路径边界）、**FE-17-pre**（认证与暴露策略）、**LLM-12/FE-26**（计费）。
重点看两处：报告里的「NOT RUN 声明」是否诚实、「证据命令 + 退出码」是否可复现。
不通过的逐条记进 `GOAL_RUN_LEDGER.md` 的人工补验队列，我不擅自改判定。

---

## 二、桌面端可跑后（白屏已修，这些现在都解锁了）

### B1 · 界面与交互目视（20 分钟）

FE-23 时间线、FE-24 浮层（拖动浮层同时聊天是否稳）、FE-25 上下文视图三态、FE-26 成本页（A2 对账后看真实金额）、TTS-04 设置表单、FE-02 键盘与窄屏。

### B2 · INT-01 桌面列六项（20 分钟）

Tauri 启动、plugin-sql 实际 SQL、Remote 与同 Runtime、生产 DEV 默认值、F1 六项交互（步骤见 INT-01 报告人工列）。

### B3 · 多 WebView 越权边界（10 分钟）

开第二个窗口调 `outbound_publish`，**预期被拒**（仅主窗口可调）。这是真实攻击面，本地测不了。

### B4 · 真实手机浏览器连宿主（需真机 —— **已转待办，见第八节**）

配对码配对、断网重连、能力降级目视；租约在线/离线正确、重连不串数据（GW-04 设备端到端）。
当前不具备条件，暂不安排。另注：即使有手机，跨设备还需 `useRemoteAccess` 传 `lanEnabled`（Rust 现在只绑 loopback）。

### B5 · 长跑与恢复（可挂后台）

RT-05 定时任务长跑、关窗/重启后恢复与不重放已消费任务。

---

## 三、需要凭证或授权（我这边做不了）

| 开关 | 内容 | 状态 |
| --- | --- | --- |
| K3 | GW-02 真实 Telegram 双向 | ☐ **需你提供 Bot token** |
| K4 | AGT-03/04 真实 Codex/Claude | ☐ 需安装 CLI 并登录（用你的额度） |
| K5 | INT-04 真实轨（受控 canary 修改） | ☐ 依赖 K3+K4 |
| K6 | GW-05 飞书 | ☐ 可选，需企业自建应用凭证 |
| K7 | public 暴露层 TLS | ☐ 可后置（无真实 TLS 证据则策略层恒 BLOCKED） |

---

## 四、语音感知（机器不可替代，需桌面端 + 麦克风）

- **STT-03**：安静 + 日常噪声各一轮固定语句集，看识别准确与断句。
- **TTS-05**：播放固定文本，听自然度、能否随时打断。
- **INT-02**：完整走一遍 STT→LLM→TTS→前端，确认全链路无断点。

---

## 五、发布前

**INT-03 发布门禁**：全量 `npm test` + `cargo test` + `tauri build` + 安装启动回归。发布前独立完成，不与其他验收互相代偿。

---

## 六、维持不动（无需安排）

- DEFERRED 6 项：桌宠/Live2D、环境感知 FE-18~22、Stage3、云 Relay、GW LAN 自动 Discovery、每主体独立记忆库——重启需你明示。
- QQ 真实轨（GW-06）：官方能力缺口，维持 BLOCKED。
- 其余 3 个 LLM 协议（anthropic/gemini/openai-responses）真实样本：无凭证，维持 NOT RUN。

---

## 七、非人工工作进度（我这边的账）

| 序 | 项 | 状态 |
| --- | --- | --- |
| N1 | FE-15 宿主轨基线 | ✅ 完成 |
| N2 | FE-15 B~E（gateway.rs/remote.rs、手机页、tauriTransport） | ✅ 完成（cargo test 19/19，真实宿主启动 PASS） |
| N3 | plugin-sql 真实迁移（RT-02 try-ALTER 12→16） | 待做——依赖真实宿主环境 |
| N4 | FE-16 dev-relay + wsTransport | ✅ 完成（本地真实 loopback） |
| N5 | FE-17-host 逐宿主验收 | tauri ✅ / dev-relay NOT RUN（缺宿主 producer 入口与 ticket 通路，需单独立 SPEC） |
| N6 | RT-05 长跑（真实宿主关窗/重启） | 待做——依赖真实宿主 |
| N7 | GW-04 宿主侧接线 | 待做 |

---

## 八、需真机/手机 —— 待办（当前不具备条件，暂不安排）

用户 2026-09-14 00:07 确认手机验收暂不可行，以下项转入待办。等具备条件时再启用，不要因为"没验"就判成不通过——它们是 NOT RUN，不是 FAIL。

| 项 | 原属 | 启用条件 |
| --- | --- | --- |
| B4 真实手机浏览器连宿主（配对、断网重连、能力降级目视） | 二 · B4 | 有手机与宿主同网；且需 `useRemoteAccess` 传 `lanEnabled`（当前 Rust 只绑 loopback） |
| GW-04 设备端到端（租约在线/离线正确、重连不串数据） | 二 · B4 | 同上 |
| B6 渠道收端目视（Telegram 收发、URL token 脱敏、群聊不接私人提醒） | 三 · K3 | K3 Bot token + 手机 |
| 远程联调里程碑：真实手机浏览器、Origin 白名单、Tailscale | NOT RUN 清单 | 有真机与网络条件 |
| STT-03 真机麦克风（安静 + 噪声各一轮） | 四 | 有麦克风设备（与手机无关，单列） |

**不受影响**：A1 命令下行复测已改走本机浏览器（`127.0.0.1:8765`），无需手机即可完成，仍是最高优先级。

---

**本次会话的 7 个 commit（均未推送，分支 master）**：FE-15 Rust 网关 → 白屏修复+命令下行收口 → FE-17-host 装配 → FE-16 dev-relay → AGT-01+GW-06 → LLM 真实轨 harness → 台账文档。
要我推送时说一声，推送前我会再核对分支、提交清单与远端。
