# Aika 角色包规范 v1

角色包是一个普通目录或 ZIP 文件，描述一个角色的身份、外观、声音和情绪映射。用户拥有角色包中的所有资源，或已获得相应使用授权。

## 目录结构

```text
my-character/
├─ character.json
├─ avatar.png
├─ live2d/
│  └─ model.model3.json
└─ voice/
   ├─ voice.json
   └─ models/
```

只有 `character.json` 是必需文件。Live2D 和语音可以后续补充。

角色美术生成与 Live2D 制作流程见 [COMFYUI_LIVE2D_WORKFLOW.md](COMFYUI_LIVE2D_WORKFLOW.md)。角色包只接收已经完成素材权利确认、PSD 分层检查和 Cubism 导出的运行时文件，不直接接收 ComfyUI 单张图片。

## character.json

```json
{
  "schemaVersion": 1,
  "id": "aika.default",
  "name": "愛花",
  "reading": "あいか",
  "description": "温暖、自然的日语聊天伙伴",
  "systemPrompt": "默认使用自然日语交流……",
  "greeting": "おかえり。今日はどんな一日だった？",
  "preferredLanguage": "ja-JP",
  "avatar": "avatar.png",
  "live2d": {
    "model": "live2d/model.model3.json"
  },
  "voice": {
    "manifest": "voice/voice.json"
  }
}
```

资源路径必须是包内相对路径，不允许访问角色包之外的文件。导入前需要验证 ID、版本、文件存在性和路径安全。

## voice.json

```json
{
  "schemaVersion": 1,
  "engine": "style-bert-vits2",
  "displayName": "Aika JP",
  "language": "ja-JP",
  "endpoint": "http://127.0.0.1:5000",
  "model": "Aika",
  "speakerId": 0,
  "defaultStyle": "Neutral",
  "styles": {
    "happy": "Happy",
    "gentle": "Neutral",
    "sad": "Sad"
  }
}
```

首版语音模型由独立本地进程运行，角色包只保存连接方式和模型标识，不把 Python 运行环境复制进每个角色包。
