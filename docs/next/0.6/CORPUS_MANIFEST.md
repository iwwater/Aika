# NEXT-01 行为语料清单（CORPUS_MANIFEST）

状态：AUTO_PASS（2026-09-19）。基线：upstream `ba79db1`（导入提交 `565cd80`）；Legacy 参考 commit `30269c6`。
规则：本清单不提交私人正文与音频；Legacy 条目只登记来源路径 + git blob hash，取用时从 Legacy 仓库按 commit 读原文。上游条目随基线提交存在，hash 为其 blob SHA。

## 1. 最低覆盖矩阵逐项映射（AC 01-A）

| caseId | 矩阵项 | 来源（路径@commit，blob hash 见 §2/§3） | 预期 / 结构断言 | 真实/模拟 | 责任 SPEC |
| --- | --- | --- | --- | --- | --- |
| N01-TXT-SINGLE | 文本单轮 | `tests/providers/adapters.test.ts`@565cd80；`tests/next/pipeline.contract.test.ts`（text replied 全链） | 回复非空、终态 `replied`、user+assistant 各落库一次、上下文恰好请求一次 | 模拟（fixture transport/fake 端口） | NEXT-03/04 |
| N01-TXT-MULTI | 文本多轮 | `tests/memory/context-continuity.test.ts`@565cd80（release 组实跑 138/138 含它） | 多轮上下文实际进入请求；续轮可解析指代 | 模拟 | NEXT-04 |
| N01-CANCEL-LATE | 取消/迟到/快速重发 | `tests/next/turnController.contract.test.ts`；`tests/next/pipeline.contract.test.ts`（新提交取消旧轮、迟到回复被丢弃）；上游 backend-session“only the current generation” | 旧轮终态=cancelled；迟到回复不落库、不发事件；新轮不受污染；media release 必达 | 模拟（可控延迟 Promise） | NEXT-04 |
| N01-CROSS-SESSION | 跨会话 | `tests/next/turnController.contract.test.ts`（resetSession 换 sessionId、旧 scope 失效）；`tests/next/memory.contract.test.ts`（共享 recent 流特征化） | 会话轮换后旧 scope 不被接受；recent 为陪伴者共享历史（已核实的上游语义，见 CONTRACT_MAP §2 注记） | 模拟 | NEXT-04 |
| N01-PROV-EDGE | Provider 坏流/超时/断开 | `tests/providers/adapters.test.ts`（SSE 字节级切割、非法 JSON、finish 缺失）；上游 backend-session（超时/超尺寸/EOF 清理） | 坏流报标准错误、连接失败可重建、UTF-8 分片不乱码 | 模拟 | NEXT-03 |
| N01-MEM-LIFECYCLE | Memory 纠正/遗忘 | `tests/providers/memory-lifecycle.test.ts`、`tests/memory/` dynamics/lifecycle 组@565cd80 | 纠正后检索不恢复旧值；遗忘内容不被后台任务写回；预算按上游规则 | 模拟 | NEXT-04 |
| N01-TL-CRUD | Timeline 重复/失败/删除 | **缺口**：上游无 Timeline 持久化（SOURCE_MAP） | eventId 幂等、分页稳定、删除后重放不复活 | 模拟 | NEXT-05（届时先写 RED 契约用例再实现） |
| N01-ASR-EDGE | ASR 乱序/空结果/取消 | Legacy `L-SPEECH-IN`；`tests/providers/qwen-asr.test.ts`@565cd80 | 乱序段按序合并、空结果不生成用户消息、取消丢弃待发输入 | Legacy 语料=行为参考；上游=模拟 | NEXT-06 |
| N01-TTS-EDGE | TTS 分句/乱序/停止/失败 | Legacy `L-SPEECH-QUEUE`、`L-SPEECH-OUT`；`tests/providers/minimax-tts.test.ts`@565cd80 | 句序不受合成完成顺序影响；停止不伪报交付；失败可见 | 同上 | NEXT-06 |
| N01-E2E-TEXT | 完整文本一条 | `npm run test:windows:ui`（preview 后端往返，NEXT-00 已跑通） | 渲染就绪→文本提交→回复可见→干净退出 | 模拟（离线后端） | NEXT-08 收口 |
| N01-E2E-VOICE | 完整语音一条 | Legacy `L-VOICE-INT` 语料 + whisper 工具链 | 录音→转写→回复；非静音非空 | **BLOCKED**：E: 盘缺失（见 §4） | NEXT-06 恢复、NEXT-08 收口 |

无“以后随便补”的空范围：每项要么有可运行来源，要么明确标注缺口与责任 SPEC（N01-TL-CRUD、N01-E2E-VOICE）。

## 2. Legacy 行为语料（commit `30269c6`，只读引用）

| caseId | 来源路径 | blob hash（git rev-parse 30269c6:path） | 语言 | 允许用途 |
| --- | --- | --- | --- | --- |
| L-VOICE-INT | `aika-crossplatform/src/hooks/useVoiceConversation.integration.test.ts` | `ebca310fc3a3b11489c328ccd269351cd1ba776e` | TS/中文输入样本 | 语音整链行为与打断语义参考（NEXT-06 改 harness 复用） |
| L-SPEECH-QUEUE | `aika-crossplatform/src/services/voice/speechQueue.test.ts` | `686f0d104daa05f3ac344b8de3e472c7c7466ffd` | TS | 分句队列/句序/停止语义参考 |
| L-SPEECH-IN | `aika-crossplatform/src/services/voice/speechInput.conformance.test.ts` | `03474681322e0f7d5c2bdecf9538548b453efa76` | TS | 语音输入契约（乱序/取消/空结果）参考 |
| L-SPEECH-OUT | `aika-crossplatform/src/services/voice/speechOutput.conformance.test.ts` | `dcc2505fd2bd9184544ca787d5712b6e17eeb830` | TS | 语音输出契约（交付状态/停止探针）参考 |
| L-RUNTIME-SCOPES | `aika-crossplatform/src/services/runtime/companionRuntime.scopes.test.ts` | `324101207dc6294add52a17966b0692ecb23b49b` | TS | 轮次/作用域行为参考（与上游 TurnController 对照） |
| L-MEM-STORE | `aika-crossplatform/src/services/memory/memoryStore.conformance.test.ts` | `c58e8dfb92f48fbb4540629fe7c337bfa92bfad7` | TS | 记忆存储契约参考 |
| L-CTX-ASM | `aika-crossplatform/src/services/context/contextAssembler.test.ts` | `ecc75841b9f61123d230c0b8dec62190b48a9953` | TS | 上下文装配/预算参考 |
| L-CTX-DOMAIN | `aika-crossplatform/src/domain/context.test.ts` | `a2cf977f37aefdf35bb6143618d8af381beed8b8` | TS | 上下文领域规则参考 |
| L-PROV-CONF | `aika-crossplatform/src/services/runtime/provider.conformance.ts` | `9e4e7769a9765d0724ed24e334a0d28d9628690b` | TS | Provider 契约场景定义（累计增量/唯一终包/取消/坏流），NEXT-03 按上游端口重写 |
| L-PROV-CONF-TEST | `aika-crossplatform/src/services/runtime/provider.conformance.test.ts` | `5489011b2dc8e13d0b882dff0a096c58c545741d` | TS | 上述场景的原测试（多字节文本 fixture 来源） |
| L-PROV-CLIENT | `aika-crossplatform/src/services/providerClient.test.ts` | `820234f28752c5b3665bf9b2bf24938fb5356612` | TS | providerClient 协议行为参考 |

## 3. 上游测试来源（commit `565cd80` 基线内，blob hash）

| caseId | 路径（windows/code/desktop-pet/ 下） | blob hash |
| --- | --- | --- |
| U-ADAPTERS | `tests/providers/adapters.test.ts` | `40f9765faa52d6203c4ac86d5bc5bd17f55d82b8` |
| U-CTX-CONT | `tests/memory/context-continuity.test.ts` | `05bee3b728c065a66d4c5b53f7c68559188af0b1` |
| U-QWEN-ASR | `tests/providers/qwen-asr.test.ts` | `bc63a52d2a983982ff6f46fffa991213ef84f220` |
| U-MINIMAX-TTS | `tests/providers/minimax-tts.test.ts` | `97aa128a5fe4d5084bbbe395fe0c619dfb239380` |
| U-MEM-LIFE | `tests/providers/memory-lifecycle.test.ts` | `2b052aa2123aaebab11cc681e3fe8b82bfafba9c` |

## 4. 真实服务回放登记（真实/模拟分离，AC 01-D）

入口：`npm run test:next:real`。已实测两种阻断分支均 exit 2 并打印明确 BLOCKED（无 `PET_NEXT_REAL` 时；有开关但无用例时）。缺真实服务绝不 fallback 到 fake 报 PASS。

| caseId | 内容 | 样本与参数 | 现状 |
| --- | --- | --- | --- |
| N01-REAL-LLM | 固定正常问答 + 多轮各≥1 条，真实返回非空、结构合法、终态唯一、多轮上下文进入请求 | 样本自 Legacy 固定文本挑选，登记于 NEXT-03 落地时；回答不做精确相等断言 | **BLOCKED**（无已验证凭据；本机旧 `aika-crossplatform/.env` 存在但未读、有效性未知，需用户确认授权） |
| N01-REAL-ASR | ≥1 条非静音录音真实识别 + 静音负例 | whisper.cpp b5130（官方包 SHA256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c`）+ ggml-base.bin（SHA256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`）+ `samples/jfk.wav`，参数 language=auto/temperature=0（历史证据：Legacy `docs/stt/reports/LOCAL_WHISPER_SETUP_20260917.md`） | **BLOCKED**：`E:/Work/toolchains/whisper-b5130` 所在盘当前不存在。恢复步骤：重新下载上述官方资产（hash 复核）或用户提供原目录 |
| N01-REAL-TTS | 固定文本→真实合成→音频可解码且时长>0 | 上游仅付费云 TTS（qwen/minimax）；候选免费路径：Windows SAPI、sherpa-onnx TTS（未验证，不做承诺） | **BLOCKED**：NEXT-06 择路；无可导出音频的后端只能证明接口调用，不算数 |

## 5. 环境与命令（AC 01-C/01-E 实测）

| 命令（cwd `windows/code/desktop-pet/`） | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next`（第 1 遍） | 0 | 18 tests / 18 pass / 0 fail |
| `npm run test:next`（第 2 遍） | 0 | 18/18 pass；剥离耗时字段后两遍输出逐行一致（`diff`=空），断言不依赖 sleep/联网 |
| `npm run test:next:real` | 2 | 显式 BLOCKED（无环境开关） |
| `PET_NEXT_REAL=1 npm run test:next:real` | 2 | 显式 BLOCKED（无用例已登记） |

本清单无密钥、无私人正文；Legacy 音频/私人数据不入库。
