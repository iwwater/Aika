# 本地与云端合批记录 · 2026-09-26

## 范围

- 分支：`codex/aika-local-cloud-merge`，独立 worktree；原 `E:/Work/AI CHAT` 的 `master` 工作区未修改。
- 本地已提交基线：`a8dfa9d`（比 `origin/master` 多 3 个提交）；云端 `origin/aika-next`：`32d9e80`。两条历史没有共同祖先；通过 `--allow-unrelated-histories` 在 `6a73780` 合并，保留双方父提交。
- 四个 add/add 冲突为 `.gitignore`、`AGENTS.md`、根 `README.md` 与 `docs/README.md`。忽略规则取并集；开发规则按 Aika 主工程与 Next 路径分别说明；两套原始 README 另存为 `README-NEXT.md` 与 `docs/README_NEXT.md`，主入口互相链接。
- 用户确认纳入本地未提交源码和文档，排除生成产物：10 个跟踪文件的 diff、40 个新增文件带入 `d626985`。40 个新增文件逐一与原工作区比较 SHA-256，均一致。未带入本地未跟踪的 `research/ser/output/`（46 个生成文件）及 `research/ser/manifests/`（1 个生成清单）。云端原有跟踪内容仍由合并历史保留。
- 上一轮 CR-01、04～10 的修复与相关 fail-closed 改动带入 `d3ce90e`；容量淘汰在相同 `received_at` 下改用插入顺序，避免新候选随机被淘汰。
- 云端导入的根 `LICENSE` 为 AAAAGENT 非商业署名许可，文本限定在有权许可且无单独许可的原创内容；与本地主工程既有来源并列后，其适用范围在公开推送或发布前仍需单独核对。本次未改动许可证正文。

## 验证

| 范围 | 命令/方法 | 结果 |
| --- | --- | --- |
| 本地 TypeScript | `npx tsc --noEmit` | PASS，退出码 0 |
| 本地任务调度 | `npx vitest run src/services/runtime/localTasks.test.ts src/services/runtime/persistentScheduler.test.ts` | PASS，14/14，退出码 0 |
| 本地正式组合根 | `npx vitest run src/app/composition.test.ts` | PASS，10/10，退出码 0 |
| 本地前端构建 | `npm run build` | PASS，退出码 0；Vite 有现存动态/静态导入和大 chunk 警告 |
| SER 新增模块 | 本地已有虚拟环境的 `python -m unittest`，7 个指定测试文件 | PASS，28 项中 27 通过、1 条条件跳过；退出码 0 |
| Next 0.82 | `npm run test:next082` | PASS，43/43，退出码 0（含 TypeScript 构建） |
| 浏览器界面 | Vite 本地端口 5179，Codex 内置浏览器 | BLOCKED：页面空白；内核报告 `llm.contextSources` 声明但未提供 `knowledge.wiki`，启动事务回滚。该插件路径未在本次合批改动；定时任务界面未能在浏览器中确认 |
| 实机、跨产品线联调 | 未执行 | NOT RUN |

## 后置边界

用户明确后置 CR-02 的真实抓屏/像素 OCR、CR-03 的正式正文来源/自动调度/陪伴输出，以及依赖它们的实机验收；详见 [0.82 审阅记录](../next/0.82/reports/CODE_REVIEW_20260926.md)。代码历史合批不表示 0.82 功能验收通过。合批分支未推送、未并回 `master`；后续发布前仍需处理上述后置项与 `knowledge.wiki` 插件启动缺口。
