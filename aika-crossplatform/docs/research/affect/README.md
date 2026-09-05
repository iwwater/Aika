# Aika 情感修正研究资料包

整理日期：2026-09-05。用途：选题精读、基线复现和实验设计。

本索引包含 12 篇论文。公开仓库只保存来源和下载工具，不包含 PDF 原件；运行脚本后会从 ACL Anthology、arXiv 和 Nature 下载到被 Git 忽略的 papers/ 目录。文件大小、页数、来源和 SHA-256 见 [manifest.json](manifest.json)。arXiv 文件下载自当前 PDF 端点，具体内容以本地文件及哈希为准；正式引用前核对论文页首版本和最新修订。

开发入口：[情绪修正研究开发计划](../../AFFECT_IMPLEMENTATION_PLAN.md)。早期思路与参考背景见 [研究路线](../../AFFECT_RESEARCH_ROADMAP.md)。

## 优先级与官方论文

| 优先级 | 论文 / 官方页面 | 版本 | 阅读任务 |
| --- | --- | --- | --- |
| P0 | [01 Dynamic Persona Coherence](https://aclanthology.org/2026.acl-long.1336/) | ACL 2026 | 区分已有的稳定身份/动态心理分层与本选题的贡献边界 |
| P0 | [02 ZifaMem](https://arxiv.org/abs/2607.17564) | 2026 arXiv 预印本 | 精读完整历史基线、记忆收益与状态机无增益实验，建立强对照 |
| P0 | [03 Explicit State Dynamics](https://arxiv.org/abs/2601.16087) | 2026 arXiv 预印本 | 提取平滑/惯性更新规则、恢复过程与实验限制 |
| P0 | [04 From Triggers to Emotions](https://arxiv.org/abs/2607.07824) | 2026 arXiv 预印本 | 对比事件提取、评价、状态更新，检查是否处理后续证据修正 |
| P1 | [05 Appraisal / Affect Flow](https://aclanthology.org/2025.conll-1.16/) | CoNLL 2025 | 选择适合本项目的事件评价维度 |
| P1 | [06 EmoBench](https://aclanthology.org/2024.acl-long.326/) | ACL 2024 | 借鉴情绪理解/应用的分开评测及中文情境题 |
| P1 | [07 PersonaLLM](https://aclanthology.org/2024.findings-naacl.229/) | Findings of NAACL 2024 | 为人格预设定义可观察行为，避免只做自陈问卷 |
| P1 | [08 Psychometric Personality Framework](https://www.nature.com/articles/s42256-025-01115-6) | Nature Machine Intelligence 2025 | 研究测量可靠性、效度与人格塑形 |
| P1 | [09 LoCoMo](https://aclanthology.org/2024.acl-long.747/) | ACL 2024 | 检查跨会话事实、时间和记忆评测协议 |
| P1 | [10 Persona-Aware Contrastive Learning](https://aclanthology.org/2025.findings-acl.1344/) | Findings of ACL 2025 | 调查可复现的人格一致性基线 |
| P1 | [11 Persona-E2](https://aclanthology.org/2026.acl-long.1350/) | ACL 2026 | 补充人格如何影响事件引发的情绪，评估与本题重叠 |
| P2 | [12 MELD](https://aclanthology.org/P19-1050/) | ACL 2019 | 仅作后续语音/多模态背景，第一版不训练音频模型 |

P0 是确定选题前必须精读的近邻；P1 支持定义与评测；P2 暂不阻塞开发。资料索引是阅读导航，不表示已经完成所有论文的全文复现或系统综述。

## 官方来源、代码和数据入口

论文的正式来源逐条记录在 manifest 的 source_url/requested_pdf_url 字段。以下代码和数据仅整理入口，未批量下载数据集、未安装或运行外部代码：

- EmoBench：https://github.com/Sahandfer/EmoBench
- LoCoMo：https://github.com/snap-research/LoCoMo
- MELD：https://github.com/declare-lab/MELD
- ZifaMem：https://github.com/zifacorp/zifamem
- 期刊范围：https://www.computer.org/digital-library/journals/ta/tac-general-call-for-papers

后续下载代码时记录 commit、数据版本和许可；本资料包不授权将论文或第三方数据重新公开发布。当前无 API 调用费用，无模型训练。

## 精读记录模板

每篇 P0/P1 建议记录以下项目，并填写实际页码，不能只凭摘要判断优劣：

1. 研究问题、主要贡献、正式发表或预印本状态。
2. 状态表示及更新公式：事实、解释、人格、短期情绪是否区分？
3. 是否处理新证据、事实撤回、部分修正、多事件和重复输入？
4. 基线、模型版本、调用预算、数据来源、人工标注与统计方法。
5. 生成回复是否被独立评分，还是只评价自身状态/模型裁判？
6. 开源代码/数据及精确版本；可复现部分和无法复现部分。
7. 对 Aika 的可迁移结论、限制、拟加入的基线或消融。

核心研究假设仍待验证：关联证据的事件更新是否比充分历史与结构化记忆更有效地修正角色回应。不能把“状态层越多越好”当成结论。

## 更新与校验

`download_papers.py` 用 Python 标准库下载，并使用 pypdf 检查文件头、页数及文本可提取性；Windows Python 证书链不完整时使用系统 curl，保持 TLS 校验开启。脚本不覆盖已经存在的 PDF，重新运行会重新校验并更新 manifest；现有文件损坏时报告失败，避免无提示覆盖。

在仓库根目录运行（Python 3.10+）：

```sh
python -m pip install pypdf
python aika-crossplatform/docs/research/affect/download_papers.py
```

首轮整理另检查了所有页可解析并查看首页面缩略图；这不等同对所有研究结论做学术核验。
