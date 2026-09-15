# Aika 0.5 MVP 收口 — RPD v1

日期：2026-09-14。基线：`58dd1be`，实施前工作区干净。需求来自本轮用户附件；OnePet 统一指 OpenPet，不引入另一项目。执行索引：[MVP SPEC](integration/SPEC_MVP_0.5.md)。

## 目标与完成边界

Text/Voice 与获授权的 OCR 观察进入唯一 CompanionRuntime，通过统一 ContextAssembler 使用 Recent Context、Memory、Wiki/RAG，一次前台模型生成产出已有 ReplyEnvelopeV1，再由可替换 Presentation 能力展示气泡与动作。0.5 到此冻结；不增加 3D、面捕、ComfyUI、复杂情绪模型或端到端 Voice 模型。

必须同时证明：桌宠、OCR、Memory/RAG 可分别关闭；一个可选模块失败不会阻断其他模块；旧 Aika 桌宠窗口/渲染/中继彻底退出生产代码；OCR 至少一个明确陪伴演示；稳定事实可保存、Wiki 可查看编辑、检索结果进入一次模型请求。模块测试、实机、真实模型与真人语音分别验收，不以 fake 代替真实闭环。

## 基于当前仓库的裁决

| 提案用语 | 实施解释 |
| --- | --- |
| PluginHost / PluginContext / EventBus / Capability | 复用现有 kernel/plugin/registry；增加可选能力生命周期控制，不另建第二内核，不修改现有核心插件启动失败回滚语义 |
| OnePet 剪枝 | 裁剪 Aika 的接入依赖与公开能力，维持原版 OpenPet Sidecar；不把上游源码、窗口、设置、updater 搬进仓库，也不为剪枝先 Fork |
| PetApp.tsx / petWindow.rs 降级 | 它们是 Aika 旧自研代码，不是 OpenPet 内部实现；迁移有效业务交互后删除，不伪装成新插件 |
| ObservationEvent | 采用版本化、受限语义事件；保留现有 EnvironmentEvent 无原文约束，OCR 自由文本仍走独立获授权 ScreenContextSource |
| Memory Wiki + RAG | 扩展现有 MemoryRepository、Knowledge/ContextSource；不新建重复数据库或第二套模型回复协议 |
| ONE LLM CALL | 一次前台生成包含回复、情绪动作与记忆候选；检索/规则不额外调用模型。失败重试单列物理attempt；后台记忆维护不得假装计入一次调用保证 |

## 架构

```text
主窗输入 / Voice                  OCR Provider（可停）
        │                       │ 受限 Observation
        │                 ContextSource / 规则门禁
        └────────────┬──────────┘
              CompanionRuntime
                    │
          ContextAssembler（源失败降级）
            Recent + Memory + Wiki
                    │ 一次前台生成
             ReplyEnvelopeV1
                    │ 公开表现投影
           Presentation capability
                    │ Adapter / HTTP
              OpenPet 外部进程
```

Kernel 事件只表示内核生命周期，禁止混入 OCR 文本或对话轮次。观察与表现使用所属模块的类型化端口/订阅，接收方通过依赖注入使用。关闭桌宠不关闭观察；OCR 不直接 import 桌宠；Memory 不 import 两者的实现。

## 需求

| ID | 需求 | 归属 |
| --- | --- | --- |
| MVP-R01 | 复用插件注册，有限启停、健康状态、失败隔离；不向插件暴露 AppState/Tauri State | MVP-01 |
| MVP-R02 | 外部桌宠以manifest/adapter/lifecycle表示，核心消费者不识别OpenPet协议；独立停用/恢复 | MVP-02 |
| MVP-R03 | 删除旧pet生产分支、窗口命令、渲染、中继、UI与自动恢复；保留主窗陪伴业务入口 | MVP-03 |
| MVP-R04 | ROI/前台窗口→OCR→去重→语义观察→上下文/策略→Agent；关闭撤销迟到结果 | MVP-04 |
| MVP-R05 | 七场景隔离矩阵与真实进程边界；失败源不拖住回答 | MVP-05 |
| MVP-R06 | L0最近会话、L1可溯源稳定事实、L2可编辑Wiki，Top-K检索、开关与一次生成 | MVP-06 |

## 生命周期与故障

可选能力有 off/starting/running/stopping/failed 状态及健康快照。start/stop并发有确定行为，失败不自动无限重试；stop撤销当前generation，旧启动完成不能复活已关闭能力。释放自身订阅/定时器，停止只作用于自身资源。

逻辑隔离可由同进程测试证明；外部OpenPet进程崩溃的OS隔离需设备证据。OCR worker故障可恢复，原生抓屏与Aiki同进程，不能宣称能隔离任意native进程崩溃。RAG超时走现有源级deadline，保留Recent Context并照常回答。

OpenPet关闭不复活旧桌宠；未核实的 hideBubble/position/clickThrough/setVisible 不虚构为上游API。0.5支持的表情由情绪→已验证动作映射实现，不声称原生Live2D表情。

## OCR 与记忆数据边界

复用已存在授权、暂停、quiet、busy、锁屏、频控与单一发送预约。观察事件只带受控规则ID、source、事件ID、时间和置信度；自由文本不能因增加EventBus越过授权边界。支持一个固定非私人Demo词（如PENTAKILL或build failed），不要求游戏安装。

OCR内容视作未可信参考资料，不是系统指令。原图/原始OCR不自动入长期记忆；候选需既有确认/写入规则，记录来源与scope。关闭Memory禁止长期读写（Recent会话仍可用），关闭RAG禁止额外检索，恢复后按当前开关重新校验在途结果。Wiki支持查看、编辑、删除及可溯源稳定条目；不把一次屏幕文本直接升级为稳定事实。

## 验收矩阵与收口

| Pet | OCR | Memory/RAG | 预期 |
| --- | --- | --- | --- |
| ON | ON | ON | 一次生成、完整表现 |
| OFF | ON | ON | Agent/观察/记忆继续，零桌宠请求 |
| ON | OFF | ON | 普通聊天继续，无观察采集与迟到注入 |
| ON | ON | OFF | Recent会话继续，长期读写和检索关闭 |
| Crash | ON | ON | Aiki仍可回答，桌宠可显式重连 |
| ON | Crash | ON | 桌宠与聊天继续，观察降级 |
| ON | ON | RAG Fail | Recent fallback；一次前台生成，无错误原文注入 |

MVP-01→02→03→04→05→06顺序执行；最后用06补跑包含真实Wiki/RAG的05矩阵。每份记录独立AC，真实演示缺条件则写NOT RUN/BLOCKED，继续不依赖它的模块工作。旧PET报告为基线证据；**2026-09-15 更新**：原文「尤其PET-07的Aiki宿主侧未测结论保留」已失效——PET-07 的 Aiki 宿主侧已于 09-15 补强为 **A/B PASS（device）**（`pet_command` 证 event/emotion/say 三条全部 accepted），PET-07 的 C/G/H/I 仍 NOT RUN、D/E/F/J 部分 PASS，见 [PET-07 报告](frontend/reports/PET-07_ACCEPTANCE.md)。发布、push及新增付费服务不在本次范围。
