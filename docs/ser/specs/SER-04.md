# SER-04 · 公共逻辑、运行环境与产物边界

状态：规格就绪，未执行；依赖 SER-03 完成计分实现与规则冻结。
日期：2026-09-21。需求：[PRD](../PRD.md)；总边界：[优化入口](../../VOICE_RESEARCH_OPTIMIZATION.md)。

## 目标与范围

消除已经出现的样本构造、路径配置、标签归一化分叉；补足环境和产物说明。只提取已有复用点，不建立通用实验框架。

- 修改 `research/ser/ser_emotion2vec_probe.py`、`ser_embedding_umap.py`、`ser_ravdess_baseline.py`、`ser_server.py`、`ser_log.py` 及实际使用相同配置的下载/比较/特征脚本。
- 新增 `ser_common.py`（路径、样本与标签规则）、必要的纯结果解析函数及 `tests/test_ser_common.py`、`tests/test_ser_batch.py`。SER-03 的 metrics 仍是计分唯一入口，不复制另一套公式。
- 新增 `research/ser/requirements.txt`、本机依赖版本快照（如 `requirements.snapshot.txt`）；使用说明放 `docs/ser/RUNBOOK.md`。
- 精确修改根 `.gitignore`；`demo/video/` 只登记入口和产物，不重写、移动或删除录制脚本。
- 不改模型算法、特征定义、UMAP 参数、HTTP 路由语义、前端页面或 GPT-SoVITS。

## 行为要求

1. 默认路径由代码所在位置推导，保留现有项目内目录布局和脚本启动方式；移到另一带空格的工作目录后仍可解析。现有显式缓存环境变量优先，否则缓存留在本项目 research/ser/.cache，不回退到用户 C 盘目录。
2. 一份样本构造函数从 demo data.json 获取顺序、标签与路径；probe/embedding 共用。固定 fixture 应保持 ref/A/C 共18段及既有顺序，不为了去重误删不同来源样本。
3. 一份结果标签规则处理纯英文、中文/英文、`<unk>`、unknown；探针、baseline、服务输出使用同一规则。对 labels/scores 数量不符、空返回或非数值分数显式报错，失败不冒充有效结果。
4. embedding 汇总中 attempted=success+failed，success 直接取已成功数，不再次减失败。样本不足以执行现有降维流程时明确结束并非零退出，不输出伪图；门槛依当前安装依赖的有效输入要求确认并记录。
5. 批处理遇到单样本错误按既有 SPEC 继续处理并最终非零退出；启动/结束/失败可追踪。日志写失败至少向 stderr 报明，不用裸 `except: pass` 掩盖证据丢失；日志模块不承担隐式模型加载。已有 Windows DLL 修复集中在明确的环境初始化函数，保持当前环境可用。
6. 不通过自动全局替换改所有脚本；列出每个迁移消费者与旧/新输入输出对照。已有输出文件路径兼容，SER-03 v2 结果例外已登记。

## 环境与 Git

- requirements 记录实际直接依赖及经核实的版本；snapshot 记录运行环境，另说明 Python、CUDA/torch 构建来源、Windows DLL 前置、模型 ID/可获得的 revision、缓存路径。无法确定的 revision 如实写 unknown，不凭空补全。
- 本 SPEC 不升级、不重建、不删除现有 venv，不下载模型。最小依赖运行方式与完整环境快照分别说明，不把本机绝对安装路径写成可移植依赖。
- `.gitignore` 仅对确认的 `research/ser/.venv/`、`.cache/`、下载数据目录以及已核对的 `demo/video/raw/`、`clips/` 中间产物添加精确规则；先列清单再修改，不忽略整个 research/demo/output。
- 源码、规格、依赖清单、小型指标 JSON、图表及需要追溯的脱敏证据保持可追踪。日志已有全局忽略时，明确将所需脱敏证据摘要保存在 reports/evidence，不把所有含文件名/语料的原始日志自动纳入 Git。
- RUNBOOK 标明最终演示视频与生成入口、哪些目录可再生成、哪些是唯一原始素材。SER 截图序列已剪掉推理等待，不作为实时延迟证明。不删历史实验或原始录音，不执行 git rm 或 git add。

## 验收条件

| AC | 证据 |
| --- | --- |
| A | fixture 证明两个实验入口消费同一18段样本清单；路径在不同 cwd、带空格临时根目录下均正确；显式缓存环境变量被保留 |
| B | baseline、probe、服务的同份假模型响应得到相同规范标签；异常 shape、空结果不会输出正常成功 |
| C | 18条尝试、1条失败时汇总为17成功/1失败且退出非零；全失败及降维样本不足有明确错误，成功计数不重复扣减 |
| D | 相关脚本经生产解析/批处理路径通过 fixture 回归；SER-03 计分回归仍通过；无真实模型下载或推理 |
| E | requirements、版本快照与 RUNBOOK 可对照本机环境；安装可复现性若未在新环境验证，明确 NOT RUN，不宣称已复建成功 |
| F | `git check-ignore -v` 验证精确忽略目标；源码、测试、规格及小型结果未误忽略；报告记录未删除或搬动数据 |

## 验证与交付

cwd 为仓库根，以现有 SER Python 运行 test_ser_common.py、test_ser_batch.py 和 test_ser_metrics.py；命令、实际测试数与退出码写 `docs/ser/reports/SER-04_ACCEPTANCE.md`。仅对本次 Python 文件做语法检查；不运行全模型实验、主工程测试或真实 UI。

接口影响：公共 Python 工具是内部实现；服务字段与现有 CLI 保持兼容。报告列出所有消费者，并将入口写入 SER 索引。
