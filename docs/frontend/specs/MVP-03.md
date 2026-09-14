# MVP-03 · 删除Legacy Pet

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R03；前置MVP-02。

范围：src/pet/、hooks/usePetWindow.ts、main.tsx/App.tsx旧入口、Tauri petWindow.rs及命令/能力配置。删除前核实真实引用，保留companionSessionController中的主窗业务；有价值的输入契约迁移到presentation，抓屏调用者校验迁移到中性模块，OCR不再依赖petWindow。

| AC | 验收 |
| --- | --- |
| A | 生产源码无PetApp、petWindow模块、pet_window命令、旧relay/窗口自动恢复；旧?view=pet不加载第二App |
| B | 关闭OpenPet后主窗正常，不恢复旧桌宠；主窗陪伴/暂停/结束入口仍可用 |
| C | screen.rs权限/自身遮挡检查保留，但不依赖旧pet；原生相关测试通过 |
| D | 受影响TS测试与构建通过；旧配置被忽略，不误转外部进程授权；文档替代关系更新 |

删除范围仅上述已跟踪旧实现，用户其他文件不动。报告frontend/reports/MVP-03_ACCEPTANCE.md；真实窗口验收单列。
