# UIR-02 · 角色配置与有效模型链

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：UIR-R05/R06/R07/R12。前置：UIR-01，UIR-00 冻结配置 owner。

ui/角色新 view、现有 views/skin/presentation/self-setup 模块；management 配置/发现/凭证端口；Provider Binding 与角色实际消费者的必要适配。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. 角色列表/选择来自真实实例；页面包含 General、Appearance、Persona、LLM、STT、TTS、Memory/Companion、Advanced。不新建世界书编辑器。
2. Persona 使用现有角色 Prompt 权威及 expectedRevision；明确与 Character Pack 的优先级，保存只影响后续轮次，Canon 保留。
3. Live2D/Sprite 使用既有资源导入/预览/状态映射/激活；若当前外观仅全局，补角色→资源引用及切角色消费者，不能只在浏览器保存选择。
4. 复用五层 Provider 架构：角色记录 binding 引用，全局持有来源与凭证。新增角色覆盖时先读原配置兼容默认，不重复密钥/注册中心；影响共享来源的编辑先显示受影响角色。
5. 实现端点/凭证设置、模型下拉与获取模型、手填 fallback、TTS 音色列表/手填和试听、STT 模型/设备/语言/试麦。发现/健康/真实推理各有独立状态，按 adapter 能力显示参数。
6. 写操作带 scope、expectedRevision、operationId；多 owner 保存分区报告结果，失败保留草稿。显示 saved 与 effective；不具备热切换则明确 pendingRestart，不修改当前在途轮次。
7. Memory/Companion 开关写既有角色能力许可，不签发采集授权；未交付的可选功能禁用并说明，不能假开关。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 02-A | 两个角色配置 A/B，保存/重启/切换后正式轮次使用各自 Persona/Binding，不互相覆盖 | NOT RUN |
| 02-B | 模型发现成功/失败/迟到、手填、凭证不回显；音色不跨来源混用 | NOT RUN |
| 02-C | Live2D 与 Sprite 在具备有效资产时可导入预览并实际生效；非法资源明确拒绝 | NOT RUN |
| 02-D | 并发编辑冲突和部分保存失败可恢复；现有全局配置迁移不丢值；角色许可不越权 | NOT RUN |

## 4. 验证与交接

新增 tests/ui-rework/character-config.test.mjs 与 character-binding.test.ts；复用 settings、model discovery、skin/Provider 直接测试。至少一个实际文本来源回放；真实语音/资产未提供的项目保持未验，不用 mock 代签。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-02.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

世界书和新引擎不做；已有 Pack 保留兼容入口。迁移采用新增角色覆盖/引用，保留旧默认与版本历史，验证停用覆盖后恢复。

