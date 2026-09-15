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

### 4. MVP-03-B 真人点击点验

- 设置面板五个陪伴入口（主动/安静/暂停读屏/看屏幕聊聊/结束陪伴）需真人在真实窗口逐一点验。WebView2 不接受合成点击，只能人工。

### 5. 前端角色线：**已被取代，不应再按原顺序开工（2026-09-15 核实）**

- **FE-27 / FE-28 / FE-29 三份头部均标 `SUPERSEDED（桌宠新路线）· 2026-09-14`**：不再自研 Live2D manifest/renderer 体系；映射 profile 归 PET-01/02（已交付），Live2D 条件接入归 **[PET-08](frontend/specs/PET-08.md)**，而 PET-08 是 **DEFERRED（0.6 条件路线）**，其启动条件是「用户明确选择 Live2D 路线」。
- **FE-30 是「部分替代」**：0.5 桌宠表现按 PET-07 验收，自研窗口/Live2D 组合项不作其门禁；环境、授权、OCR 与陪伴业务项继续保留，A～I 基础验收 + J～N 仍不得省略。
- 本轮顺带核实的素材现状（供 PET-08 决策参考）：仓库里**没有 Live2D 运行时依赖**（无 cubism/pixi），只有 `tools/live2d-pipeline/`（ComfyUI 素材生产流水线与 character brief）与安卓时代残留的 `app/src/main/java/.../domain/live2d`；即**没有可直接加载的 moc3 角色包**。
- 所以「下一步」不是 FE-27→28→29；需要你先做的是那个 **0.6 路线决策**（是否走 NyaDeskPet/Live2D）。在那之前，剩下的实机项按下面顺序推进即可。

### 6. 其余实机/集成项

- **FE-33 真机复验**：7 个 AC 需真人在场目视（拖动/双击/锁屏/DPI/性能测量）。**注意 FE-33-F 与 BUG-01 已因 MVP-03 删除旧自研桌宠而条目失效**（已在缺陷记录与报告两处登记）；BUG-02（可观测性）、BUG-03（聊天区滚动）仍待复验。release 构建已就绪：`target/release/aika-crossplatform.exe` 27.4 MB @2026-09-15 17:14。
- **INT-01**：五列中只有自动消费者契约列过。**Tauri + plugin-sql 列**在 2026-09-15 取得部分设备证据：release 构建启动后从 SQLite 读到历史消息（重开渲染回归截图可见 17:03 那轮），且 `trace_events` 表由真实应用经 plugin-sql 建表并写入（`pet_command` 诊断行）——但「错误 UI」「生产 DEV 默认开关」仍未目视，故这一列记为**部分**，不整列 PASS。浏览器真实 UI / 真实 Provider / 真实手机三列仍 NOT RUN。
- **INT-03 发布门禁**：2026-09-15 已执行，报告见 [integration/reports/INT-03_ACCEPTANCE.md](integration/reports/INT-03_ACCEPTANCE.md)——全量 1659 项、tsc、`npm run build`、`cargo test --lib` 41/41、release 构建、**MSI 打包**、**启动 + 重开渲染回归**（`PrintWindow` 取证）全绿；**NSIS 打包 BLOCKED**（工具链获取 `timeout: global`）、**安装/卸载回归 NOT RUN**（需授权在用户机器做系统级安装）。

## 三、运行时状态备忘（不在仓库，只在本机）

- `%APPDATA%\com.aika.companion\aika.db`：观察期间写入的 `proactive` 与 `trace.enabled` 两键已删除，恢复产品默认（proactive 默认关、trace 生产默认关）。
- 演示脚本、解密密钥临时文件、气泡采样器均已清理；OpenPet/Aiki 是否在跑以实际进程为准（收尾时 release 版 Aiki 与 OpenPet 均在运行）。

## 四、提交约定

- 本提交包含 MVP-01～06 全部实现、测试、规格与报告；由多段工作（前一位执行者 + 本轮接手者）合并而成，报告内已分段记录。
- 0.5 DoD 未全过（见 MVP-06 报告 §6），**不宣告冻结发布**。
