# NEXT-02 · Aika 身份与配置

状态：NOT RUN。需求：N06-R03。前置：NEXT-01。

## 边界与接口

只改 profile、Prompt 装配、必要产品名称与 settings 持久化、Next app data 命名空间。实现 CONTRACTS 的 AikaProfile 与 ProviderConfig 存取适配；利用上游现有设置和 SecretStore。不重写 UI、不修改 Memory 策略、不引入 Relationship 系统。保留来源和法律声明。

## TDD 步骤

先测试默认身份、配置校验、保存重读、单次 Prompt 注入和旧数据目录隔离失败，再做最小配置改动。使用临时目录验证持久化，不读写用户实际数据库。

## AC

| ID | 验收 |
| --- | --- |
| 02-A | 新安装使用 Aika 静态身份，编辑保存后新会话读取一致，schemaVersion 错误有明确处理 |
| 02-B | profile 只在上游认可的系统上下文位置注入一次，空/非法配置不破坏启动 |
| 02-C | Next 与 Legacy/原 AAAAGENT 数据目录不同；测试预置哨兵文件保持不变 |
| 02-D | Key 不进入普通 JSON、快照、日志或导出；只保留 credentialRef/是否已配置 |
| 02-E | 配置持久化失败可见且不误报保存成功；上游相关配置回归通过 |

只跑配置、Prompt、存储边界及必要契约；产物为报告及真实设置接口映射。
