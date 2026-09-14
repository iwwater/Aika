# MVP-02 · Presentation插件边界

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R02；前置MVP-01与现有PET实现。

范围：app/hosts/desktopPet.ts、services/desktopPet/与定向测试；消费者继续依赖DesktopPetService端口，不引入OpenPet库。manifest只是插件元信息/能力声明，不做安装市场；start/stop/health管理外部接入，不把Runtime编译进Aiki。

| AC | 验收 |
| --- | --- |
| A | 声明id/version/提供能力，核心无OpenPet协议依赖；unsupported能力如实描述 |
| B | 配置关闭零请求/进程；服务start失败或配置读取故障不使Aiki内核启动失败 |
| C | stop/start独立、状态/诊断真实；POST失败不传播到CompanionRuntime |
| D | 现有HTTP/进程所有权与轮次取消用例通过；不退回旧桌宠 |

报告frontend/reports/MVP-02_ACCEPTANCE.md。旧pet删除归下一SPEC。
