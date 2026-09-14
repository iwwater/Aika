# MVP-01 · 可选插件生命周期

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R01；已有内核契约保持向后兼容。

范围：kernel/新增通用可选能力控制器及测试；不改变核心AikaPlugin.activate/registrar/回滚契约。运行期start/stop/health属于可选能力控制器，与装配期activate/deactivate分开。PluginContext不给AppState。调用者通过注入start/stop操作管理外部服务，Core不能import OpenPet、OCR或Memory实现。

交付：受限生命周期接口、generation/abort、状态快照、失败代码、并发启停与listener错误隔离；复用现有EventBus，不新建业务总线。操作有界，不无限重试；超时后不允许重叠复活旧实例。装配兼容通过现有kernel测试验证。

| AC | 验收 |
| --- | --- |
| A | 空能力start/stop/restart/health；重复start不重复执行，重复stop幂等 |
| B | start/stop/health异常只标自身failed，不阻塞另一个能力与内核 |
| C | starting时stop撤销generation；迟到启动清理，不变running；listener抛错不影响他人 |
| D | 挂起操作有界、清理/超时可诊断，无自动重试风暴 |
| E | 既有kernel契约/架构检查通过；核心目录零供应商/感知业务依赖 |

定向运行kernel与新增controller测试。报告core/reports/MVP-01_ACCEPTANCE.md。
