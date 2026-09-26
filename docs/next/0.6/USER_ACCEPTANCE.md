# Aika Next 0.6 人工验收手册

本文是 NEXT-09 的用户操作清单（SPEC 要求「worker 提供简明操作清单」）。验收结论只由用户填写，worker 不代填 PASS。对应 SPEC：[NEXT-09](specs/NEXT-09.md)；需求：N06-R10。

## 1. 验收顺序（先看这里）

| 步骤 | 谁 | 内容 |
| --- | --- | --- |
| 1 | 用户 | 拍板 §2 的语音/LLM 真实路径决策（当前 BLOCKED） |
| 2 | worker | 执行 NEXT-08 收口：全量回归、真实回放、Windows 候选构建与验收包（08-G 附启动方法/依赖/已知限制） |
| 3 | 用户 | 拿到候选包后，按 §5 清单逐项验收，用 §7 模板回填结果 |
| 4 | 双方 | 缺陷闭环（§6）：可自动复现的先加回归测试再修复，更新候选包后复验 |
| 5 | 用户 | 全部通过后确认 → 标 RELEASE_ACCEPTED |

当前状态（2026-09-20）：NEXT-00～05、07 AUTO_PASS；NEXT-06 逻辑 PASS 但 06-E/F 真实回放 BLOCKED；NEXT-08 NOT RUN。**NEXT-08 完成前还没有可验收的候选包**；§3 的自动证据抽查现在就可以做。

## 2. 开始前需要你拍板的事（解除 BLOCKED）

| 事项 | 现状 | 可选路径 | 影响的验收项 |
| --- | --- | --- | --- |
| 真实 ASR（06-E） | 本机 whisper.cpp b5130 工具链原在 `E:/Work/toolchains/whisper-b5130`，该盘当前不存在 | A：恢复/重新下载工具链（官方来源与 SHA256 已登记 CORPUS_MANIFEST §4，免费）；B：授权 qwen-asr 云凭据（付费） | 09-C 麦克风识别 |
| 真实 TTS（06-F） | 上游只有付费云 TTS（qwen-tts / qwen-audio-tts / minimax-tts，无已授权凭据）；免费候选（Windows SAPI、sherpa-onnx TTS）未验证 | A：选定免费后端，由 worker 接入并验证；B：授权云 TTS 凭据（付费） | 09-C 听取回复 |
| 真实 LLM 回放（08-D） | 旧 Aika 的 .env 存在但未读取；需至少一条现有可用 Provider | OpenAI-compatible（DeepSeek 配置）或 Gemini 凭据，填入本机配置（credentialRef，不入库） | 09-B/D 的真实对话与记忆质量 |

三项不解决，相关自动项保持 BLOCKED，版本不能宣称「开发完成」；文字链路、Timeline、UI、持久化不受影响，可先行验收。

## 3. 现在就能做的自动证据抽查（可选）

环境：Windows 11，Node ≥ 22.12（基线 v24）。执行目录 `F:/AIVoice/Aika-Next/windows/code/desktop-pet/`。

| 命令 | 期望 |
| --- | --- |
| `npm run test:next` | 退出码 0，70 tests / 70 pass（Next 全量） |
| `npm run test:next:real` | 未配置真实凭据时按设计退出码 2（BLOCKED 门控），不是故障 |

逐 SPEC 证据在 `docs/next/0.6/reports/NEXT-0X_ACCEPTANCE.md`。注意：上游管理套件中 `settings.test.js`（2 例断言）、`memory-dynamics-http.test.js`（挂起）、`integration.test.js`（symlink EPERM/EBUSY）为本机既有基线问题（NEXT-07 报告 §4 stash 对照实验证实，与本轮改动无关），不作为验收判断依据。

## 4. 候选包启动方法（2026-09-20 已就绪）

- **候选**：工作树 `F:/AIVoice/Aika-Next` @ 候选 commit（NEXT-00～08 全部 AUTO_PASS，具体 hash 见 [NEXT-08 报告](reports/NEXT-08_ACCEPTANCE.md)头部；验收时以 `git log --oneline -1` 核对）。构建已就位（`build:windows` 与自动冒烟 `WINDOWS_SMOKE_OK` 均通过）。
- **启动**：在 `F:/AIVoice/Aika-Next/windows/code/desktop-pet/` 运行 `npm run dev` —— 构建并启动桌宠 + 管理服务；Aika 页面地址 `http://127.0.0.1:<端口>/aika-view.mjs`，端口以应用启动输出为准（管理服务绑定 127.0.0.1 随机端口）。
- **真实语音前置（09-C）**：先起本地识别服务 `F:/AIVoice/toolchains/whisper-b5130/Release/whisper-server.exe -m F:/AIVoice/toolchains/whisper-b5130/models/ggml-base.bin --host 127.0.0.1 --port 8080 -l auto -t 6 -ng`（仅 loopback）；TTS 用系统 SAPI（Microsoft Huihui），无需额外服务；LLM 凭据已在本机 gitignored `.next-real.local.json`。
- **数据目录**：`%APPDATA%/AikaNext`（smoke/preview 模式另有子目录）；不写入旧 `AAAAGENT` / 旧 Aika 数据。
- **已知基线问题**（不属于本轮缺陷）：管理套件 `settings`/`integration`/`memory-dynamics-http` 三个测试文件在本机的既有失败/挂起（见 NEXT-08 报告 §6），不影响运行。

## 5. 人工验收清单（09-A～09-F）

通过标准以 [NEXT-09 SPEC](specs/NEXT-09.md) 为准，下表是其可执行展开。每项记录 PASS / FAIL + 现象，FAIL 附截图或复现步骤。

### 09-A 启动、修改角色/Provider、重启

| 步骤 | 通过标准 |
| --- | --- |
| 启动候选包 → 打开 Aika 页 → 修改 Aika 名称/角色 Prompt → 修改 Provider 配置（填密钥后确认界面只显示「已配置」状态而非明文）→ 完全退出 → 重新启动 → 检查设置 | 设置保留、可正常使用；旧 Aika 数据不受影响（可抽查 `%APPDATA%/AAAAGENT` 未新增内容） |

### 09-B 连续文字对话、快速发送、取消后重发

| 步骤 | 通过标准 |
| --- | --- |
| 连续发 3 条以上文本；上一条回复生成中立刻再发一条；点取消后立即发新消息；填错 Provider endpoint 制造一次失败，再改正重发 | 上下文连续（回复记得前文）；无旧回复覆盖当前显示；无永久「发送中」；失败提示清楚且恢复后可继续 |

### 09-C 真麦克风说话、听取回复、停止（依赖 §2 决策完成）

| 步骤 | 通过标准 |
| --- | --- |
| 启动语音 → 对麦克风说一句固定话 → 等识别与回复语音 → 播放中再次说话或点停止 | 实际输入输出可用（识别与所说一致、语音与回复一致）；停止后旧语音不恢复；无明显漏句/乱序。听感由你判断 |

### 09-D 测试记忆、纠正和遗忘，查看 Timeline

| 步骤 | 通过标准 |
| --- | --- |
| 告知一条个人信息 → 隔几轮询问是否记得 → 纠正（「不对，是……」）→ 要求遗忘/删除 → 刷新 Timeline，重启应用再查一次 | 记得/纠正生效；已遗忘/删除来源的正文在 Timeline 与对话中都不再出现 |

### 09-E 触发一次可恢复服务错误，再恢复

| 步骤 | 通过标准 |
| --- | --- |
| 把 Provider endpoint 改为无效值 → 发送 → 观察提示 → 恢复配置 → 再发送 | 提示真实、清楚、可操作；不把静默降级当成功；恢复后可继续使用 |

### 09-F 检查 UI 与语音体验总评

| 步骤 | 通过标准 |
| --- | --- |
| 按 RPD 主交互完整走一遍：配置 → 输入文字/启动语音 → 状态可见 → 回复文本/语音 → 可停止 → 查看 Timeline | 你确认本版基本可用；缺陷与「后续增强建议」分开记录 |

**明确不在本版范围（不算缺陷）**：Live2D/桌宠表现、唤醒、音色克隆、全双工声学优化、Wiki/OCR/VLM、旧数据库导入（RPD §2）。发现顺手可用但未验收的上游功能，记为观察项，不计入本版通过标准。

## 6. 缺陷分级与闭环

- **阻塞级**（崩溃、数据破坏、串会话、取消后旧音频恢复、核心输入输出不可用）：记录后该项验收暂停，必须修复后复验。
- **一般缺陷**：记录后可继续其余项。
- **增强建议**：记入后续版本，不影响本版结论。
- 闭环规则：可自动复现的问题由 worker 先加失败回归测试再修复，跑受影响测试；涉及集成/构建的修复更新候选包并复验受影响项。修复后的候选 commit 必须与报告和包 hash 匹配，不拿旧包验收新代码。

## 7. 结果回填模板

复制到回复或写入 `reports/NEXT-09_ACCEPTANCE.md`：

```markdown
验收环境：机器/系统 ____；音频设备 ____；Provider 实际选型 ____；候选包 commit+hash ____
| 项 | 结果 | 说明/缺陷 |
| --- | --- | --- |
| 09-A | PASS/FAIL | |
| 09-B | PASS/FAIL | |
| 09-C | PASS/FAIL/BLOCKED（未配置语音） | |
| 09-D | PASS/FAIL | |
| 09-E | PASS/FAIL | |
| 09-F | PASS/FAIL | 增强建议单列 |
阻塞缺陷：____（截图/复现步骤）
结论：RELEASE_ACCEPTED / 待修复复验
```
