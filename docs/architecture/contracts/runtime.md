# Runtime Contract

状态：Active baseline。

## 边界

Runtime/Pipeline 是唯一的轮次、作用域、取消、Context 组装、对话调用和终态权威。模块通过公开 port、adapter 或 capability 接入，不创建第二套 Runtime。

## 必须保持的语义

- 每个请求具有稳定的 `scope`、`session`、`turn`、`generation` 或等价身份。
- 取消、来源撤销、遗忘和陈旧输出校验贯穿模型前后、提交和播放阶段。
- 终态恰好一次；终态后不能产生有效回复或副作用。
- Context 经过作用域、有效性、预算和去重后组合；不能把整个库塞入 Prompt。
- 生产 Memory、Timeline 和 Trace 写入必须使用正式生命周期，不依赖实验 harness 的 direct SQL。

## 版本补充

0.65 固定包宿主、Flow 和生命周期；0.7/0.79 补充 Continuity、失效和投影。具体字段与测试以对应版本 CONTRACT/SPEC 为准。
