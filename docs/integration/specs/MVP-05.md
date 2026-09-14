# MVP-05 · 模块隔离矩阵

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R05；前置MVP-02～04。

范围：生产装配/服务的integration测试及reports/MVP-05_ACCEPTANCE.md；不为测试新写替代编排。执行RPD七行矩阵，每行记录输入、开关、注入故障、模型调用数、观察/长期读写/桌宠调用数与清理结果。

| AC | 验收 |
| --- | --- |
| A | 全开、Pet OFF、OCR OFF、Memory OFF四行均符合范围，缺能力仍能回答 |
| B | Pet错误、OCR错误、RAG拒绝/挂起三行互不传播，保留recent context，无错误原文进prompt |
| C | 每个模块连续启停20次，无重复订阅/请求；旧generation不复活 |
| D | 真实OpenPet进程退出后Aiki仍运行并可重连；OCR worker失败不影响桌宠。native同进程崩溃隔离不在承诺内 |
| E | 禁止跨实现import的静态门禁通过；06完成后复验真实Memory/Wiki/RAG路径 |

允许端口fake，核心必须生产实现。D是device单列。报告禁止把逻辑停用与OS崩溃隔离合并PASS。
