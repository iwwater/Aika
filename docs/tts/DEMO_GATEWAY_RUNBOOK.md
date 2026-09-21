# Aika 语音演示网关 · 运行说明

适用范围：`E:/Work/Chat_model/GPT-SoVITS/tools/tts_probe/` 下的实时语音对话网关。
TTS-08 拆分后的文件职责、启动方式与测试入口。详见
[TTS-08 验收报告](reports/TTS-08_ACCEPTANCE.md)。

## 1. 启动

```bat
D:/ANACONDA/envs/GPTSoVits/python.exe chat_gateway.py
```

或显式给 key（不读 DPAPI 保险库）：

```bat
D:/ANACONDA/envs/GPTSoVits/python.exe chat_gateway.py --api-key sk-xxx ^
    --base-url https://api.deepseek.com --model deepseek-chat
```

参数：`--api-key`（不给则从 DPAPI 解密）、`--base-url`（默认 `https://api.deepseek.com`）、
`--model`（默认 `deepseek-chat`）、`-h/--help`（TTS-08 新增，短路在凭证读取之前）。

浏览器打开 <http://127.0.0.1:9881/>。依赖三个本地服务：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 本网关 | `127.0.0.1:9881` | 标准库实现，零第三方依赖 |
| whisper-server | `127.0.0.1:8080` | GPU，large-v3-turbo-q5_0 |
| sidecar | `127.0.0.1:9880` | GPT-SoVITS，6 情绪 |

启动日志会打印 silero-vad 是否就绪（不可用时跳过非语音闸门，属安全降级）。

## 2. 文件职责

```
tools/tts_probe/
  chat_gateway.py        CLI · 服务装配 · HTTP 路由与处理器（唯一入口）
  gateway_stt.py         Whisper 传输 · 音频门禁 · 文本清理 · 语言纠偏
  gateway_session.py     Gateway：会话串行编排 · mood→style · 历史存取
  gateway_artifacts.py   STT / TTS 音频留存（只写不删）
  web/chat.html          单页前端（原 PAGE 常量，字节原样迁出）
  dialogue_chat.py       链路函数（SYSTEM_PROMPT / parse_reply / MOOD_TO_STYLE /
                         llm_chat / synth / DPAPI key）—— 未改动
```

依赖方向无环：`chat_gateway → {gateway_stt, gateway_session, gateway_artifacts, dialogue_chat}`；
`gateway_session → {dialogue_chat, gateway_artifacts}`。

**改哪个文件**：改识别策略/门禁阈值 → `gateway_stt.py`；改对话编排/重试/历史 → `gateway_session.py`；
改留存目录与格式 → `gateway_artifacts.py`；改页面 → `web/chat.html`；改路由/CLI → `chat_gateway.py`。

## 3. 关键阈值与规则（改动前先跑特征测试）

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `STT_MIN_RMS` | 250 | gateway_stt |
| `STT_MIN_SPEECH_RATIO` | 0.15 | gateway_stt |
| `STT_TOP_CONFIDENCE` | 0.60 | gateway_stt |
| `STT_LANG_WHITELIST` | ja / zh / en | gateway_stt |
| LLM 重试码 | 429/500/502/503/504，最多 2 次（1s、2s） | gateway_session |
| mood→style | 见 `dialogue_chat.MOOD_TO_STYLE` | dialogue_chat |

## 4. 测试

cwd 一律为 `E:/Work/Chat_model/GPT-SoVITS/tools/tts_probe`。

```bat
REM 全量（54 例）
python -m unittest -v test_gateway_characterization.py test_gateway_import_cli.py ^
    test_gateway_stt.py test_gateway_session.py test_gateway_artifacts.py

REM 真实浏览器验证（9 断言；需 playwright，端口 9899）
python -u gateway_browser_check.py
```

| 测试 | 覆盖 |
| --- | --- |
| `test_gateway_characterization.py` | **行为冻结**：拆分前后同一 fixture 必须逐位一致，改动后必跑 |
| `test_gateway_import_cli.py` | CLI help / import 无副作用 / 任意 cwd 取到页面 |
| `test_gateway_stt.py` | 门禁分支、阈值、文本规则、语言纠偏路径 |
| `test_gateway_session.py` | 两轮顺序、并发串行、失败释放锁、reset、重试策略 |
| `test_gateway_artifacts.py` | 留存写入与失败静默 |
| `gateway_browser_check.py` | 真实浏览器交互（fake 外部依赖） |

说明：

- 所有测试写**临时目录**（会话文件、STT/TTS 留存），不碰用户真实 `output/dialogue/session.json`；
  `test_real_session_file_untouched` 会校验真实文件前后哈希不变。
- 不启动真实 DeepSeek / whisper / sidecar，不解密凭证，不占 GPU。
- 浏览器检查需要 playwright；GPTSoVits 环境**未安装** playwright，
  请用系统 Python 3.11（`C:/Users/BAi/AppData/Local/Programs/Python/Python311/python.exe`）。
- 网关与 dialogue_chat 均为标准库实现，其余测试在任一 Python 3.11 均可跑；
  `faster_whisper`（silero-vad）缺失时人声闸门自动降级跳过。

## 5. 排查要点（已踩过的坑）

- **不要在请求路径里删文件**：滚动删除留存文件会触发 WorkBuddy `safe-delete` 拦截，
  处理线程被终止，表现为 curl `Empty reply`。留存目录自然累积，需清理时手动删。
- **回环请求要绕代理**：本机有系统代理，`_whisper_infer` 与 `/api/health` 的 whisper 探测
  必须用 `ProxyHandler({})`，否则连不上 127.0.0.1。
- **合成纯音不是人声**：真实 silero-vad 对 300Hz/440Hz 正弦判 `speech_ratio=0.0`。
  测试要跑通识别分支，需注入人声闸门（或改用真人语音素材）。
- **迟到绑定**：`Gateway` 的 `llm_fn/synth_fn` 默认在**调用时**解析 `dialogue_chat` 上的函数，
  运行期替换仍然生效；注入参数仅供测试。
- `PAGE` 已迁出为 `web/chat.html`，页面路径由 `chat_gateway.py` 位置推导，任意 cwd 可启动。
