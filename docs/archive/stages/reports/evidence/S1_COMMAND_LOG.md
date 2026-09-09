# S1 可审阅命令摘要

本文件保留命令类别、时间、退出码和可复核摘要；API Key 已脱敏，聊天正文与隐私录音未写入。

| 时间（Asia/Shanghai） | 命令/操作 | 退出码 | 摘要 |
| --- | --- | ---: | --- |
| 2026-09-10 01:39 | `npm test` | 0 | 29 test files / 287 tests passed |
| 2026-09-10 01:39 | `npm run build` | 0 | `tsc` + Vite production build passed; 2 ORT runtime files synced |
| 2026-09-10 01:39 | `git diff --check` | 0 | No whitespace errors; Git emitted only existing LF/CRLF normalization warnings |
| 2026-09-10 01:28 | `npx tsc --noEmit` | 0 | TypeScript check passed |
| 2026-09-10 01:30 | DashScope `POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，模型 `qwen-plus`，Key 为用户提供值（脱敏） | 0 | 1/1 JSON response；约 2,017 ms |
| 2026-09-10 01:30 | 同一 DashScope endpoint，前 20 条固定本地转录，逐条顺序请求 | 0 | 20/20 success；latency min/p50/p95/max = 908/1,371/2,491/2,655 ms |
| 2026-09-10 01:30 | 本机 Python MP3 frame-header 分析（用户提供的本地音频目录，路径脱敏） | 0 | 175/175 files decoded；16 kHz mono；active 594.216 s；filename timeline 606.820 s |
| 2026-09-10 01:31 | `npm run tauri build` | 1 | `cargo metadata ... program not found` |
| 2026-09-10 01:31 | `cargo test --manifest-path src-tauri/Cargo.toml` | 1 | PowerShell 无法识别 `cargo` |
| 2026-09-10 01:45 | 官方 `rustup-init.exe -y --default-toolchain stable-msvc` | 0 | 安装 `stable-x86_64-pc-windows-msvc`；`rustc 1.98.1` / `cargo 1.98.1`；用户 PATH 已加入 `%USERPROFILE%\.cargo\bin` |
| 2026-09-10 01:51 | `cargo test --manifest-path src-tauri/Cargo.toml`（显式加入 `%USERPROFILE%\.cargo\bin`） | 0 | Rust 单测 5 passed / 0 failed；debug profile 链接成功 |
| 2026-09-10 01:53 | `npm run tauri build`（显式加入 `%USERPROFILE%\.cargo\bin`） | 0 | Vite production build、Rust release、MSI 与 NSIS 均成功；生成 `Aika_0.3.0_x64_en-US.msi` 与 `Aika_0.3.0_x64-setup.exe` |
| 2026-09-10 02:02 | `npm test -- --run src/hooks/useCompanionSession.integration.test.ts` | 0 | 1 test file / 3 tests passed；新增 text `send(..., "text")` 成功展示、落库、下一轮恢复及错误/断流边界 |
| 2026-09-10 02:02 | `npm test -- --run src/hooks/useCompanionSession.integration.test.ts src/services/providerClient.test.ts` | 0 | 2 test files / 19 tests passed；S1-LLM01/02 定向证据通过 |

Provider 实际请求使用等价于以下脱敏命令：

```text
Invoke-RestMethod -Method Post \
  -Uri https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -Headers "Authorization: Bearer <user-supplied-key>" \
  -Body "model=qwen-plus; fixed local transcript; response_format=json_object"
```

这些 Provider/MP3 结果是模拟补充样本，不是实机麦克风、TTS 首音频、耳机/外放或修复前基线。此前两条 Tauri 失败记录保留为修复前证据；Rust 工具链补齐后，当前 Tauri 构建已通过。
