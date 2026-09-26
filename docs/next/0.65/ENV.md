# 0.65 本地环境变量

环境文件位于 `windows/code/desktop-pet/.env`，该文件已被 Git 忽略。首次使用时可以参考同目录下的 `.env.example`，将需要的值填入 `.env`。

Node 脚本不会自动加载 `.env`。在 PowerShell 中，从 `windows/code/desktop-pet` 目录执行：

```powershell
. .\tools\load-env.ps1
```

然后再运行需要这些变量的命令，例如：

```powershell
npm run test:next65       # K65 Mock/fixture 门禁，不需要密钥
npm run test:next:real    # 真实服务回放，要求 PET_NEXT_REAL=1
```

当前代码实际读取的真实服务变量如下：

| 能力 | 变量 | 用途 |
|---|---|---|
| LLM | `NEXT_REAL_LLM_KEY` | 真实 LLM API 密钥 |
| LLM | `NEXT_REAL_LLM_ENDPOINT` / `NEXT_REAL_LLM_MODEL` | 兼容 Chat Completions 的地址与模型 |
| STT | `PET_STREAMING_ASR_DIR` | 应用运行时的本地 sherpa-onnx 模型目录 |
| STT | `NEXT_REAL_SHERPA_DIR` | 真实 ASR/基线回放使用的模型目录 |
| STT | `NEXT_REAL_WHISPER_ENDPOINT` / `NEXT_REAL_ASR_SAMPLE` | Whisper 兼容服务与 WAV 样本 |
| TTS | `NEXT_REAL_TTS_VOICE` | Windows SAPI 语音名 |

`PET_NEXT_REAL` 默认保持为 `0`。只有在已准备好授权凭据、服务和录音样本后，才将它改为 `1` 并运行真实回放。K65 的 Mock 测试不读取这些密钥，因此可以先用 `npm run test:next65` 验证内核、包和编排逻辑。

`NEXT_REAL_LLM_ENDPOINT` 必须填写完整的 Chat Completions URL，例如 `https://example.invalid/v1/chat/completions`；只填供应商根路径（如 `/v1`）会被 ProviderTransport 的重定向保护拒绝。

当前环境变量只覆盖已有代码的读取点；新增 Provider 不应私自复用别的 Provider 的密钥名，应在对应包的文档和 `.env.example` 中登记自己的变量。
