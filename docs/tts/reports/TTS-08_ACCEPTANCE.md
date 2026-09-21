# TTS-08 验收报告 · 独立语音演示网关职责拆分

日期：2026-09-21（拆分验收）；2026-09-22（真实网关启动补证）。规格：[TTS-08](../specs/TTS-08.md)。优化入口：[VOICE_RESEARCH_OPTIMIZATION.md](../../VOICE_RESEARCH_OPTIMIZATION.md)。
**最终结论：PASS**——拆分前后行为逐位一致（54 测试 + 浏览器 9/9），真实网关生产冒烟通过（页面哈希==基线、真实 STT 经 turbo 转写、用户会话文件未动）。
工作根：`E:/Work/Chat_model/GPT-SoVITS/`；文档写回 Aika 仓库 `docs/tts/`。

环境（2026-09-21 原拆分验收）：
- Python：`C:/Users/BAi/AppData/Local/Programs/Python/Python311/python.exe`（3.11.9）。
  网关与 dialogue_chat 均为标准库实现，不依赖特定环境；
  **浏览器检查必须用这个解释器**——GPTSoVits 环境（`D:/ANACONDA/envs/GPTSoVits/python.exe`，3.11.16）**未安装 playwright**。
- 该轮无真实模型推理、无 DeepSeek / whisper / sidecar 真实调用、无凭证解密、无 GPU 占用；
  生产网关（9881）、whisper-server（8080）、sidecar（9880）在验收期间**仍在运行且未被重启**。
- 2026-09-22 补证轮环境见 [AC-B 补证段](#acb--pass含-not-run-项→已全部补证)（生产环境实跑，读 DPAPI、真实 STT）。

## 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `-m unittest -v test_gateway_characterization.py`（**拆分前**基线） | `E:/Work/Chat_model/GPT-SoVITS/tools/tts_probe` | 0（Ran 24 tests，OK） |
| `-m unittest -v test_gateway_characterization.py`（**拆分后**同一文件未改） | 同上 | 0（Ran 24 tests，OK） |
| `-m unittest -v test_gateway_characterization.py test_gateway_import_cli.py test_gateway_stt.py test_gateway_session.py test_gateway_artifacts.py` | 同上 | 0（Ran 54 tests，OK） |
| `-u gateway_browser_check.py`（真实浏览器，端口 9899） | 同上 | 0（9/9 PASS） |
| `-m py_compile`（10 个 .py） | 同上 | 0 |

浏览器截图证据：`docs/tts/reports/evidence/tts08/`（`e1_text_round.png`、`e2_reset.png`、
`e3_voice_round.png`、`e4_correction.png`、`e5_non_speech.png`）。

## 基线（拆分前取证）

| 项 | 值 |
| --- | --- |
| `chat_gateway.py` sha256 | `80b3f0996fec259d4b5a2b33a9042ad1637528af5386e265eb39197b29808ae3`（946 行） |
| `dialogue_chat.py` sha256 | `83f58e4bc9c62cd316e3ae0ade7dee0a9cfaa76a364bf0859ee91b48d043468c` |
| 页面 `PAGE` sha256（16568 字节 UTF-8） | `6fad10b8cae189d6e4ddb7026cfae1348e3f8234f34e93a15be6ef1372033104` |
| 用户真实 `output/dialogue/session.json` sha256（前 16） | `6d4c523b35b8e09b`（12857 字节） |

拆分后复核：`dialogue_chat.py` 哈希**未变**（未改动）；
`web/chat.html` 哈希 == 页面基线（字节原样迁出）；
用户真实 `session.json` 哈希**未变**（所有测试只写临时目录）。

## 逐 AC 结论

### AC-A · PASS（拆分前后同一 fixture 输出逐位一致）

`test_gateway_characterization.py` 先在与拆分前**完全相同的单体源码**上跑通（24/24），
拆分后**不修改该文件**再跑（24/24）。只替换外部依赖：whisper-server / sidecar 为本地假
HTTP 服务，LLM 与合成函数打桩；路由、处理器、门禁、纠偏、映射、持久化、响应组装全部走生产代码。

冻结的边界（各一条以上断言）：

| 边界 | 证据 |
| --- | --- |
| 页面 | `/` 与 `/index.html` 字节哈希 == 基线 |
| `/api/health` | 字段集 `{sidecar,whisper,history,model,base_url}`，sidecar/whisper 均 True；响应体不含 api_key |
| `/api/stt` 正常 | 响应恰为 `{"text": "こんにちは"}`；whisper 只被调用 1 次（auto） |
| `/api/stt` 低能量 | `{"text":"","low_energy":true,"rms":0.0}`，whisper 0 次调用 |
| `/api/stt` 非语音 | `{"text":"","non_speech":true,"speech_ratio":0.02}`，whisper 0 次调用 |
| `/api/stt` 真实 VAD | 不补丁走真实 silero-vad：合成纯音 → `speech_ratio=0.0`（另立一条冻结真实闸门行为） |
| `/api/stt` 空体 / 上游不可达 | 400 `{"error":"empty audio"}` / 502 `语音识别服务未连接…` |
| `/api/chat` 正常 | 字段集 `{reply,mood,style,audio,llm_ms,synth_ms}`；audio 为合成 wav 的 base64；会话文件写入 user/assistant 两条 |
| `/api/chat` 空消息 / 坏 JSON | 400 `empty message` / 400 `bad json` |
| `/api/chat` 降级分支 | LLM 失败 → 200 + `{"error":"LLM 调用失败: boom"}`；合成失败 → `{"error":"声线合成失败: …"}`；均不写历史 |
| `mood→style` | 7 个 mood 全覆盖（neutral/gentle_smile/happy/shy/surprised/thinking/concerned） |
| 文本清理 | 幻听整句命中、`[BLANK_AUDIO]`/`(music)`、句首填充语删除、`あの人` 不误删 |
| 语言纠偏 | 小语种→强制 ja、摇摆且含假名→保留、ja 无假名→强制 zh、空转写→不重跑（均校验 whisper 调用序列） |
| 留存 | STT wav + `samples.jsonl`、TTS wav + `tts_log.jsonl` 写入**临时**目录 |
| reset | `{"ok":true}`，历史清空，`/api/health.history` 为空 |
| 404 | `{"error":"not found"}` |
| 用户文件 | 真实 `session.json` 前后哈希一致 |

非稳定时间字段（`llm_ms`/`synth_ms`）只验「int 且 ≥0」，不比数值。

### AC-B · PASS（真实启动已补证）

- `chat_gateway.py --help` → 退出 0，打印用法，**不解密 DPAPI**（断言输出不含「已从 DPAPI 解密」）。
  拆分前 `--help` 会走到 `load_key_from_secrets`；本次把 `-h/--help` 短路在凭证读取之前（纯新增，
  不影响其他参数路径）。
- `dialogue_chat.py --help` → 退出 0（argparse 原样）；两个 CLI 均在**非工具目录**的 cwd 下运行。
- 模块 import 无副作用：`gateway_stt / gateway_artifacts / gateway_session / chat_gateway`
  重新导入期间，`load_key_from_secrets`、`urlopen`、`build_opener` 全部替换为「调用即断言失败」的哨兵 → 全绿。
- 任意 cwd 可取到页面：`os.chdir` 到临时目录后起服务（fake 依赖），`/` 与 `/index.html`
  均返回页面基线哈希（路径由 `chat_gateway.py` 文件位置推导）。
- **真实 `serve_forever` 启动**：原验收时因「生产 9881 被占用 + 会读 DPAPI」记 NOT RUN；
  **2026-09-22 已生产冒烟补证 PASS**——9881 空闲后，用生产环境（conda python）按
  [RUNBOOK](../../DEMO_GATEWAY_RUNBOOK.md) 原样启动真实网关：1 s 内可连接、`GET /` 逐字节等于
  PAGE 基线（sha256 `6fad10b8…`）、`/api/health` 显示 sidecar/whisper 双真（两上游恰为当日的
  CUDA turbo 8080 与 sidecar 9880）、真实历史 91 条加载（仅计数）；**真实 STT 两段真人素材正确转写**
  （619/432 ms，走真实双闸门 + 语言仲裁 + beam5）。用户 `session.json` 前后哈希一致
  （`6d4c523b35b8e09b`），未调 `/api/chat`（避免真实 LLM 费用，且 LLM 全链路不在本 SPEC 范围）、
  未调 `/api/reset`。DPAPI 读取成功的判定依据：密钥加载失败会使进程在绑端口前退出，而服务正常
  绑定并服务了 4m37s（启动横幅因 stdout 块缓冲未及刷盘，如实注明）。
  证据：[`evidence/tts08/real_gateway_smoke.json`](evidence/tts08/real_gateway_smoke.json)。
  取证坑：`/api/stt` 契约是**裸 wav 字节体**（浏览器 blob 直传），发 multipart 会被优雅降级为
  空文本——这是设计行为，不是缺陷。

### AC-C · PASS

真实 HTTP 处理器（`/api/stt`、`/api/chat`、`/api/health`、`/api/reset`）+
fake Whisper / fake LLM / fake TTS 覆盖：正常对话、空输入、上游失败、低能量、非语音、
reset —— 形状与状态码保持基线（见 AC-A 表）。新增定向用例 25 条
（`test_gateway_stt.py` 11 + `test_gateway_session.py` 9 + `test_gateway_artifacts.py` 5）全绿。

### AC-D · PASS

- 两轮对话顺序正确：会话文件 `user/assistant/user/assistant`，第二轮请求的 messages 带第一轮历史、
  不出现串轮（`test_two_rounds_in_order`）。
- 并发仍串行：事件屏障挂起首轮，第二个线程自报「已发起」后主线程才放行 →
  `inside` 计数器从未出现 >1（`test_concurrent_requests_are_serial`）。
- 失败释放锁：首轮 LLM 抛错 → 返回 `{"error": …}` → 下一轮照常处理并写入历史。
- reset 后新轮不带旧历史（`test_reset_clears_history_for_next_round`）。
- 重试策略：503 → 重试至第 3 次成功，`sleep` 注入记录到 `[1.0, 2.0]`（不真等）；
  401 → 只调 1 次；500 连续失败 → 第 3 次带最后一次错误体返回。
- 用户真实文件哈希不变（`session.json` `6d4c523b35b8e09b` 前后一致）；所有历史写入临时目录。

### AC-E · PASS

真实浏览器（Playwright + Chromium headless，端口 9899）+ fake 外部依赖，全部经页面点击：

```
[PASS] AC-E 页面加载 + 健康检查显示  | 声线✓ · 语音识别✓
[PASS] AC-E 文本发送 → 回复 + 音频展示  | 亲密 · shy えへへ、嬉しいな LLM 0ms · 合成 0ms
[PASS] AC-E 音频元素已渲染  | audio=1
[PASS] AC-E 清空按钮生效  | 剩余 1 条
[PASS] AC-E reset 清空会话历史  | session 已空
[PASS] AC-E 受控音频 → 转写用户消息  | こんにちは（/api/stt 调用 1 次）
[PASS] AC-E 纠错入口可操作（✎）  | 按钮 1 个
[PASS] AC-E 纠错后重新对话  | LLM 收到：こんにちは / こんにちは / おはよう
[PASS] AC-E 非语音分支提示未识别  | （没听清你说的，再试一次？）
```

麦克风用**受控音频**（`add_init_script` 把 `getUserMedia` 换成 440Hz 振荡器流，响 1.2s 后静音），
走真实采集管线（ScriptProcessor → RMS → 静音判定 → `/api/stt`）；
人声闸门注入 0.6（合成纯音不是人声，真实 silero 会判 0%）。
**NOT RUN**：真实麦克风/扬声器音质、实际听感，维持未验证状态。

### AC-F · PASS

- `_has_kana` **单一定义**：全目录 `def _has_kana` 只出现在 `gateway_stt.py`（1 处）。
- 旧 `PAGE` 不再复制保留：页面字节原样迁到 `web/chat.html`；`chat_gateway.py` 中
  「PAGE」仅出现在说明文档字符串里的一句话，无第二份页面内容。
- 依赖图（无环）：

```
chat_gateway.py（CLI / 装配 / 路由）
  ├─ gateway_stt.py       Whisper 传输 · 音频门禁 · 文本清理 · 语言纠偏（纯标准库；faster_whisper 运行时可选）
  ├─ gateway_session.py   会话串行编排 · mood→style · 历史存取
  │    ├─ dialogue_chat.py    SYSTEM_PROMPT / parse_reply / MOOD_TO_STYLE / llm_chat / synth
  │    └─ gateway_artifacts.py  TTS 音频留存
  ├─ gateway_artifacts.py  STT / TTS 音频留存（纯标准库）
  └─ dialogue_chat.py      key 来源（load_key_from_secrets）+ 默认合成实现
```

- 原录制工具兼容性：全仓检索 `chat_gateway` / `9881`，除本仓库文档外**无任何脚本引用**该网关或页面 →
  无录制脚本需要回归（已核实，非假设）。
- 清理的死代码（拆分时确认无调用方）：`_avg_logprob`（废弃的跨语言 logprob 仲裁遗留）、
  `STT_SHORT_LEN`（同一条废弃路线的短句阈值）、`import glob`（从未使用）；
  同时更新了「多路 logprob 仲裁」相关的过期注释说明。

## 变更清单（两个仓库分别列出）

### GPT-SoVITS 仓库（`E:/Work/Chat_model/GPT-SoVITS/tools/tts_probe/`）

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `chat_gateway.py` | 改 | 946 → 199 行；仅保留 CLI、服务装配、HTTP 路由与处理器；新增 `--help` 短路；`make_handler(gw, transcribe=None)` 支持测试注入；保留 `SIDECAR_URL/WHISPER_URL/SESSION_FILE/stt/clean_whisper/wav_rms/wav_speech_ratio/save_stt_sample/Gateway` 等旧名字的引用 |
| `gateway_stt.py` | 新增（313 行） | Whisper 传输、音频门禁、文本清理、语言纠偏 |
| `gateway_session.py` | 新增（155 行） | Gateway 会话编排；外部调用可构造注入，默认**迟绑定**生产函数（保行为） |
| `gateway_artifacts.py` | 新增（68 行） | STT/TTS 音频留存，只写不删 |
| `web/chat.html` | 新增（367 行） | 原 `PAGE` 字节原样迁出 |
| `test_gateway_characterization.py` | 新增（24 例） | AC-A 行为冻结（拆分前后共用） |
| `test_gateway_import_cli.py` | 新增（6 例） | AC-B |
| `test_gateway_stt.py` | 新增（11 例） | AC-C |
| `test_gateway_session.py` | 新增（9 例） | AC-C/D |
| `test_gateway_artifacts.py` | 新增（5 例） | AC-C |
| `gateway_browser_check.py` | 新增（9 断言） | AC-E |
| `dialogue_chat.py` | **未改动**（哈希不变） | — |

### Aika 仓库（`E:/Work/AI CHAT/`）

| 文件 | 状态 |
| --- | --- |
| `docs/tts/reports/TTS-08_ACCEPTANCE.md` | 新增（本报告） |
| `docs/tts/DEMO_GATEWAY_RUNBOOK.md` | 新增（运行说明） |
| `docs/tts/reports/evidence/tts08/*.png` | 新增（浏览器截图 5 张） |
| `docs/VOICE_RESEARCH_OPTIMIZATION.md` | 状态行更新 |
| `docs/tts/specs/TTS-08.md` | 状态行更新 |

## 接口影响

- 路由 `GET /`、`/index.html`、`/api/health`，`POST /api/stt`、`/api/chat`、`/api/reset` 全部保留；
  成功字段与错误 `detail` 形状不变；默认 loopback 与端口 9881 不变；`--api-key/--base-url/--model` 不变。
- 新增仅：`chat_gateway.py -h/--help`（原行为是去读 DPAPI，无既有用法被破坏）。
- 语义未改：mood/style 映射、日语优先策略、提示词、幻听规则、门禁阈值、预卷与静音时长、
  会话锁串行语义、reset 行为、LLM 重试策略。
- 未触碰：`aika_tts_server.py`、GPT-SoVITS 上游、权重、voice 配置、真实 session/录音、
  密钥文件、Whisper 部署、`aika-crossplatform/`。

## 未运行项（最终口径）

- `chat_gateway.py` 真实 `serve_forever` 启动：**已补证 PASS**（2026-09-22 生产冒烟，见 AC-B；
  DPAPI 读取属服务正常生产行为，非测试 fixture，无密钥材料进入任何产物）。
- 真实麦克风 / 扬声器音质、人工听音 → NOT RUN（需用户在场；属设备/听音验收，不在本 SPEC）。
- 真实 DeepSeek、真实 sidecar 全链路 → 不在本 SPEC 范围
  （真实 whisper STT 链路已在补证中顺带打通；LLM 与 TTS 仍属 INT/后续范围）。
- 未执行 git add/commit（SPEC 要求：不自动提交；后续按交付批次另行提交）。
- 本项通过仅表示**演示工具保行为重构完成**，不代表识别质量、全链路延迟、人工听音或 TTS-06-F 已通过。
