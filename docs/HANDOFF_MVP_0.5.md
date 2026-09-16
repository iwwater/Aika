# MVP 0.5 Handoff · 六份 SPEC 收口状态与遗留清单

日期：2026-09-15。基线：`58dd1be`（本文件随 MVP 收口提交入库）。范围：[RPD](RPD_MVP_0.5.md) 定义的 MVP-01～06 及其全部 SPEC / 报告。索引入口：[integration/SPEC_MVP_0.5.md](integration/SPEC_MVP_0.5.md)。
用途：接手者据此知道「做完了什么、还差什么、差的东西需要什么条件」。

## 一、已完成（production+fixture 证据，报告逐 AC 可查）

| SPEC | 状态 | 报告 |
| --- | --- | --- |
| MVP-01 可选能力生命周期 | A～E PASS | [core/reports](core/reports/MVP-01_ACCEPTANCE.md) |
| MVP-02 Presentation 插件边界 | 完成 | [frontend/reports](frontend/reports/MVP-02_ACCEPTANCE.md) |
| MVP-03 删除 Legacy Pet | A/C/D PASS；B 真人点击 NOT RUN | [frontend/reports](frontend/reports/MVP-03_ACCEPTANCE.md) |
| MVP-04 OCR 观察与陪伴 | **A～E PASS**（D 于 09-15 真机补跑转 PASS） | [frontend/reports](frontend/reports/MVP-04_ACCEPTANCE.md) |
| MVP-05 七场景隔离矩阵 | A～E PASS（D 为 device） | [integration/reports](integration/reports/MVP-05_ACCEPTANCE.md) |
| MVP-06 Memory/Wiki/RAG 收口 | A～G PASS（F 于 09-15 补跑，真实门槛 10/10）；仅 Voice 闭环 NOT RUN | [llm/reports](llm/reports/MVP-06_ACCEPTANCE.md) |

最终全量回归：`npx vitest run` → **153 文件 / 1659 项通过、0 失败**（4 skipped 均为需真实凭证的 real 用例）；`tsc --noEmit`、`npm run build`（含 `tsc -b`）、`cargo test --lib`（41/41）全过。

真机已取证（2026-09-14/15，用户授权）：真实画面 OCR → 词表 → 门禁 → **真实 DeepSeek 主动轮落库**（回复正确引用 pentakill 观察）、OpenPet 收到 thinking 事件——OCR→Agent 链路为真。

## 二、遗留项（按优先级）

### 1. ~~proactive 轮桌宠 say/emotion 未送达~~ —— **已关闭：测量口径错误（2026-09-15）**

- 原判据（`recentEvents` 无 say、`lastAction` 停在 waiting）**不成立**：真机对照实验（`POST /api/action` / `POST /api/say` 前后各读一次 status）证明 `recentEvents` **只记录 `event` 类型调用**——say 只体现在 `bubbleText`、action/emotion 只体现在 `lastAction`。用 `recentEvents` 判断它们是否送达，读的是一个结构上不含它们的通道。
- 正确口径下的证据：新增的 `pet_command` 诊断显示真实 proactive 轮的 `event`/`emotion`/`say` **三条全部 accepted**（2026-09-15 17:03:27/17:03:32），回复同时落库。详见 [MVP-04 报告 §2 AC-D](frontend/reports/MVP-04_ACCEPTANCE.md) 与 [PET-07](frontend/reports/PET-07_ACCEPTANCE.md) 的 PET-07-B。
- 保留的改进：`trace` 的 `pet_command` 事件（command/outcome/code，无正文）已接线，Inspector 可查——桌宠排障从「靠目测」变成「看数据」，下次真出问题可直接定位。
- 复现路径（仍可用于任何桌宠命令排障）：距上次消息 ≥90 分钟后写入 `proactive={"enabled":true,...}`，启动宿主，60 秒内 tick 走 `attemptSendProactive`；查 `trace_events` 的 `kind="pet_command"`。
- **仍开放**：宿主进程偶发自行退出（3～24 分钟不等，无 panic、无崩溃转储；2026-09-15 17:02 那次持续 >15 分钟未见异常）。不排除窗口被手动关闭，未定论。

> 本机运行时状态：观察期间写入的 `proactive` 与 `trace.enabled` 两个键**已于 2026-09-15 收尾时删除**，恢复产品默认（proactive 默认关、trace 生产构建默认关）。需要复现 pet_command 诊断时，在开发者模式里打开 Trace 即可（Inspector 页可查 `pet_command` 行）。

### 2. ~~MVP-06-F 真实 Provider 语义门槛 FAIL~~ —— **已关闭：判定器假阴性，重跑 10/10 PASS（2026-09-15）**

- 首轮 8/10 的两处未达标（「换工作」条目 `k-6b60719d` 的日/英题）**经逐题读回回答，两题都答对了**（日文题「小さいチームに移りたいって話、あったよね」、英文题「小さめのチームに移りたいって…」），且无伪造引文。判定用的是**精确子串包含**，冻结词只列语料原句形态（`小さなチーム`），模型用了自然变体 → 假阴性。
- 处理：只扩容 job.md 的判定词表（同义自然变体），**题集与阈值（≥9/10）不动**；首轮证据留档 `LLM_05_REAL_AC_D_DEEPSEEK_FLASH_20260915_run1_8of10.json`。重跑：**10/10、0 伪造、verdict PASS**。
- 复跑方式：`AIKA_REAL_LLM=1 AIKA_LLM_API_KEY=<key> npx vitest run src/services/knowledge/llm05.real.acd.test.ts`。密钥在本机 `secrets.json`（DPAPI CurrentUser 加密，PowerShell `ProtectedData::Unprotect`；**用后即删临时文件**）。
- 顺带记一笔通用教训：同一个子串判定在两次真实运行里给出了不同结论（第二轮措辞恰好含原词），**真实模型用词在轮次间会漂移**——这类门槛必须容纳同义变体，否则会把「答对」判成「没答对」（本轮已连撞两例：桌宠 say 的通道误读、这条判定器假阴性）。

### 3. Voice→Agent→Pet 实机闭环

- 需要真人语音输入，无法自动化。链路代码就位，缺一次真实说话。
- **2026-09-17 更新**：验收会话已开跑，脚本见 [验收会话手册](../ACCEPTANCE_RUNBOOK_2026-09-17.md) 站 4（`STT-03` / `TTS-05` / `INT-02` 三项至今仍为 NOT RUN，一次真人回合都没跑通过）。前置条件已核实就绪：release 构建 `aika-crossplatform.exe` 28.2 MB @2026-09-16 21:09（产物新于最新源码 21:04，**无需重建**）；麦克风可用（本机有 3 个 OK 状态输入设备：HECATE G30 S / 麦克风阵列（网易虚拟音频设备）/ Deli 摄像头音频）。
- **语言分工（用户 2026-09-17 决定）**：用户本人不验日语，**日语 5 句交合作者验收**；中文 5 句、英文 3 句由用户本人执行。句子集固定，避免各人自由发挥导致结果不可比：

  | 语言 | 固定句子 | 谁验 |
  | --- | --- | --- |
  | 中文 | `今天天气不错` / `我有点累了，陪我说说话` / `帮我记住明天要买牛奶` / `你在做什么呢` / `刚才那句话你听清楚了吗` | 用户本人 |
  | 日文 | `こんにちは` / `今日はいい天気だね` / `ちょっと疲れたな` / `何してるの` / `もう一度言ってくれる` | **转合作者** |
  | 英文 | `Good morning` / `I had a long day today` / `Can you hear me clearly` | 用户本人 |

- 合作者照做时同样**只报现象**（我说的 → 她识别成的），判定由执行者回填，不在现场自行下结论。除句子集外还有三项：抢话测试（她说话时插一句）、噪声环境（放视频当背景再念 3 句）、TTS 长文本朗读 + 中途打断能否停。
- **纪律**：任一段断掉就记下来，不要重来一次把问题盖过去——丢字、抢话、字幕不同步、桌宠反应滞后正是 TODO-01 缺的输入。

### 4. MVP-03-B 真人点击点验

- 设置面板五个陪伴入口（主动/安静/暂停读屏/看屏幕聊聊/结束陪伴）需真人在真实窗口逐一点验。WebView2 不接受合成点击，只能人工。
- **2026-09-17 更新**：尚未系统点验（脚本见手册站 3）。其中「看屏幕聊聊」用户已点过一次，因此暴露一处话术缺陷，见下面 §7 TOFIX-03。

### 5. 前端角色线：**已被取代，不应再按原顺序开工（2026-09-15 核实）**

- **FE-27 / FE-28 / FE-29 三份头部均标 `SUPERSEDED（桌宠新路线）· 2026-09-14`**：不再自研 Live2D manifest/renderer 体系；映射 profile 归 PET-01/02（已交付），Live2D 条件接入归 **[PET-08](frontend/specs/PET-08.md)**，而 PET-08 是 **DEFERRED（0.6 条件路线）**，其启动条件是「用户明确选择 Live2D 路线」。
- **FE-30 是「部分替代」**：0.5 桌宠表现按 PET-07 验收，自研窗口/Live2D 组合项不作其门禁；环境、授权、OCR 与陪伴业务项继续保留，A～I 基础验收 + J～N 仍不得省略。
- 本轮顺带核实的素材现状（供 PET-08 决策参考）：仓库里**没有 Live2D 运行时依赖**（无 cubism/pixi），只有 `tools/live2d-pipeline/`（ComfyUI 素材生产流水线与 character brief）与安卓时代残留的 `app/src/main/java/.../domain/live2d`；即**没有可直接加载的 moc3 角色包**。
- 所以「下一步」不是 FE-27→28→29；需要你先做的是那个 **0.6 路线决策**（是否走 NyaDeskPet/Live2D）。在那之前，剩下的实机项按下面顺序推进即可。

### 6. 其余实机/集成项

- **FE-33 真机复验**：7 个 AC 需真人在场目视（拖动/双击/锁屏/DPI/性能测量）。**注意 FE-33-F 与 BUG-01 已因 MVP-03 删除旧自研桌宠而条目失效**（已在缺陷记录与报告两处登记）；BUG-02（可观测性）、BUG-03（聊天区滚动）仍待复验。release 构建已就绪：`target/release/aika-crossplatform.exe` 27.4 MB @2026-09-15 17:14。
- **INT-01**：五列中只有自动消费者契约列过。**Tauri + plugin-sql 列**在 2026-09-15 取得部分设备证据：release 构建启动后从 SQLite 读到历史消息（重开渲染回归截图可见 17:03 那轮），且 `trace_events` 表由真实应用经 plugin-sql 建表并写入（`pet_command` 诊断行）——但「错误 UI」「生产 DEV 默认开关」仍未目视，故这一列记为**部分**，不整列 PASS。浏览器真实 UI / 真实 Provider / 真实手机三列仍 NOT RUN。
- **INT-03 发布门禁**：2026-09-15 已执行，报告见 [integration/reports/INT-03_ACCEPTANCE.md](integration/reports/INT-03_ACCEPTANCE.md)——全量 1659 项、tsc、`npm run build`、`cargo test --lib` 41/41、release 构建、**MSI 打包**、**启动 + 重开渲染回归**（`PrintWindow` 取证）全绿；**NSIS 打包 BLOCKED**（工具链获取 `timeout: global`）、**安装/卸载回归 NOT RUN**（需授权在用户机器做系统级安装）。

### 7. 2026-09-17 验收会话新增（**尚未立 SPEC**，待本轮结束后排序）

三条均来自 2026-09-17 人工验收现场，详细现象与定位见 [验收会话手册 §十一](../ACCEPTANCE_RUNBOOK_2026-09-17.md)。

| 编号 | 问题 | 性质 | 状态 |
| --- | --- | --- | --- |
| **TOFIX-01** | 手机远程：本机浏览器打开 `http://127.0.0.1:8765/` 提示「少了 token」 | **入口体验缺陷，非功能损坏**。服务端实测全好（8765 LISTENING、`GET /` 200 返回 12 KB 手机页、无凭据 `POST /api/v1/commands` 正确返回 `{"error":"token 不对"}`）。根因：`src-tauri/src/remote.rs` 鉴权只认 `Authorization: Bearer` 或 `?token=`，无来源例外；`App.tsx` 只有「复制地址」按钮，无「打开手机页」入口 | **A1 命令下行复测判 NOT RUN，用户已决定本轮不再尝试**。0.5 唯一「本地证据只到 HTTP 202」的断点仍然悬着 |
| **TOFIX-02** | 桌宠气泡遮住模型头部；长回复无长度收敛 | 呈现缺陷。用户 2026-09-17 两次提及 | 并入 **TODO-11**（原只记位置，本轮补充「文本长度也无策略」），待用户拍目标位置 |
| **TOFIX-03** | 「看屏幕聊聊」话术与读屏结果自相矛盾 | **提示词/话术缺陷，不是 OCR 缺陷**。同一条回复里既说「画面中的内容传不到我这里」，又引用了「刚才那个 pentakill」——能说出 pentakill 证明 OCR 文本已进上下文，话术却否认可见，二者不可能同时成立。用户感知为「答非所问 / 她怎么知道五杀」 | 待本轮结束后定向修：要么话术不再声明看不到，要么不喂 OCR 文本 |
| **TOFIX-04** | **点击桌宠无反应**（用户报告「之前有，现在没了」） | **回归候选**。已排除「桌宠非 managed 派生」——进程树显示 `petshell.exe` 父进程 = 宿主进程。而 MVP-12 反向点击通道当初是真人鼠标点验闭合、MVP-15 也取到过 `speakAside` 被调用（「嗯？」），属已交付能力丢失 | 按代价排查：① `pet.clickReaction` 开关是否开（默认开）② 5 秒冷却（连点第二次本就不出声）③ 开 Trace 看 Inspector 的 `pet_command`，按 `unarmed`/`skipped`/`accepted` 分流 ④ 实例凭据是否与当前 petshell 配对 |
| **TOFIX-05** | **roam（自由移动）能力异常** | 归 **pet-shell 侧**（Aika 仓库无该符号）：`plugins/menus/defaultMenu.ts` 的 `roam` ↔ `settings.autonomousWalking`，`SettingsPage.tsx` 的 `movement` 分组（含 `walkSpeed`、`pauseOnHover`） | 具体表现待用户补（移动不停 / 移不动 / 越界 / 与交互冲突）。排查先排除 `pauseOnHover`：光标停在宠物附近时它本就该不动 |

### 8. 需要长时间等待 / 可挂后台的项 —— **转交合作者（2026-09-17）**

这些项的共同点是「时间成本为主、不需要判断力」，适合挂后台或交给合作者，不占用本轮会话时间。

| 项 | 怎么跑 | 判定标准 |
| --- | --- | --- |
| **宿主偶发自行退出**（3～24 分钟，无 panic、无崩溃转储，**未定论**） | 挂后台**连续跑一晚（≥2 小时）**，期间正常使用；每次退出记下**时刻**与**退出前在做什么**、窗口是否被手动关过 | **不能以「15 分钟没复现」结案**。复现则记时间点与当时操作；不复现如实记「观察 N 小时未复现」，**不判 PASS** |
| **RT-05 / B5 长跑与恢复** | 定时任务长跑；再分别做**关窗**、**重启**后的恢复 | 恢复后任务状态正确，且**不重放已消费任务** |
| **MVP-15 待办①：音频人耳确认** | 配合语音站一起做：触发一次点击反应，**真的听一次有没有出声** | 听到声音 = 闭合；**无声音则回落到 TOFIX-04**——当初只拦下合成调用取证，从未真的播放过 |

**合作者还需做的（非长等待）**：日语 5 句语音验收，见 §二.3。

## 三、未测项与开放问题总表（2026-09-17 汇总）

> **本节是本轮结束后的权威欠账清单**，把散落在 `ACCEPTANCE_PLAN.md`、0.6 索引、`TODO.md` 与本轮现场记录里的「没测 / 没拍板」合并到一处，供接手者（含合作者）直接取用。
> **判定口径**：未测 ≠ 不合格。除本文明确写 PASS 的项，其余一律维持 **NOT RUN**，不得因为「一直没出问题」或「单机测试通过」而自动上调。

### A. 需要真人在场（用户本人 / 合作者）

| 项 | 归属 | 现状 | 需要什么 |
| --- | --- | --- | --- |
| **语音全链路** `STT-03` / `TTS-05` / `INT-02` | 0.5 | **NOT RUN，一次真人回合都没跑通过** | 用户验中文 5 + 英文 3；**日语 5 句转合作者**（句子集与分工见 §二.3） |
| **五陪伴入口点验** MVP-03-B | 0.5 | NOT RUN（「看屏幕聊聊」已点过一次，暴露 TOFIX-03） | 真人在真实窗口逐个点；另需确认**桌宠不在时入口是否仍可用** |
| **A2 DeepSeek 账单对账** | 0.5 | NOT RUN；成本页金额一律标「估算」 | 控制台 `deepseek-flash` 输入/输出单价（每百万 token） |
| **A3 LLM-01 质量人工判定** | 0.5 | 证据文件内**已有 2026-09-13 人工审阅结论**（PASS，六条历史失败 6/6 不复现） | 待用户确认**认可该结论并回填**；顺带拍板 LLM-05 的 `noAnswerBonus`（模型反问「『她』是谁」——是否要求收紧 Prompt，检索为空且指向第三方时先澄清指代） |
| **A4 27 份 AUTO_PASS 报告人工审阅** | 0.5 | 机械扫描已完成（**0 份真缺陷**），**人工判定未做** | 独立复核：NOT RUN 声明是否诚实、结论与证据是否相符。优先 GW-02/05/06、AGT-02/03、RT-03、FE-17-pre、LLM-12/FE-26 |
| **B1 界面与交互目视** | 0.5 | 部分 | FE-23/24/25/26、TTS-04、FE-02 各页签未逐一目视 |
| **B2 INT-01 桌面列** | 0.5 | 部分（整列不 PASS） | 「错误 UI」未目视；「生产 DEV 默认开关」已有构建级证据 |
| **FE-33 真机项 + BUG-02/03** | 0.5 | NOT RUN | 拖动 / 双击 / 锁屏 / DPI / 性能测量；**FE-33-F 与 BUG-01 已因 MVP-03 删除旧自研桌宠而失效，不用再验** |
| **B3 多 WebView 越权边界** | 0.5 | NOT RUN | 开第二个窗口调 `outbound_publish`，预期被拒 |
| **MVP-15 音频人耳确认** | 0.6 | 待办①：当初只拦下合成调用取证，**从未真的播放过** | 真听一次有没有出声；无声音则回落到 TOFIX-04 |

### B. 需要长时间等待 / 可挂后台 —— **已转合作者，详见 §二.8**

| 项 | 现状 |
| --- | --- |
| 宿主偶发自行退出（3～24 分钟，无 panic、无崩溃转储） | **未定论**，需过夜观察，**不得以「15 分钟没复现」结案** |
| RT-05 / B5 长跑与恢复 | NOT RUN；关窗、重启后恢复且不重放已消费任务 |

### C. 缺凭证 / 缺设备 —— 维持 NOT RUN，不安排

| 项 | 缺什么 |
| --- | --- |
| **A1 命令下行真实进程复测** | 不缺设备，**缺一条能用的入口**：服务端实测健康，但本机浏览器也须带 token，用户已放弃本轮（TOFIX-01）。**这是 0.5 唯一「本地证据只到 HTTP 202」的断点** |
| B4 真实手机连宿主 / GW-04 设备端到端 | 真机；且需 `useRemoteAccess` 传 `lanEnabled`（当前 Rust 只绑 loopback） |
| K3 Telegram、K4 Codex/Claude、K5 INT-04、K6 飞书、K7 public TLS | 缺 Bot token / CLI 登录 / 企业应用凭证 / TLS |
| 云 TTS 真实试听 | 需有效服务凭证；**云 TTS 至今一次都没试听过，既有证据全部走假 `HttpFetch`**。配置不全时界面必须按 `note/degraded` 降级显示，不能静默假装成功 |
| 另三种 LLM 协议真实样本（anthropic / gemini / openai-responses） | 无凭证 |
| 渠道收端目视、Tailscale、Origin 白名单 | 真机与网络条件 |

### D. 需要构造条件 / 定位（不是等时间）

| 项 | 现状 |
| --- | --- |
| **NSIS 打包** | BLOCKED：工具链获取 `timeout: global`，**需定位而不是重试** |
| N3 plugin-sql 旧库 12→16 真实迁移 | 部分：真实读写已证，`try-ALTER` 升级路径未单独复现 |
| N5 FE-17-host dev-relay | tauri ✅ / dev-relay NOT RUN（缺宿主 producer 入口与 ticket 通路，需单独立 SPEC） |
| N7 GW-04 宿主侧接线 | NOT RUN |
| MVP-12 三项未闭合 | 单实例转交、真实断连分支、真实链路双击边界 |
| MVP-13 遗留 | `attach`/断连恢复、FPS 采样、Cubism Core 分发条件核查、安装模式 per-machine vs per-user（现为 per-machine，要求提权） |
| MVP-15 真排队 | 需改 `SpeechQueue` 回合语义，未做 |

### E. 本轮新增缺陷 —— 见 §二.7（TOFIX-01～05）

TOFIX-01 手机远程入口 · TOFIX-02 气泡遮模型且长文本无收敛 · TOFIX-03「看屏幕聊聊」话术自相矛盾 · TOFIX-04 点击无反应（回归候选）· TOFIX-05 roam 能力异常（pet-shell 侧）。

### F. 开放问题（待拍板，不是测试项）

| 问题 | 为什么悬着 |
| --- | --- |
| **正式产品名 / 标识** | 现为临时 **PetShell** / `dev.aiki.petshell`；改名要同步 profile `release` 与契约文档（代码位置一事已定：Aika 仓库 `pet-shell` 分支） |
| **气泡目标位置与长度策略** | 待用户拍板：宠物头顶上方（随窗口自适应）？还是窗口外侧 / 跟随模型？**本轮新增一层**：除位置外，长回复**没有长度收敛策略**，8 行日语气泡实测盖住模型，需同时定「超长怎么办」 |
| MEM-DEC-01 记忆双轨 | `memoryCandidates` 无生产消费点：接通确认流，还是从生成协议删除 |
| 宿主偶发自行退出 | 未定论，不排除窗口被手动关闭 |

> 本节只交接**现存问题**（没测的、坏了的、待拍板的）。方向性愿望不在此列，见 [`docs/TODO.md`](TODO.md)——该表是愿望池不是执行授权。

## 四、运行时状态备忘（不在仓库，只在本机）

- `%APPDATA%\com.aika.companion\aika.db`：观察期间写入的 `proactive` 与 `trace.enabled` 两键已删除，恢复产品默认（proactive 默认关、trace 生产默认关）。
- 演示脚本、解密密钥临时文件、气泡采样器均已清理；OpenPet/Aiki 是否在跑以实际进程为准（收尾时 release 版 Aiki 与 OpenPet 均在运行）。

## 五、提交约定

- 本提交包含 MVP-01～06 全部实现、测试、规格与报告；由多段工作（前一位执行者 + 本轮接手者）合并而成，报告内已分段记录。
- 0.5 DoD 未全过（见 MVP-06 报告 §6），**不宣告冻结发布**。
