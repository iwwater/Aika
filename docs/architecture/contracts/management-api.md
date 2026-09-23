# Management API Contract

管理 API 是本机管理面的唯一受控入口，负责配置、诊断、Memory/Knowledge 操作和运行实例状态投影。

## 基础要求

- API 与 Console 同源或使用明确的本机鉴权；未授权、跨 Origin、过期 token 和作用域不匹配必须失败。
- 请求绑定实例、角色配对或 revision；迟到响应不能覆盖新请求或其他实例。
- 读状态时区分 installed、enabled、loaded、ready、failed、pendingRestart 和 unavailable；不能用空对象或常量冒充 live host。
- 保存成功只表示配置持久化成功，不自动声称运行模型已经切换。
- 错误保留可诊断的 code/type/requestId/stage 等安全字段，不把用户正文或密钥写入默认 Trace/日志。
- 删除、遗忘、撤销和配置修改必须进入正式生命周期，并返回冲突、失败或待重启状态。

当前版本的 endpoint、schema 和鉴权实现仍以对应 SPEC/源码为准；本文件冻结的是跨模块语义，不替代 API reference。
