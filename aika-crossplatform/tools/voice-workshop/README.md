# Aika Voice Workshop

这是 Aika 的个性化声线工具包骨架。它与桌面聊天程序分开运行，目标是把“整理录音 → 检查数据 → 训练 → 导出角色声线”做成一条简单流程。

当前阶段只提供项目模板和本机环境检查，不会自动下载模型，也不会开始训练。这样可以先稳定聊天与实时语音底座，之后再接 Style-Bert-VITS2 等训练后端。

## 目录约定

```text
voice-workshop/
├─ input/       原始录音与文本（不提交 Git）
├─ workspace/   切分、降噪和训练中间文件（不提交 Git）
├─ export/      可导入 Aika 的 voice.json 与模型文件（不提交 Git）
├─ config.example.json
└─ scripts/
   └─ Test-VoiceWorkshopEnvironment.ps1
```

## 先做环境检查

在 PowerShell 中运行：

```powershell
cd tools/voice-workshop
./scripts/Test-VoiceWorkshopEnvironment.ps1
```

检查项包括 Python、Git、FFmpeg 和 NVIDIA GPU。缺少 GPU 不影响使用 Aika，只会影响后续本地声线训练速度。

## 计划中的一键流程

1. `prepare`：检查录音格式，生成文本清单。
2. `clean`：静音切分、重采样、响度和异常片段检查。
3. `train`：调用选定的训练后端，并记录可复现参数。
4. `preview`：用几句固定日语试听，比较不同检查点。
5. `export`：生成角色包可识别的 `voice.json` 和模型目录。

训练素材必须来自本人或已明确授权的声音，不将冒充、骚扰或规避他人同意作为工具包能力。

