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

## 三、运行时状态备忘（不在仓库，只在本机）

- `%APPDATA%\com.aika.companion\aika.db`：观察期间写入的 `proactive` 与 `trace.enabled` 两键已删除，恢复产品默认（proactive 默认关、trace 生产默认关）。
- 演示脚本、解密密钥临时文件、气泡采样器均已清理；OpenPet/Aiki 是否在跑以实际进程为准（收尾时 release 版 Aiki 与 OpenPet 均在运行）。

## 四、提交约定

- 本提交包含 MVP-01～06 全部实现、测试、规格与报告；由多段工作（前一位执行者 + 本轮接手者）合并而成，报告内已分段记录。
- 0.5 DoD 未全过（见 MVP-06 报告 §6），**不宣告冻结发布**。
