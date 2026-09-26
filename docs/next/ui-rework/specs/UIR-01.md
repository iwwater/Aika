# UIR-01 · 六入口壳与兼容路由

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：UIR-R01/R12。前置：UIR-00。

management/ui/{app,routes,api,dom}.mjs、样式与 server.ts 静态资源注册；直接消费者为右键深链、所有页面模块和桌面打开控制台入口。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. 实现 Dashboard/Knowledge/Characters/Playground/Plugins/Settings 的单一导航模型；Developer 为默认关闭的附加分区。
2. Developer 显示偏好可保存在本地非秘密偏好存储；关闭后销毁订阅/清掉调试内存，不请求 Trace 正文。旧调试深链展示启用提示；启用后返回原目标。
3. 实现 SOURCE_MAPPING 全部旧链接兼容，特别旧 knowledge 到参考资料、memory/records 按数据类型分流；保留配对与查询条件，清理 URL token。
4. 从真实管理 session/角色选择获得配对；禁止默认 user/character/instance 回退查询私人数据。待身份加载时请求暂停；切换使用 request epoch/AbortSignal 防迟到覆盖。
5. 建立统一状态组件和分 owner 的配置表单信封；区分 disabled/unavailable/unknown/loading/ready/failed/pendingRestart，保存冲突保留草稿。
6. 自行实现简洁可用布局，键盘焦点、可访问名称、窄窗口滚动/错误态/空态齐全；不等待风格确认。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 01-A | 六入口、刷新/后退/旧深链均正确，Developer off 不展示或预取调试正文 | NOT RUN |
| 01-B | 切角色/切页迟到响应不混线，URL token 清理但 pairing.userId 不丢失 | NOT RUN |
| 01-C | 鉴权失败、无权限与空数据不同，冲突保留草稿；导航不触发模型/采集 | NOT RUN |

## 4. 验证与交接

新增 tests/ui-rework/navigation.test.mjs、state.test.mjs；复用 tests/management/routes.test.mjs。验证真实静态文件加载与窄窗口导航。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-01.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

只迁移路由和无秘密 UI 偏好，不迁移用户数据库。保留旧 alias；回退 UI 时旧数据继续可读。

