# MVP-02 验收

2026-09-14。新增Presentation lifecycle端口与manifest，生产宿主/设置启停接入MVP-01控制器；配置读取异常默认禁用并记录短错误。保留外部进程，不Fork或复制OpenPet。

`npm test -- src/services/desktopPet src/app/hosts/desktopPetHostWiring.test.ts src/presentation/desktopPetPresenter.test.ts`：首轮98过1失败；修复基线旧TTL断言（PET-04早已将显示TTL与4s发送期限拆分），复跑101/101通过、exit 0。新增生产lifecycle装配用例随MVP-03回归再验证。

| AC | 状态 | 证据 |
| --- | --- | --- |
| A | PASS | manifest只声明已支持的表现能力及external-process；core无供应商import |
| B | PASS（模块） | 关闭零网络/进程的已有生产装配用例通过；配置读取catch禁用分支已实现 |
| C | PASS（模块） | lifecycle异常/启停测试、服务/presenter故障隔离通过；真实状态留设备验收 |
| D | PASS（模块） | HTTP、进程所有权、取消回归101测试通过；旧fallback删除归MVP-03 |

共享接口可选新增`desktopPet.lifecycle`，既有DesktopPetService不破坏。实机OpenPet/Aiki闭环仍不据此宣告完成。
