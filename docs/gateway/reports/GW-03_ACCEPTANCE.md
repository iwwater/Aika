# GW-03 · Telegram 语音与文件入口 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实语音/音质独立人工队列）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/gateway/attachmentPipeline.ts`（新增） | `validateAttachmentFile`（路径穿越/绝对路径/盘符/UNC/控制字符/超长文件名拒绝；大小上限 10MB；白名单=纯文本/Markdown/JSON/受支持音频——可执行扩展名即使声明 text/ 也不放行）；`isAudioAttachment`；`buildControlledDownloadUrl`（只由 fileId 构造平台地址，禁止任意 URL）+ `assertAllowedDownloadHost`（重定向后再次白名单校验）+ `downloadWithLimits`（超时/超大/坏主机/http 错误/中止五类显式拒绝）；`AudioTranscriptionPort` + `createFileTranscriptionPort`（STT 拥有的文件转写端口：注入 `decodeToPcm16kMono` 解码/重采样边界 → 复用 WhisperClient（16kHz 单声道 Float32Array）；无客户端=明确 `unsupported`，不偷偷降级）；`extractTextAttachment`；`createTempAttachment`（dispose 清零——取消清理责任冻结在契约上） |
| `docs/modules/CONTRACTS.md` | 登记 GW-03 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/gateway`（含 attachmentPipeline.test 10 用例） | 0 | 全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 104 文件 1226 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### GW-03-A：大小/MIME/下载超时/路径穿越/恶意文件名拒绝

校验矩阵逐条断言：`../`、反斜杠、`C:\` 盘符、UNC、`\u0000` 控制字符、255+ 长名、11MB 超限、`.exe`/`.bat`（即使声明 text/）全部拒绝；`note.txt`/`doc.md`/`data.json`/`audio/ogg` 通过。下载：重定向到白名单外主机 → `bad-host`、超大 → `too-large`、传输异常 → `timeout`、非 200 → `http-error`。

### GW-03-B：识别失败不伪造文字；取消清理临时文件

`decode-failed`/`empty`/`aborted` 三种失败各自如实返回 reason，任何路径都不产出编造文本；abort 在解码前/后两处检查；`createTempAttachment.dispose()` 清零缓冲（真实宿主的临时文件删除实现同一契约）。

### GW-03-C：语音及文本均共用 Runtime 且来源一致

语音与文本都经 GW-01 的同一条 `GatewayRuntimePort.submit`（同一 conversation scope、同一 principal 解析、同一来源标记）——Gateway 层无第二入口。实值验证：固定容器字节 → 注入解码边界按序产出 16kHz 单声道样本（fake ASR 断言收到真实解码值 `[≈-0.5,…]`，非占位符）→ 转写文本返回。麦克风端口（`SpeechInputEngine`）零接触——文件端口与麦克风在类型与实现上完全分离。

### GW-03-D：真实语音/音质独立人工队列；附件正文不泄漏至群回复

真实 Whisper 音质、真实 OGG/Opus 解码、真实平台下载 NOT RUN → 独立人工队列（ WhisperClient 真实凭证缺失，与 LLM-05 AC-D 同批）。附件正文不泄漏至群回复：回复目的地由 GW-01 目的地绑定（outbox 断言）+ RT-02 会话隔离（群会话独立 scope、不进个人上下文）双重保证；附件派生内容按 RT-04 走 untrusted-material 分级。

## 未执行 / 待人工

- 真实音频解码器（OGG/Opus → 16kHz PCM）、真实 Whisper 音质、真实平台下载——NOT RUN，音质独立人工队列。
- image/PDF/office/压缩包明确不支持（白名单拒绝），无计划内解析。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表语音文件入口可用。
