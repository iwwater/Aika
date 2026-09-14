# MVP-01 验收

2026-09-14，production+fixture。新增kernel/optionalCapability.ts与定向测试，复用既有内核；核心启动事务不变。

`npm test -- src/kernel`：exit 0，5文件82测试通过。

| AC | 结果 | 证据 |
| --- | --- | --- |
| A | PASS | 20轮启停，每轮并发start/stop只执行一次 |
| B | PASS | 启动/健康/订阅者异常隔离，另一能力仍running |
| C | PASS | starting时stop abort，迟到cleanup只执行一次 |
| D | PASS | 挂起start/stop超时；旧实例隔离期间禁止重叠start；无剩余timer |
| E | PASS | 既有kernel、plugin、registry及静态架构门禁全过 |

共享契约：新增可选能力生命周期工具，不改AikaPlugin.activate/deactivate/registrar，不给内核加入业务事件。消费者接入归MVP-02。真实进程故障隔离不由本测试证明。
