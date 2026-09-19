# 后续 worker 交接

## 从哪里开始

1. 工作目录 `F:/AIVoice/Aika-Next`，核实分支 `aika-next`。先查看 status，保留其他 worker 改动。
2. 读根 AGENTS、总 RPD、本版 RPD、CONTRACTS、TESTING、当前 SPEC。
3. 首个任务仅 NEXT-00。不要直接实现 Provider、Memory 或 UI；当前没有上游代码，现有文档不是已验证实现。
4. NEXT-00 将上游固定基线导入此独立历史分支。不要把代码克隆到本工作树内部形成嵌套 Git 仓库；只读参考副本可放同级 `F:/AIVoice/AAAAGENT-Upstream`。
5. 测试框架与实际接口映射完成后按 SPEC 顺序推进；每步报告证据，版本末尾再交用户人工验收。

## 可直接交给 worker 的任务

> 在 F:/AIVoice/Aika-Next 执行 docs/next/0.6/specs/NEXT-00.md。先读取 AGENTS.md 和文档入口。仅完成 Windows 上游基线引入、可复现验证、来源映射和报告，不实施后续功能。保留本分支规划文档，旧 Aika 工作树只读。所有基线命令与结果如实记录；不要把历史测试报告当作本次结果。完成后按 AC 报告，通过后再推进 NEXT-01。

## 实施时需要产生的证据

- NEXT-00：`BASELINE.md`、`SOURCE_MAP.md`、`reports/NEXT-00_ACCEPTANCE.md`。
- NEXT-01：`CORPUS_MANIFEST.md`、契约映射定稿与测试入口。
- 各步骤：对应 acceptance 报告；必要原始证据放 reports/evidence，脱敏且控制体积。
- NEXT-08：候选构建、可执行回归命令、逐需求覆盖表。
- NEXT-09：用户人工结果和缺陷回归记录。

不要提前创建写着 PASS 的空报告。文档初始化本身不代表这些产物已经存在。
