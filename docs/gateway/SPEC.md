# gateway SPEC 索引

需求：[模块PRD](PRD.md)。执行状态见报告与[执行计划](../GOAL_EXECUTION_PLAN.md)，READY不表示实现。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [GW-01](specs/GW-01.md) | Channel Gateway 与可靠收发 | RT-02、RT-03、RT-04 | AUTO_PASS（2026-09-13）：A~D 全过（去重/恢复 unknown 不重跑/附件校验/有序/目的地绑定/重试上限/unknown 终态/适配器无 LLM-Memory 面）；真实适配器 NOT RUN。见[验收报告](reports/GW-01_ACCEPTANCE.md) |
| [GW-02](specs/GW-02.md) | Telegram 文本私聊适配 | GW-01 | AUTO_PASS（2026-09-13，fixture 轨）：A~D 可自动项全过（官方 fixture/Unicode 切分/token 脱敏/offset 持久后推进）；真实双向 NOT RUN。见[验收报告](reports/GW-02_ACCEPTANCE.md) |
| [GW-03](specs/GW-03.md) | Telegram 语音与文件入口 | GW-02、STT/TTS 端口自动审查 | AUTO_PASS（2026-09-13）：A~D 可自动项全过（元数据/下载校验矩阵、实值解码管线、失败不伪造、取消清理）；真实语音音质人工队列。见[验收报告](reports/GW-03_ACCEPTANCE.md) |
| [GW-04](specs/GW-04.md) | Device Gateway 配对与能力会话 | RT-03、FE-14、FE-17-pre | AUTO_PASS（2026-09-13）：A~D 可自动项全过（能力交集/租约重连/独立授权口/逐设备隔离）；真实设备端到端 NOT RUN。见[验收报告](reports/GW-04_ACCEPTANCE.md) |
| [GW-05](specs/GW-05.md) | Feishu/Lark 适配 | GW-02契约稳定 | AUTO_PASS（2026-09-13，fixture 轨）：A~C 可自动项全过（复用 GW-01 契约/验签重放 tenant 隔离/token 刷新脱敏）；真实账户 NOT RUN。见[验收报告](reports/GW-05_ACCEPTANCE.md) |
| [GW-06](specs/GW-06.md) | QQ 适配 | GW-02契约稳定 | AUTO_PASS（2026-09-13，fixture 轨）：A~C 全过（能力缺口如实 BLOCKED/scope 精确命名/非文本与生命周期 op 拒绝/429 负例）；真实账户申请 BLOCKED。见[验收报告](reports/GW-06_ACCEPTANCE.md) |
