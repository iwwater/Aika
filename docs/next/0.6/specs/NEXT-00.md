# NEXT-00 · 上游引入与 Windows 基线

状态：NOT RUN。需求：N06-R01。前置：文档种子分支已建立。

## 目标与边界

将固定 AAAAGENT 源码作为本分支底座，验证 Windows 基础可运行性，建立接口与测试地图。本步允许导入原版源码、依赖锁文件、来源文件及证据；不开发 Aika 功能、不改 Legacy、不安装系统驱动、不修复无关上游问题。

## 执行

1. 核实当前分支、干净状态和文档种子 commit；记录 `DOCS_SEED_COMMIT` 与 Legacy commit。
2. 获取 `https://github.com/phoiex/AAAAGENT.git` 的上游引用到独立 remote 名（先检查是否已有同名 remote）；固定完整 SHA，不以移动的 main 当基线。需要只读参考副本时建立同级目录，不能覆盖现有目录。
3. 本 orphan 分支只与指定上游 SHA 做一次保留双方历史的导入合并（`--allow-unrelated-histories --no-commit`）；先检查目标树。保留本目录和根 worker 规范，将必要上游开发指令合并记录；如有同名冲突逐文件处理，不 wholesale 使用 ours/theirs。检查完成后提交基线导入。不要合并旧 Aika master。
4. 阅读上游 Windows 指令和真实 package scripts；记录 lockfile、Node/包管理器/系统依赖版本、工作目录、命令、退出码、资源限制。Windows 与 macOS 依赖和产物分开。
5. 对未做业务改动的基线运行上游适用测试、类型检查、构建和自动启动冒烟；不需要用户操作。若 baseline 失败，保存原始结果，单列最小环境/兼容修复及回归，不把修复后结果称为原版通过。
6. 建立 SOURCE_MAP：Windows 入口、contracts、Dialogue、Memory、Context、Provider、Voice、存储、Management、Work route；每项记录真实路径/符号、KEEP/EXTEND/PORT/IGNORE、候选扩展点、已有测试、缺口。
7. 确认 Next 独立数据目录所需改动位置（实际配置在 NEXT-02），确定已有可用 LLM、ASR 和可产生可解码音频的 TTS 路径。仅探测现有环境，不调用未授权付费服务。

## AC

| ID | 自动/可核查验收 |
| --- | --- |
| 00-A | 上游 SHA、Legacy SHA、种子 SHA、获取来源与保留的许可证记录齐全；Git 可追溯上游父历史 |
| 00-B | Windows 正确目录内测试/静态检查/构建命令实际完成且退出 0；未运行/失败如实列出，不能通过 |
| 00-C | 基线进程自动启动及退出成功，缺少非必需模型资产有明确降级；不要求用户提供现场麦克风输入 |
| 00-D | SOURCE_MAP 覆盖上表全部域，每项区分已核实符号与设计接口；缺失能力有后续 SPEC 归属 |
| 00-E | 文档种子仍在、无 Legacy 工作树变更、无旧用户数据/密钥导入；没有混用 macOS 构建结果 |
| 00-F | 自动语料回放环境盘点完成，必需真实路径不可用时明确 BLOCKED 及可继续的独立步骤 |

产物：BASELINE.md、SOURCE_MAP.md、reports/NEXT-00_ACCEPTANCE.md。上游基线不能运行时暂停依赖其结果的功能移植；不在本步重写宿主。代码导入属于后续 worker 工作，本次规划任务不执行。
