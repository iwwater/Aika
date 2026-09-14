# Aika 0.5 MVP · SPEC 执行索引

需求：[RPD](../RPD_MVP_0.5.md)。基线58dd1be；不重写历史。本轮已授权按SPEC实施，真实环境结论独立记录。

| SPEC | 所属 | 交付 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| [MVP-01](../core/specs/MVP-01.md) | CORE | 可选能力生命周期与隔离契约 | 现有CORE-01～09 | **完成**（[报告](../core/reports/MVP-01_ACCEPTANCE.md)：A～E PASS；「kernel 5 文件 82 项」口径已在最终全量回归中复现） |
| [MVP-02](../frontend/specs/MVP-02.md) | 前端 | Presentation插件边界 | MVP-01/PET-02～06 | **完成**（[报告](../frontend/reports/MVP-02_ACCEPTANCE.md)；桌宠相关用例随最终全量回归全绿） |
| [MVP-03](../frontend/specs/MVP-03.md) | 前端 | 删除Legacy Pet | MVP-02 | **完成**（[报告](../frontend/reports/MVP-03_ACCEPTANCE.md)：A/C/D PASS、B 部分 PASS，真人点击项 NOT RUN） |
| [MVP-04](../frontend/specs/MVP-04.md) | 前端/感知 | OCR观察与陪伴闭环 | MVP-01/03；FE-18～32已实现部分 | **完成**（[报告](../frontend/reports/MVP-04_ACCEPTANCE.md)：A/B/C/E PASS、D NOT RUN；§4 调度器项已由 MVP-05 修掉） |
| [MVP-05](specs/MVP-05.md) | 集成 | 七场景隔离矩阵 | MVP-02～04 | **完成**（[报告](reports/MVP-05_ACCEPTANCE.md)：A～E PASS，D 为 device 取证） |
| [MVP-06](../llm/specs/MVP-06.md) | LLM | Memory/Wiki/RAG收口与最终复验 | MVP-05 | **完成**（[报告](../llm/reports/MVP-06_ACCEPTANCE.md)：A～E/G PASS、F NOT RUN；不宣告冻结发布） |

每次执行一份。源码采用现有落点；报告在所属模块reports/MVP-xx_ACCEPTANCE.md。AC用PASS/FAIL/BLOCKED/NOT RUN，证据分production+fixture/device/real-provider/human。允许复用证据但要说明覆盖，禁止继承旧整项PASS。模块阶段定向测试，最后跨模块回归；不据此自动发布。

索引同步记录（2026-09-15，实机补跑收尾）：六份 SPEC 全部执行完毕。最终全量回归在**当前工作区**复跑：`npx vitest run` → **153 文件 / 1658 项通过、0 失败**；`tsc`/`npm run build`/`cargo test --lib` 全过。实机补跑（用户授权）：**MVP-04-D 部分 PASS**——演示窗覆盖 ROI → 真实 OCR → 真实 Provider 轮落库（回复正确引用 pentakill 观察）、OpenPet 收到 thinking；**桌宠 say/emotion 未在 proactive 轮出现**（开放问题，用户裁决后续再查）；宿主三次数分钟内退出原因未定论。**MVP-06-F**：应用内真实 Provider 演示 PASS；LLM-05 真实门槛 **FAIL 8/10（需≥9）**——「换工作」条目日/英变体偏离来源；Voice 闭环 NOT RUN。MVP-03-B 真人点击 NOT RUN。演示用临时配置已还原。**不宣告 0.5 冻结发布。**
