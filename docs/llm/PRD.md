# LLM 文本与角色核心 · 模块 PRD

产品依据：[总 PRD](../PRD_V0.4.md)。本文件是模块边界，执行任务见 [SPEC 索引](SPEC.md)。

## 目标

接收文本、保持同一角色，使用可追溯 Context/Memory/Knowledge 生成流式结构化回复。

## 范围

- 负责：Provider、Soul/Mode、Runtime、Context、Memory/User Soul、RAG 与持久化。
- 不负责：STT 录音、TTS 播放、页面布局、Live2D。
- 依赖通过 [共享契约](../modules/CONTRACTS.md) 注入；另一模块未上线时以 fake/mock 实现，不耦合其真实服务。

## 开发方式

把本模块任务按独立 SPEC 执行；每份只列必要输入输出、边界、AC 与定向测试，不重复总 PRD。当前小阶段只测试本模块；必须联调或大任务完成后才进行全流程调试。验收报告与证据存放本目录 reports/。

模块完成与全产品完成分别标记。真实模型/音频/设备样本不能由 fixture 冒充；旧后置能力继续保持 DEFERRED。具体执行要求见 [测试规则](../modules/TESTING.md)。
