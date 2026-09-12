# TTS-04 · 云端输出设置与降级错误

状态：READY（仅授权本地实现与自动验证；真实服务/人工 AC 未执行）。
需求来源：[v0.5 与增量需求](../../PRD_V0.5.md)；执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：TTS-01/02、CORE-05-G 自动审查。
- 修改范围：输出设置 Presenter/组件、defaultSpeechEngines、outputEngine、设置端口。源码根为 aika-crossplatform；优先复用现有端口，不为文档目录迁移源码。
- 非目标：本份范围外功能、发布、公网部署、真实账号操作。前置自动契约通过可开发；需要真实安全属性的集成不可由 fake 放行。

## 行为与接口

复用 auto/cloud-tts/system；凭证经已有秘密存储，note/degraded 从工厂到 Presenter 再到 UI。显式 cloud 配置缺失允许已有降级行为但必须持久可见错误；当前引擎标实际值。

所有新增公共字段需在 CONTRACTS 登记版本、兼容 adapter 与消费者；持久化使用临时数据库验证升级与失败回退，不触碰用户库。

## 验收条件

| AC | 要求 |
| --- | --- |
| TTS-04-A | 保存/重开配置一致且 key 不进入 Trace/普通设置导出 |
| TTS-04-B | 指定 cloud 配置不全时显示错误及实际 system，不能显示云端成功 |
| TTS-04-C | 切引擎停止旧队列；旧回调不覆盖新轮；auto 降级原因可见 |
| TTS-04-D | 两引擎契约测试及 Presenter 错误传播通过；真实试听另属 TTS-05 |

## 验证与交付

先读当前生产实现与既有测试，列出定向命令；测试必须走本模块生产实现，fake 只替代外部依赖。记录命令、退出码、逐 AC 证据、影响消费者、未执行的真实/人工项。逻辑测试不证明 UI 可用、真机或真实服务通过。
报告路径：../reports/TTS-04_ACCEPTANCE.md。仅所有可自动 AC 通过才能写 AUTO_PASS / 待人工验收；FAIL 不可改为 NOT RUN 来推进依赖。完整验收维持待人工；不自动提交或推送。


## 全文审阅：设置与装配

真实defaultSpeechEngines位于app/plugins/voicePlugin.ts；SpeechEngines目前只暴露outputEngine，需最小扩展可观察的实际引擎/note/degraded/config revision，不要改错不存在的同名services文件。语音会话与FE-07点击朗读共用更新和停止路径。

表单至少output/baseUrl/model/voice/speed/apiKey，密钥以独立tts配置命名存SecretStore，其他字段进Settings；密钥为空的保存语义明确为保持，删除用显式操作。新配置验证、持久化成功再原子切换；保存失败不得只切内存。secure=false的浏览器存储明确显示未加密，不能宣称DPAPI。保存/重开/选auto均不主动发合成请求；试听才使用固定文本并明确服务调用。当前轮停止、待播队列/prefetch取消，下一轮才用新配置；晚到回调无副作用。补AC覆盖失败保存、秘密删除、两个朗读入口及零隐式网络调用。
