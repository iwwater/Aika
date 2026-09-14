# Aiki Desktop Pet Integration · SPEC 执行索引

> 2026-09-14 · 策略已按用户要求变更；规格 DRAFT 保留，实现状态见下表与 reports/。
> [RPD v0.2](RPD_DESKTOP_PET_INTEGRATION.md) · [拟定契约 v1](DESKTOP_PET_CONTRACT.md)

PET-* 是前端模块内的独立集成任务，避免与已有 FE 编号及 RPD 的 DPI 需求号混淆。一次执行一份；本次拆文档不启动下载、编译、桌宠安装或后台进程。

| SPEC | 交付 | 依赖 | 版本 / 状态 |
| --- | --- | --- | --- |
| [PET-01](specs/PET-01.md) | 上游版本、接口与 Windows 可运行性证据 | 无 | 0.5 / **A～E 全 PASS（device，已装并实测 v0.1.6）** |
| [PET-02](specs/PET-02.md) | 契约、Service、能力和结果语义 | PET-01 资料结论；可先 fake 验逻辑 | 0.5 / **A～F PASS（模块级）** |
| [PET-03](specs/PET-03.md) | OpenPet HTTP adapter 与宿主传输 | PET-01 协议冻结、PET-02 | 0.5 / **A～E PASS（假端口 + Rust 单测）** |
| [PET-04](specs/PET-04.md) | 事件/情绪映射、去重、取消与期限 | PET-02；独立 fake adapter | 0.5 / **A～G PASS（fake Runtime/Clock）** |
| [PET-05](specs/PET-05.md) | Sidecar 附着、启动、所有权及退出 | PET-01 生命周期证据、PET-02 | 0.5 / **A～G PASS（假进程端口 + 受控测试进程）** |
| [PET-06](specs/PET-06.md) | 生产装配、设置与旧桌宠入口迁移 | PET-03/04/05 | 0.5 / **A～G PASS（生产装配 + 假外部端口）** |
| [PET-07](specs/PET-07.md) | Windows 真实链路与故障隔离验收 | PET-01～06 | 0.5 / **部分 PASS：上游侧 device 已证；Aiki 宿主侧 NOT RUN（不得宣告闭环完成）** |
| [PET-08](specs/PET-08.md) | NyaDeskPet 接入与 Live2D 条件里程碑 | 明确选择 0.6 Live2D；PET-02/04/06 | 0.6 / DEFERRED（条件路线；未启动） |

逐份证据与命令见 `reports/PET-01_ACCEPTANCE.md` … `reports/PET-07_ACCEPTANCE.md`（PET-08 因路线未启动，不生成验收报告）。
模块级 PASS ≠ 全流程通过：0.5 的跨模块真实链路结论**只能**由 PET-07 在真机给出。

推荐执行：01→02→03→04→05→06→07。PET-04 逻辑不依赖真实 Runtime；上游安装受阻时仍可完成 fake 路径，但协议与设备结论必须分列。PET-08 首段可行性不成立时记录阻塞，不转自研 renderer。

## 统一派发规则

开始读仓库 AGENTS、RPD、契约、当前 SPEC、git diff。新增源码路径均为拟定；按实际仓库落点调整并在报告解释。共享文件只作定向增量，保护现有未提交修改。

每份输出 `docs/frontend/reports/PET-xx_ACCEPTANCE.md`：逐 AC 的 PASS / FAIL / BLOCKED / NOT RUN、证据类型、真实命令与退出码、文件范围、共享契约影响、遗留项。不得用 DRAFT/已写文档替代实现结论。只有 PET-07 的真实演示通过才能宣布 OpenPet 闭环完成。

小阶段跑定向测试；PET-07 是明确跨模块桌面里程碑，可做必要宿主构建。完整 Aiki 安装发布仍归 INT-03；语音真人、真实感知权限和外部 Provider 质量不自动解除原后置规则。

## 旧规格优先级

桌宠路线发生冲突时，本索引与 RPD 优先于 FE-20、FE-27～30 及旧总计划中的自研桌宠条目。FE-31/33 中依赖旧窗口的项按 RPD 迁移表单列；环境、OCR、陪伴业务逻辑与既有证据保留。不得继续派发自研窗口/渲染器来“补齐”0.5。
