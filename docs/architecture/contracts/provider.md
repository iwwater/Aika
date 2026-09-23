# Provider Contract

## 分层

```text
Capability → Adapter → SourceInstance → ModelProfile → Binding
```

- **Capability**：能力类型和输入输出语义。
- **Adapter**：具体协议或引擎转换。
- **SourceInstance**：一个云端、本地服务或受管本地来源。
- **ModelProfile**：模型/音色及其参数配置。
- **Binding**：把能力、来源、Profile 和阶段显式绑定。

## 必须保持的语义

- 同一 Capability 可有多个来源；不能按导入顺序或隐式 fallback 选择。
- 只初始化所选来源和必要依赖；发现/读配置/健康展示不得启动全部引擎。
- Adapter 不拥有全局当前模型、Memory 写入或任意外部动作权限。
- 错误需说明来源、阶段和可恢复性；已经产生输出或副作用后不能伪装成可安全重试。

完整 schema、版本范围和 Provider 特例以 [0.65 PROVIDERS](../../next/0.65/PROVIDERS.md) 为版本基线。
