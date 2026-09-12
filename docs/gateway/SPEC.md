# gateway SPEC 索引

需求：[模块PRD](PRD.md)。执行状态见报告与[执行计划](../GOAL_EXECUTION_PLAN.md)，READY不表示实现。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [GW-01](specs/GW-01.md) | Channel Gateway 与可靠收发 | RT-02、RT-03、RT-04 | READY（本地实现） |
| [GW-02](specs/GW-02.md) | Telegram 文本私聊适配 | GW-01 | READY（本地实现） |
| [GW-03](specs/GW-03.md) | Telegram 语音与文件入口 | GW-02、STT/TTS 端口自动审查 | READY（本地实现） |
| [GW-04](specs/GW-04.md) | Device Gateway 配对与能力会话 | RT-03、FE-14、FE-17-pre、FE-15、FE-17-host/tauri | READY（本地实现） |
| [GW-05](specs/GW-05.md) | Feishu/Lark 适配 | GW-02契约稳定 | READY（本地实现） |
| [GW-06](specs/GW-06.md) | QQ 适配 | GW-02契约稳定 | READY（本地实现） |
