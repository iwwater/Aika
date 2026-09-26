# UIR-04 · Playground 正式调试入口

状态：NOT_STARTED；日期：2026-09-25。关联 [PRD](../RPD.md)、[SPEC 索引](../SPEC.md)、[工程映射](../SOURCE_MAPPING.md)。

## 1. 目标与责任边界

覆盖：UIR-R08/R12。前置：UIR-01、UIR-02 有效配对/绑定。

新增 Playground view 与 management chat facade、contracts/management 必需类型、app/trial-backend.ts 注入现有 TurnPort；桌宠为同一状态消费者。

本专项 UI 可直接自行设计，不等待参考图或逐页批准。不得覆盖其他未提交修改；沿唯一运行时和既有存储权威完成直接消费者适配。

## 2. 实施步骤

1. 先冻结 facade 协议（建议新 /api/playground/session、/turns、/turns/:id、/turns/:id/cancel，实施前核对不冲突）：session GET 返回真实 pairing/sessionId/capabilities；提交 POST 带 operationId、pairing、sessionId、expectedConfigRevision、text；查询 GET 返回 TurnScope/status/reply/traceRef；取消 POST 带确切 scope/generation。新路径是本步待实现，不是现有 API。
2. 管理层只调用正式会话现有 TurnPort，operationId 幂等；同会话同时输入遵从宿主忙闲/取消策略，不创建另一 DialoguePipeline，不使用浏览器直连模型。
3. 明确模式为真实会话，发送前可见历史/候选影响说明；首版使用当前 effective Binding。UI 不承诺隔离无痕或临时模型覆盖；来源切换去角色正式设置。
4. 发送/等待/回复/错误/取消可恢复；中文 IME composition 不触发 Enter 发送；双击只创建一次轮次，刷新后查询真实在途状态，迟到旧回复不覆盖新 scope。
5. 集成已有 STT 试麦、TTS 试听与检索试算入口：按能力执行并释放资源；没有设备显示 unavailable。当前试算与该轮实际 consumed Context 明确区分。
6. Trace 按 turnId 引用跳转 Developer，未启用则提示；Playground 不自行永久复制完整 Prompt。

## 3. 验收标准

| AC | 必需结果 | 当前证据 |
| --- | --- | --- |
| 04-A | 浏览器提交→正式 TurnPort→History/Trace→回复链有真实进程证据，桌宠与页面同一会话状态 | NOT RUN |
| 04-B | 重复提交一次执行；取消/断线/刷新/角色切换/配置过期遵从唯一权威 | NOT RUN |
| 04-C | IME 不误发、无自动模型请求或开麦；真实会话持久化效果明示 | NOT RUN |
| 04-D | 鉴权/配对/过期 generation 负例通过；检索试算不能假称历史 Context | NOT RUN |

## 4. 验证与交接

新增 tests/ui-rework/playground.test.mjs、playground-routes.test.ts、playground-production.test.ts。自动协议 stub 验证边界，至少一次配置真实 Provider 的文本回放单列；没有真实资源则该项 BLOCKED。

新增测试路径是计划文件，不表示已存在或通过。报告写入 `reports/UIR-04.md`（相对专项根）；记录基线/改动文件、公开契约及消费者、每项 AC、命令退出码、真实/fixture 区别和未运行项。下一步只能消费已有证据的能力。

## 5. 兼容、风险与未做项

不引入第二个 current-model、不默认创建无痕存储。回退页面不删实际 History；服务端新增 facade 可停用，既有桌宠提交仍可用。

