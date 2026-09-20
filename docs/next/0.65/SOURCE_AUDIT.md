# 0.65 源码核对与实施起点

日期：2026-09-21。只读核对当前 Windows 工作树，不是固定交付提交，不代表构建或验收通过。0.61 索引仍有待完成项；K65-00 必须重新核对实际交付证据，不能将本次工作树当作已交付基线。

| 已读取路径（相对 windows/code/desktop-pet） | 实际观察 | 实施归属 |
| --- | --- | --- |
| app/trial-backend.ts | 静态引入 Emotion、Wake、WeChat、Work、ASR、视觉、TTS、SQLite、知识库等，是主要组合耦合点 | 03、04、05、06 |
| core/dialogue-pipeline.ts | DialoguePorts 强制包含 perception/tts/playback/memory/mediaStore，虽支持 outputMode=text，仍不是独立普通包 | 01、03、07 |
| core/desktop-runtime.ts、core/turn-controller.ts | Runtime 持有唯一 controller；controller 同时管理轮次和 PetPresentation，并使用默认角色标识 | 03：提取宿主机制，展示/默认身份转到产品适配，保留原行为 |
| core/live-voice-turn.ts、core/live-voice-bridge.ts | 实时输入有独立会话边界，不能为每个 chunk 执行整轮 | 06 |
| providers/slot-registry.ts、management/settings-store.ts | 已有模型绑定/配置入口，拆包不新建第二份活动配置 | 01、03～06 |
| memory/prefix-snapshot.ts、memory/knowledge-library.ts | 快照/知识库有实际文件；来源撤销等以交付测试重新核对 | 04、07 |
| package.json | 单应用依赖含 better-sqlite3、sherpa-onnx-node、silk-wasm；build 连带 WeChat，build:windows 连带 wake | 03 起拆产物及依赖，不能只改动态 import |
| tools/build-native.mjs | Windows 路径仅检查 Electron 可用，不等于生成独立可分发安装包 | 03、10 |
| tools/run-tests.mjs | default 仅 memory/providers；next/next61/windows 分组存在且有不同覆盖 | 00、10 |

已核对命令入口：npm run check、build、test:next、test:next61、test:next:real、test:windows、test:windows:ui、build:windows。本次均未执行。test:next65、独立打包及最小产物冒烟入口尚未创建，其提供者由 SPEC 指定。

K65-00 需补充动态 import、IPC、renderer、后台自启、运行清单/hash、共享 native 依赖、用户数据与现有已启用功能的完整映射。未核实符号按设计契约处理，不按文档示例盲改。

## 多源追加核对（2026-09-21）

已读取 providers/slot-registry.ts：SlotBinding 直接含 endpoint/model/credentialRef，ProviderProtocol 限定 openai-compatible/gemini；校验要求 credentialRef 非空且 TTS characterMicros 为正。当前 canServe/resolve 以槽和协议校验，不等于多来源实例生命周期。K65-01/02A 需保留已验收协议同时解除“本地也必须云端凭据/费率”的不适用限制。

已读取 providers/sapi-tts.ts：存在 Windows System.Speech 的本地合成实现及取消处理，可作为 TTS 本地真实路径候选；本次未运行，不宣称当前机器音色和回放可用。本地 LLM 服务的实际端点/部署/模型仍由 K65-00 盘点，不假设已存在。
