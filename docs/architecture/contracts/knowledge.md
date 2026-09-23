# Knowledge Contract

知识库负责有来源的内容组织、选择、查看、删除和撤销，不替代 Memory 或 Timeline。

## 必须保持的语义

- library、source、document、selection 和 revision 具有明确作用域；不同库不能串读。
- 浏览器不接触绝对路径、密钥或未授权原文；查看走本机鉴权管理 API。
- 删除/遗忘必须提升修订或撤销标记，使检索、后续 Context、缓存和在途请求不再复用内容。
- 删除失败或冲突要对用户可见，不能只从列表隐藏形成假删除。
- Character Wiki、User Wiki 和外部原作来源要区分身份、来源和截止点。

版本级页面和删除接口以 [0.75 CONTRACTS](../../next/0.75/CONTRACTS.md) 及 [0.79 SPEC](../../next/0.79/SPEC.md) 为补充。
