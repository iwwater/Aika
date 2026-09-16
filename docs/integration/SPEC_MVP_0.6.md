# Aiki 0.6 · Pet Shell SPEC 索引（草案）

依据：[RPD v1.2](../RPD_MVP_0.6.md)。2026-09-15 文档修订。

**执行状态（2026-09-15 更新）**：用户已拍板三项决策（位置 `f:/AIVoice/pet-shell`、自用不分发、MVP-12 纳入且仅点击交互）并授权执行全部未完成 SPEC。

- [MVP-07](reports/MVP-07_ACCEPTANCE.md)：**A～E PASS**（基线与可复现构建、四端点/功能盘点、Live2D 技术出口、剪枝、可推进范围）。
- [MVP-10](reports/MVP-10_ACCEPTANCE.md)：**A～E PASS**（renderer/behavior/menu 三槽与默认实现迁移）。
- [MVP-08](reports/MVP-08_ACCEPTANCE.md)：**A～F PASS**（品牌替换、菜单入口、单实例、退出语义、协议退出鉴权、回归）。临时标识 PetShell / `dev.aiki.petshell`。
- [MVP-09](reports/MVP-09_ACCEPTANCE.md)：**A/B/C/D/F PASS，E PARTIAL**——`product`/`capabilities` 识别、版本绑定、owned-only 协议退出与回退、三通道与双仓 fixture 同步已落地；**屏幕可见层未跑**，故本 SPEC 尚未整体收口。
- MVP-11：**A～F PASS**（Live2D renderer 与首版换装，Windows 真机 + WebDriver 取证；见 [MVP-11 报告](reports/MVP-11_ACCEPTANCE.md)）。
- MVP-13：**报告 AC-D/E/F PASS，A/B/C 部分**（[MVP-13 报告](reports/MVP-13_ACCEPTANCE.md)）——MSI 构建/启动/重开、四端点逐项复测、Live2D 在 release 产物的可见表现（像素证据）、10 分钟待机与 30 次交互均已取；三个缺陷 **DEF-1/2/3 全部处置**（DEF-1 由 MVP-14 修复，DEF-2/DEF-3 在本份内修复复验）；**AC-F 安装/卸载已于 2026-09-16 授权补测 PASS**（安装副本 903 ms 就绪、四端点 200、卸载残留清零、用户数据 41 文件不变）。**遗留**：`attach`/断连恢复、FPS 侧证据、Cubism Core 分发条件核查，以及「安装模式 per-machine vs per-user」需产品决定（现为 per-machine，要求提权）。
- MVP-12：**A～E PASS**（仅点击范围；[报告](reports/MVP-12_ACCEPTANCE.md)）——反向点击通道双仓落地：实例级一次性凭据（成对注入、attach 零携带）、版本封闭、按 `eventId` 去重、回环 only；**真人操作已闭合**（真实鼠标点击 → 宠物判定 → POST 到 Aiki 注入的 URL → 受理恰好一次）；撤销迟到输入实测 `unarmed:1` 且 `accepted` 不回退。偏差两项（实例身份由凭据承载而非报文字段、`eventId` 非 RFC UUID）与三项未闭合（单实例转交、真实断连分支、真实链路双击边界）见报告 §7。AC-D 按范围冻结记「不适用」。
- KB-01：**NOT RUN**，仍未派发实施。
- MVP-15：**B 已实现（模块 + 接线），端到端待耳验**（[点击的 Aika 侧语义](specs/MVP-15_CLICK_CONSUMER.md)）——2026-09-16 用户选 **B（受限轻量回应）**：点击 → 固定短语池的一句（不调 provider）× `canSend` 终审 × ≥30s 冷却 × 不排队 × 不打断 × 不冒错。核心模块 `clickReaction.ts`（11 项）+ 接线插件 `petClickReactionPlugin`（8 项，真实内核）已就位，全量 156 文件 / 1701 项通过。新增两个 Presenter 方法：`CompanionPresenter.canSpeakAside()`（复用同一份 canSend，不建轮）与 `VoicePresenter.speakAside()/isSpeaking()`（复用同一队列，不叠话）。**仍待验证**：真实应用里点一次桌宠由人耳确认她开口。C（对话入口）/D（在场信号，带隐私风险）未采用，D 建议单独立项。
- MVP-14：**A～F 全 PASS**（[报告](reports/MVP-14_ACCEPTANCE.md)）——**DEF-1 已消除**：官方示例模型移出分发包（exe −7,883,776 B、MSI −7,938,048 B，exe 内模型标记 0 命中而 Core 仍 1 命中），Core 留包内、**CSP 未放宽**；Live2D 仍可见（首帧约 1.0 s）。**AC-C 破坏性实测已补**（§4.1，像素证据）；**AC-E `e2e:tauri` 已重跑 2 passing**（§4.2，debug 路径实测；需 `TAURI_NATIVE_DRIVER` 指向 `msedgedriver.exe`——它不在 PATH，是环境依赖）。

## 决策与进入条件

| 决策 | 当前状态 | 影响 |
| --- | --- | --- |
| 正式产品名、独立仓库名及位置 | 位置**已定** `f:/AIVoice/pet-shell`（2026-09-16 口径统一）；正式产品名/仓库名仍待定，文档暂用 PetShell / pet-shell | MVP-08 品牌资产（改名要同步 profile 与契约） |
| 自用或对外分发 | **已定：自用不分发**（2026-09-16 口径统一） | 一旦对外分发，Live2D 许可组合需在 MVP-13 之前核查 |
| MVP-12 是否纳入、点击或文件输入范围 | **已定：纳入，仅点击**（2026-09-16 口径统一） | 文件分支不适用；输入契约已冻结，可派发 |

用户决定产品范围后仍须通过技术出口；不把决定等同于已证明兼容。Live2D 未通过技术/目标用途许可核查时，相关路径保持 BLOCKED，不擅自删减 0.6 DoD 或以 sprite 成果宣告 0.6 完成。

## 依赖与交付

| SPEC | 交付 | 前置 | 规划状态 |
| --- | --- | --- | --- |
| [MVP-07](specs/MVP-07.md) | 锁定基线、可复现构建、功能盘点、可行性、剪枝 | 决策及独立实施授权 | DRAFT |
| [MVP-10](specs/MVP-10.md) | 三个最小插件槽与默认实现 | MVP-07 相应基线/剪枝 AC | DRAFT |
| [MVP-08](specs/MVP-08.md) | 品牌、菜单、单实例、受管退出 | MVP-10；正式命名 | DRAFT |
| [MVP-09](specs/MVP-09.md) | 四端点兼容、身份/profile、Aiki 最小增量 | MVP-08/10 | DRAFT |
| [MVP-11](specs/MVP-11.md) | Live2D 与首种换装方式 | MVP-07 Live2D 可行性 PASS、MVP-09/10 | DRAFT |
| [MVP-12](specs/MVP-12.md) | 点击 → Aika 反向通道（**仅点击**，文件分支不适用） | 范围已冻结；MVP-08/09 已 PASS | 可派发 |
| [MVP-13](specs/MVP-13.md) | 真机、性能、打包及用途对应许可验收 | MVP-08～11；12 仅在纳入时要求 | DRAFT |
| [MVP-14](specs/MVP-14_LIVE2D_ASSET_BOUNDARY.md) | Live2D 素材的分发边界（处置 DEF-1） | MVP-13（DEF-1 取证） | 已实施，报告 PARTIAL |

执行顺序：**07 → 10 → 08 → 09 → 11 → 13**。12 的范围已冻结（仅点击），排在 13 之后补齐。每次一份，四端点回归从 07 起持续进行，09 是综合兼容出口。可独立推进的 sprite 工作不代表 Live2D 阻塞已解除。

## 文件、验证与报告规则

- shell 源码只在待确定的独立仓库；Aika 仅允许 SPEC 明列的 adapter/profile/进程管理最小增量。不得恢复旧 PetApp 或扩大到 Agent、Memory、OCR 重构。
- 每份实施前登记实际源码路径与双仓完整 commit；本文的目录范围不是已存在文件的声明。契约变更同时记录版本、兼容方式和双方消费者。
- 报告统一为 `docs/integration/reports/MVP-xx_ACCEPTANCE.md`，实施后才创建。逐 AC 使用 PASS/FAIL/BLOCKED/NOT RUN，分 fixture、真实进程、device、real-provider、human；不得以草案完成冒充实现完成。
- 小阶段仅定向验证；13 才执行明确的组合验收。复用相同构建/配置的证据，注明来源和覆盖；新构建不得直接继承旧安装器结果。
- 0.5 产品与发布欠账仍以 [0.5 索引](SPEC_MVP_0.5.md) 为准；0.6 规划与实施不会自动清账。
