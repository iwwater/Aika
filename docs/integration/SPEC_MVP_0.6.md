# Aiki 0.6 · Pet Shell SPEC 索引（草案）

依据：[RPD v1.2](../RPD_MVP_0.6.md)。2026-09-15 文档修订。

**执行状态（2026-09-15 更新）**：用户已拍板三项决策（位置 `f:/AIVoice/pet-shell`、自用不分发、MVP-12 纳入且仅点击交互）并授权执行全部未完成 SPEC。

- [MVP-07](reports/MVP-07_ACCEPTANCE.md)：**A～E PASS**（基线与可复现构建、四端点/功能盘点、Live2D 技术出口、剪枝、可推进范围）。
- [MVP-10](reports/MVP-10_ACCEPTANCE.md)：**A～E PASS**（renderer/behavior/menu 三槽与默认实现迁移）。
- [MVP-08](reports/MVP-08_ACCEPTANCE.md)：**A～F PASS**（品牌替换、菜单入口、单实例、退出语义、协议退出鉴权、回归）。临时标识 PetShell / `dev.aiki.petshell`。
- [MVP-09](reports/MVP-09_ACCEPTANCE.md)：**A/B/C/D/F PASS，E PARTIAL**——`product`/`capabilities` 识别、版本绑定、owned-only 协议退出与回退、三通道与双仓 fixture 同步已落地；**屏幕可见层未跑**，故本 SPEC 尚未整体收口。
- MVP-11：**A～F PASS**（Live2D renderer 与首版换装，Windows 真机 + WebDriver 取证；见 [MVP-11 报告](reports/MVP-11_ACCEPTANCE.md)）。
- MVP-13：**执行中，报告 PARTIAL**（[MVP-13 报告](reports/MVP-13_ACCEPTANCE.md)）——MSI 构建/启动/重开、四端点逐项复测、Live2D 在 release 产物的可见表现（像素证据）、10 分钟待机与 30 次交互均已取；抓出 **DEF-1**（Live2D 素材随包分发，阻塞对外发行，**未修复**）、**DEF-2**（Live2D 整窗鼠标穿透，已修复并人工复验）、**DEF-3**（导入宠物贴图 URL 取不到，已修复并真机复验）；AC-F 安装/卸载未跑。
- MVP-12：**范围已冻结（仅点击），待派发**（[明细](specs/MVP-12.md)）。
- KB-01：**NOT RUN**，仍未派发实施。
- MVP-14：**草案，未派发**（[Live2D 素材的分发边界](specs/MVP-14_LIVE2D_ASSET_BOUNDARY.md)）——处置 MVP-13 的 **DEF-1**：让 release 产物不再包含 Live2D 官方示例模型。

## 决策与进入条件

| 决策 | 当前状态 | 影响 |
| --- | --- | --- |
| 正式产品名、独立仓库名及位置 | 待用户决定；文档暂用 pet-shell | MVP-07 建仓、MVP-08 品牌资产 |
| 自用或对外分发 | 待用户决定 | MVP-07 依赖组合可行性、MVP-13 发行材料 |
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
| [MVP-14](specs/MVP-14_LIVE2D_ASSET_BOUNDARY.md) | Live2D 素材的分发边界（处置 DEF-1） | MVP-13（DEF-1 取证） | DRAFT，未派发 |

执行顺序：**07 → 10 → 08 → 09 → 11 → 13**。12 的范围已冻结（仅点击），排在 13 之后补齐。每次一份，四端点回归从 07 起持续进行，09 是综合兼容出口。可独立推进的 sprite 工作不代表 Live2D 阻塞已解除。

## 文件、验证与报告规则

- shell 源码只在待确定的独立仓库；Aika 仅允许 SPEC 明列的 adapter/profile/进程管理最小增量。不得恢复旧 PetApp 或扩大到 Agent、Memory、OCR 重构。
- 每份实施前登记实际源码路径与双仓完整 commit；本文的目录范围不是已存在文件的声明。契约变更同时记录版本、兼容方式和双方消费者。
- 报告统一为 `docs/integration/reports/MVP-xx_ACCEPTANCE.md`，实施后才创建。逐 AC 使用 PASS/FAIL/BLOCKED/NOT RUN，分 fixture、真实进程、device、real-provider、human；不得以草案完成冒充实现完成。
- 小阶段仅定向验证；13 才执行明确的组合验收。复用相同构建/配置的证据，注明来源和覆盖；新构建不得直接继承旧安装器结果。
- 0.5 产品与发布欠账仍以 [0.5 索引](SPEC_MVP_0.5.md) 为准；0.6 规划与实施不会自动清账。
