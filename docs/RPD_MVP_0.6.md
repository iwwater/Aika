# Aika 0.6 · Pet Shell（OpenPet Fork + Live2D 换装）— RPD v1.2（规格草案）

> 2026-09-15审阅修订：仅更新方案，仍待确认，未授权实施。派发与欠账口径见[审阅结论](REVIEW_DISPATCH_2026-09-15.md)。技术可行性门禁先于剪枝；不得将“拍板”理解为绕过兼容与许可核查。
>
> **2026-09-16 口径更新**：三项产品决策已定——① 位置 `f:/AIVoice/pet-shell`；② **自用不分发**；③ **MVP-12 纳入，且仅点击交互**（文件分支不适用）。据此 MVP-07/08/09/10/11 已实施并出报告、MVP-13 执行中；本文其余处出现的「待用户确认／条件占位」按本注读，MVP-12 的输入契约见 [MVP-12 明细](integration/specs/MVP-12.md)。

日期：2026-09-15。基线：`0efa11c`。需求来自用户 2026-09-15 对话：桌宠只留前端表现层，其余剪枝＋插件化＋品牌替换＋接自有后端，并新增 Live2D 换装。[SPEC 索引及 MVP-07～13 明细](integration/SPEC_MVP_0.6.md)已拆成草案，沿用 MVP 编号空间。本次仅授权修改文档，未授权实施；MVP-12 仍是条件占位。

产品称 Aiki（沿用桌宠 RPD v0.2 决策）；fork 程序在本文件中代号 **pet-shell**，正式产品名、仓库名与位置待用户决定，不由执行者在 MVP-07 内自行拍板。上游：`X-T-E-R/OpenPet` tag v0.1.6，锁定 commit `0675f493`（完整哈希、资产哈希与协议证据见 [PET-01 协议基线](frontend/reports/PET-01_PROTOCOL.md)）。

## 1. 目标与完成边界

Aiki 侧桌宠集成层（DesktopPetService / OpenPetAdapter / ProcessManager）继续作为唯一桌宠表现出口，不重写业务架构。现有四端点保持兼容；新身份/profile/可选生命周期能力允许经过登记的最小增量，不承诺配置与代码绝对零改动。上游fork为独立程序pet-shell：先核实各功能是否存在再剪枝；保留loopback HTTP、窗口表现及必要本地设置/模型选择，移除确认不需要的远程导入、更新或品牌功能。不存在的Agent/Memory不列为已删成果。shell内部建立最小插件槽，再修改菜单和增加Live2D。

0.6 冻结点：pet-shell 可替代 OpenPet 作为 Aiki 桌宠 sidecar——真机四端点链路与 PET-07 基线等价、Live2D 角色可显示、换装可演示、sprite 与 Live2D 单一出口可切换。

明确不做：Aika 主应用与对话 Runtime 重写；Memory/Wiki/OCR/感知逻辑改动；NyaDeskPet 接入（搁置，见 §9）；RAG 索引升级（backlog，§7）；音频口型（条件后置）；macOS/Linux 验证（Windows First）。

## 2. 基于当前仓库的裁决

| 提案用语 | 实施解释 |
| --- | --- |
| 只留前端实现 | OpenPet 前后端同在一个 Tauri 进程；「留前端」= 保留 WebView 表现层与薄壳（窗口/托盘/进程生命周期），Rust 侧与配置按剪枝清单裁撤。不虚构「纯前端分离」 |
| 接我的后端 | pet-shell本机loopback保留四端点和既有成功/错误语义；PET-01 fixtures作为回归基线。新增真实版本/角色profile不伪装旧上游；必要Aika兼容增量单独登记。反向通道仅在MVP-12纳入后定义，不预定WS实现 |
| 剪枝 | 逐项清单＋留证，不保留死分支；上游已实证缺失的单实例与协议退出端点由 pet-shell 补齐（上游 v0.1.6 无单实例、关窗不退出、无退出端点） |
| 自我插件化 | shell 内三个插件槽：renderer（sprite/Live2D）、menu（托盘/右键/设置页）、behavior（待机/动作策略）。每槽先有默认实现；接口在 0.6 内稳定，不承诺第三方插件生态 |
| 看不出是 OpenPet | 替换产品名、图标、安装器、托盘、菜单、关于页及示例角色的产品品牌；保留上游版权、GPL-3.0 许可文件、来源声明及必要界面展示。品牌替换不要求隐藏法律声明（§5） |
| Live2D 换装 | Cubism Core与候选显示库先核查兼容及许可，不预先锁死未经验证的组合。SPEC区分整模型切换和同模型部件换装，首版只选一种、默认本地手动；Aika下发换装另作可选增量。复用动作映射与generation原则，不照搬NyaDeskPet的WS协议 |
| LLM wiki / RAG（agentic、graph） | 用户自研；登记 backlog（§7），不是本轮执行授权 |

## 3. 架构

```text
Aiki（不改或少改）
  CompanionRuntime / Memory / Wiki / OCR / Gateway
        │ 已有公开展示事件
  DesktopPetService（契约 · 事件映射 · profile）
        │ OpenPetAdapter（兼容优先）    Sidecar 进程管理
        │ HTTP loopback · 四端点
  pet-shell（独立仓库，fork 自 OpenPet v0.1.6）
    薄壳：窗口 / 托盘 / 单实例 / 退出端点
    兼容 API：status · say · action · event
    插件槽：renderer · menu · behavior
      ├ sprite renderer（默认，上游迁移）
      ├ live2d renderer（新增，含换装槽位）
      └ 新菜单 / 设置 UI（重写）
  剪枝：仅删除上游核实存在且不需要的功能与品牌资产
```

fork 是**独立仓库**，不进 Aika 仓库、不在 aika-crossplatform 内建目录；Aika `docs/` 仍是唯一文档根，0.6 的 SPEC 与报告写在 Aika docs（归属见 §8）。跨仓契约 = PET-01 冻结 fixtures（`src/services/desktopPet/fixtures/openPetFixtures.ts`）：契约变更必须双仓同轮修订并复跑契约测试，禁止单方漂移。

## 4. 需求与 SPEC 映射

| ID | 需求 | SPEC |
| --- | --- | --- |
| MVP-R07 | 独立仓库与锁定基线、原版可复现构建、功能盘点、四端点基线、Live2D技术/分发可行性出口；通过后按清单剪枝，逐项留证 | MVP-07 |
| MVP-R08 | UI 品牌清零；菜单/设置重写；补单实例与协议退出端点；桌宠表现层不动 | MVP-08 |
| MVP-R09 | 四端点既有语义与fixtures回归一致；新身份/版本/角色映射真实；Aika最小兼容增量单列；PET-07真机复跑 | MVP-09 |
| MVP-R10 | renderer/menu/behavior 插件槽与默认实现迁移；缺插件可降级启动 | MVP-10 |
| MVP-R11 | Live2D renderer 插件、costume slot 换装、未知 motion/表情安全降级、素材许可登记 | MVP-11 |
| MVP-R12 | 双向交互（点击/拖文件 → Aika）：条件规格已列；用户选定范围后补齐输入契约与实际文件清单再派发 | MVP-12（条件） |
| MVP-R13 | 真机验收矩阵、性能测量、许可终审、MSI 打包与启动回归 | MVP-13 |

## 5. 许可与分发红线

- 保留上游许可、版权及修改/来源说明；根据实际发行方式确定对应源码提供方式，不把“保留LICENSE”当完成全部分发义务。UI品牌替换不得隐藏依法需要显示的声明。
- MVP-07先核查GPL fork与候选Live2D组件的组合可分发性，不能只分别登记许可证；有未解决条件时阻塞相关Live2D分发路径，sprite基线可独立推进。个人/小规模豁免不自动覆盖Expandable Applications，见[官方许可](https://www.live2d.com/en/sdk/license/)。本文件不作许可兼容性法律结论。
- 分发目标待确认；未确认前不宣称“可分发”。MVP-13复核已确定的发行材料，不能到该阶段才发现架构所选依赖无法按计划分发。模型素材逐项登记，来源不明不入包。

## 6. 生命周期、可靠性与隐私

沿用 [桌宠接入契约](frontend/DESKTOP_PET_CONTRACT.md)：单请求 1500ms 超时、有限发送缓冲、取消/换轮撤销本地未发指令、Aiki 退出不误杀 attach 进程。pet-shell 新增职责：单实例行为实测定义（第二实例退出；端口就绪以 `/api/status` 探测为准）、受管进程可走的协议退出端点。

状态快照字段与上游保持一致；「`recentEvents` 只记录 event 调用、say 看 `bubbleText`、action 看 `lastAction`」的通道语义在 pet-shell 如实保留；若 0.6 决定修订该语义，必须同步修订 Aika fixtures 与契约测试，双仓同轮生效。隐私不放宽：仍只发用户可见最终文本、允许动作与短状态，日志默认不记气泡正文。

协议退出是新增能力，MVP-08必须定义调用者验证与owned实例身份，attach连接没有关进程权限。若Aika消费此能力，明确ProcessManager增量与降级；否则不声称Aika会自动使用新端点。单实例需定义作用域与用户退出行为，不靠占端口猜测所有权。

## 7. Backlog（登记，非本轮执行授权）

| 项 | 说明 |
| --- | --- |
| RAG-H1 混合检索（BM25＋向量） | 用户自研线；升级前先固化评测集（LLM-05 既定门槛≥9/10，当前真实结果10/10；结果不等于门槛） |
| RAG-H2 agentic RAG | 检索规划/多跳/自判充分性；依赖 H1 |
| RAG-H3 GraphRAG | 实体关系＋社区摘要；依赖 H2 与真实语料规模 |
| KB-01 知识库文件批量导入 | [独立 SPEC 草案](llm/specs/KB-01.md)；不依赖本阶段，未派发实施 |
| MCP Server | 把 Memory/Wiki 检索、TaskCommand 暴露为 MCP 工具给外部 Agent |
| Scheduler / 主动投递 | 对应 RT-05/06 已有规划位，另行派发 |
| VLM 屏幕理解 | OCR→VLM 升级；依赖多模态成本评估 |
| 音频口型 | 对齐 PET-08-F 条件；MVP-11 不承诺 |

## 8. 验收矩阵与派发约定

| renderer | 兼容 API | Aika 宿主 | 预期 |
| --- | --- | --- | --- |
| sprite | ON | ON | 行为与 PET-07 基线等价 |
| live2d | ON | ON | 气泡/动作/表情/换装可演示 |
| live2d | 断连 | OFF | pet-shell 独立待机，不崩溃、可重连 |
| sprite↔live2d | ON | ON | 单一表现出口，无双渲染 |
| 换装 | ON | ON | 加载验证成功后提交切换，失败保留旧外观，未知项安全降级 |

执行顺序调整为MVP-07基线/可行性/剪枝→MVP-10最小插件槽→MVP-08品牌/菜单/生命周期→MVP-09兼容联调→MVP-11 Live2D→MVP-13。编号保持不变，不要求按编号数值排序。四端点回归从07起每阶段执行，09是综合出口。MVP-12若纳入，先冻结输入种类、可信身份、权限和重复请求语义，再按依赖排入，不笼统“插队”。一次一份SPEC；报告统一写integration/reports，真实/fixture分列。MVP-13与INT-03复用同一发行基线的适用证据，不重复跑无变化的全套门禁。

**待用户确认后生效**：a) 正式产品名/仓库名（文档设计可暂用pet-shell）；b) 自用还是对外分发；c) MVP-12是否纳入及具体输入范围。决定之后先执行07技术出口，再进入剪枝；本次审阅没有代替用户作上述决定。

## 9. 旧计划迁移

| 旧项 | 新裁决 |
| --- | --- |
| PET-08（NyaDeskPet 条件接入） | 用户已明确选择 Live2D 路线，且路线为 fork＋自建 renderer；PET-08 由 MVP-11 取代并搁置，其 WS 协议与音频条件保留为反向通道/口型的参考蓝本 |
| PET-01 协议基线 | 继续作为四端点契约的唯一事实来源；fixtures 同步进 pet-shell 仓库 |
| PET-02～07 交付 | 原基线证据保留，不自动覆盖 fork；MVP-09 做双端兼容复验及已登记的 Aika 最小增量，旧未测项不继承为 PASS |
| FE-27/28/29（SUPERSEDED） | 维持；渲染器在 pet-shell 内实现，不恢复 Aika 主应用自研渲染 |
| tools/live2d-pipeline | 本轮不自动恢复素材生产或ComfyUI；MVP-11消费现成已授权模型。工坊/素材流水线按TODO独立立项 |

SPEC 明细、AC、依赖与文件范围已写入[草案索引](integration/SPEC_MVP_0.6.md)。实施仍以用户后续授权和相应前置满足为条件；本次不创建 fork、不改代码、不运行设备验收。
