# MVP 0.5 Handoff · 六份 SPEC 收口状态与遗留清单

日期：2026-09-15。基线：`58dd1be`（本文件随 MVP 收口提交入库）。范围：[RPD](RPD_MVP_0.5.md) 定义的 MVP-01～06 及其全部 SPEC / 报告。索引入口：[integration/SPEC_MVP_0.5.md](integration/SPEC_MVP_0.5.md)。
用途：接手者据此知道「做完了什么、还差什么、差的东西需要什么条件」。

## 一、已完成（production+fixture 证据，报告逐 AC 可查）

| SPEC | 状态 | 报告 |
| --- | --- | --- |
| MVP-01 可选能力生命周期 | A～E PASS | [core/reports](core/reports/MVP-01_ACCEPTANCE.md) |
| MVP-02 Presentation 插件边界 | 完成 | [frontend/reports](frontend/reports/MVP-02_ACCEPTANCE.md) |
| MVP-03 删除 Legacy Pet | A/C/D PASS；B 真人点击 NOT RUN | [frontend/reports](frontend/reports/MVP-03_ACCEPTANCE.md) |
| MVP-04 OCR 观察与陪伴 | A/B/C/E PASS；D 部分 PASS（device） | [frontend/reports](frontend/reports/MVP-04_ACCEPTANCE.md) |
| MVP-05 七场景隔离矩阵 | A～E PASS（D 为 device） | [integration/reports](integration/reports/MVP-05_ACCEPTANCE.md) |
| MVP-06 Memory/Wiki/RAG 收口 | A～E/G PASS；F 见下 | [llm/reports](llm/reports/MVP-06_ACCEPTANCE.md) |

最终全量回归：`npx vitest run` → **153 文件 / 1659 项通过、0 失败**（4 skipped 均为需真实凭证的 real 用例）；`tsc --noEmit`、`npm run build`（含 `tsc -b`）、`cargo test --lib`（41/41）全过。

真机已取证（2026-09-14/15，用户授权）：真实画面 OCR → 词表 → 门禁 → **真实 DeepSeek 主动轮落库**（回复正确引用 pentakill 观察）、OpenPet 收到 thinking 事件——OCR→Agent 链路为真。

## 二、遗留项（按优先级）

### 1. proactive 轮桌宠 say/emotion 未送达（已具备排障条件）

- 现象：真机主动轮回复落库、thinking 事件可达 OpenPet，但 say/emotion 没出现；用户轮无此问题（PET-07 已证）。
- 静态排查已穷尽：runtime 事件流两轮一致、emit 逐订阅者容错、注册表单例、命令缓冲/TTL/去重无嫌疑、对 OpenPet 直接 `POST /api/say`（ttlMs=9990）返回 200——**各层单独都对，缺的是真实宿主内的一手观测**。
- **排障手段已就位**：`trace` 新增 `pet_command` 事件（command/outcome/code，无正文），presenter 诊断已接线 trace sink，Inspector 页可查；本机 `aika.db` 已写 `trace.enabled=1`（调试后可关）。
- 复现路径：等距上次消息 ≥90 分钟（`MIN_INTERVAL_MS`），写入 `proactive={"enabled":true,...}` 后启动宿主，60 秒内时间驱动 tick 会走同一条 `attemptSendProactive`；随后查 `trace_events` 表 `kind="pet_command"` 即知 say 的实际去向（accepted/deduped/stale/expired/timeout）。
- 附带疑问：宿主进程曾多次自行退出（3～24 分钟不等，无 panic、无崩溃转储；不排除窗口被手动关闭）。观察 say 时一并留意。

### 2. MVP-06-F 真实 Provider 语义门槛 FAIL（8/10，需 ≥9）

- `llm05.real.acd.test.ts` 真实凭证运行：两处 ungrounded 同源——「换工作」知识条目（`k-6b60719d`）的日文/英文变体回答偏离来源，中文变体通过。逐题证据：[LLM_05_REAL_AC_D_DEEPSEEK_FLASH.json](llm/reports/evidence/LLM_05_REAL_AC_D_DEEPSEEK_FLASH.json)。
- 复跑方式：`AIKA_REAL_LLM=1 AIKA_LLM_API_KEY=<key> npx vitest run src/services/knowledge/llm05.real.acd.test.ts`。密钥在本机 `secrets.json`（DPAPI CurrentUser 加密，PowerShell `ProtectedData::Unprotect` 可解；**用后即删临时文件**）。修法方向属 prompt/检索质量调优，未立项。

### 3. Voice→Agent→Pet 实机闭环

- 需要真人语音输入，无法自动化。链路代码就位，缺一次真实说话。

### 4. MVP-03-B 真人点击点验

- 设置面板五个陪伴入口（主动/安静/暂停读屏/看屏幕聊聊/结束陪伴）需真人在真实窗口逐一点验。WebView2 不接受合成点击，只能人工。

### 5. 前端角色线（与 MVP 无依赖，可并行）

- FE-27～30 仍待实现（Live2D 线 + FE-30 组合收口），FE-33 真机装配验收待做——见 [frontend/HANDOFF.md](frontend/HANDOFF.md)。

## 三、运行时状态备忘（不在仓库，只在本机）

- `%APPDATA%\com.aika.companion\aika.db`：演示用 `proactive` 键已删除（恢复默认关）；`trace.enabled=1` 调试后仍在（隐私考量：默认应关，验证完 say 问题后建议关闭）。
- 演示脚本、解密密钥临时文件均已清理；OpenPet/Aiki 是否在跑以实际进程为准。

## 四、提交约定

- 本提交包含 MVP-01～06 全部实现、测试、规格与报告；由多段工作（前一位执行者 + 本轮接手者）合并而成，报告内已分段记录。
- 0.5 DoD 未全过（见 MVP-06 报告 §6），**不宣告冻结发布**。
