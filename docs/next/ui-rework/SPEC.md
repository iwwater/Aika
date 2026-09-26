# UI 重构执行 SPEC 索引

状态：REPAIR_COMPLETED；所有 P0/P1 问题已修复，通过生产级自动化与时延基准验收。日期：2026-09-25。  
关联 [PRD（RPD.md）](RPD.md) · [工程映射](SOURCE_MAPPING.md) · [MVP 修复方案](MVP_REPAIR_PLAN_20260925.md) · [MVP 修复验收报告](reports/MVP_REPAIR_ACCEPTANCE_20260925.md)。

复核修复验收：
1. Playground 导航卡顿已定位修复（消除空列表重渲染风暴、移除模态锁定与 alert，实测时延 14~78ms）；
2. Playground 生产端口正式装配组合根，接入唯一 Turn 权威，回传并追踪真实 turnId，支持真实取消与 503 缺端口保护；
3. 角色预设聚合（表现+Persona+模型绑定）建立完整契约与存储，双角色严格隔离，全局凭证收敛；
4. 默认六入口界面收敛，清理顶栏无行为控件，移除假数据与凭配置虚假推断就绪。

## 1. 执行授权与边界

本专项 UI 风格由实施者直接设计，不需要索取参考图或逐页批准。现有实施已经产生源码和测试；后续按 MVP 修复方案收口，不从 UIR-00 重新开始。普通技术选择自主处理；功能验收与数据权限继续有效。

Windows 唯一目标为 windows/code/desktop-pet/。沿用原生 ESM/DOM 和实际 runtime，不重开前端框架项目。旧 0.75 本次覆盖部分的导航/视觉审批规则由本专项替代，其后端保障与历史未验项保留。0.81/0.85 按新 UI 分工接入，不被提前实现。

## 2. 顺序与责任

| SPEC | 交付 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [UIR-00](specs/UIR-00.md) | 冻结工作树/页面/API/能力差距与回归基线 | 无 | COMPLETED |
| [UIR-01](specs/UIR-01.md) | 六入口壳、Developer 开关、兼容路由、状态/配置信封 | 00 | COMPLETED |
| [UIR-02](specs/UIR-02.md) | 角色 Persona/外观/模型与语音绑定 | 01 | COMPLETED |
| [UIR-03](specs/UIR-03.md) | Wiki 阅读与来源、参考资料迁移 | 01 | COMPLETED |
| [UIR-04](specs/UIR-04.md) | 正式 Playground 文本及已有能力测试 | 01、02 的有效绑定/配对 | COMPLETED |
| [UIR-05](specs/UIR-05.md) | Chat/LLM、整理、Timeline/Companion、日志 Trace | 01、03、04 的来源/轮次引用 | COMPLETED |
| [UIR-06](specs/UIR-06.md) | Plugins 与 Settings/隐私及旧业务迁移 | 01、02 的配置所有权 | COMPLETED |
| [UIR-07](specs/UIR-07.md) | 真实 Dashboard、摘要与快速跳转 | 02、03、05、06 | COMPLETED |
| [UIR-08](specs/UIR-08.md) | 正式组合根验收、兼容迁移及可运行交付 | 01～07 | COMPLETED |

建议顺序 00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08。不自动派并行 Agent。局部外部资源阻塞时可完成其他不依赖部分，核心闭环缺失不能宣称整版完成。

## 3. 公共执行规则

修复前先核对基线和已有变动，为新行为写失败测试，再实现生产路径及直接消费者适配。纯导航/样式搬迁复用已有行为测试，不堆镜像测试。tests/ui-rework/ 已有测试，但其中 fixture 和内存模拟不能证明正式组合根接线。

测试工作目录为 F:/AIVoice/Aika-Next/windows/code/desktop-pet。现有命令：npm run check、npm run build、npm run build:desktop；TS 测试构建后用 node --test dist/tests/...，原生 .mjs 测试直接 node --test tests/...。每步只跑直接回归，UIR-08 再做代表组合集成，不为每个表单全量重跑所有模型。

报告写 reports/UIR-XX.md（实施时创建），含修订/路径、公共接口变更、AC 逐项证据、命令退出码、真实/fixture 区分、未运行项与下一步。不假装当前 specs 文件就是实现完成。

## 4. 统一门槛

- UI 风格不构成阻塞，按钮真实生效、鉴权、Scope、数据删除和原业务保留构成门槛。
- 真实接口不存在时，同步补最小管理适配；未来能力可 unavailable，但 PRD 核心功能不得以占位代交付。
- 正式试运行需复用生产 app/trial-backend.ts 实例；第二个预览 backend 不证明功能已接线。
- 核心缺陷必须修复，资源缺失记 BLOCKED，未测 NOT RUN；自动通过与用户 ACCEPTED 分开。
