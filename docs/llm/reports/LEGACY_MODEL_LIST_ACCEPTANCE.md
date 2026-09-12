# 设置页模型列表拉取与下拉选择 — 历史验收报告（原误标LLM-04）

日期：2026-09-11
范围：aika-crossplatform 前端设置页 + providerClient；不涉及 Runtime 编排与对话协议变更。

## 需求

设置弹窗中新增：按当前 Provider 配置拉取平台可用模型列表，并在下拉栏中选择模型，替代纯手填。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `aika-crossplatform/src/services/providerClient.ts` | 新增 `listModels(config, options)`：按协议适配 models 端点（OpenAI 兼容/Responses → `GET {base}/models`；Anthropic → `GET {base}/v1/models`；Gemini → `GET {base}/v1beta/models?key=…`），解析模型 ID 并按字典序返回；错误口径与 `post()` 一致（报出实际主机名）。Gemini 只保留支持 `generateContent` 的模型并去掉 `models/` 路径前缀。 |
| `aika-crossplatform/src/services/runtime/tokens.ts` | 新增端口 `ProviderModelsToken`（`llm.providerModels`），App 继续不直接 import providerClient。 |
| `aika-crossplatform/src/services/runtime/providerAdapter.ts` | 新增 `providerModels` 适配器，转发到 `listModels`。 |
| `aika-crossplatform/src/app/plugins/runtimePlugin.ts` | 注册 `ProviderModelsToken` 到 `provides` 与 registrar。 |
| `aika-crossplatform/src/App.tsx` | 「模型名称」字段下新增「获取模型列表 / 刷新模型列表」按钮与下拉选择；未填 API 地址或 Key 时给出提示而不发请求；切换平台预设与打开设置时清空旧列表；列表为空或失败时回退手动填写。 |
| `aika-crossplatform/src/App.css` | 新增 `.model-fetch-row/.model-fetch-button/.model-fetch-note/.model-select` 样式。 |
| `aika-crossplatform/src/services/providerClient.test.ts` | 新增 `listModels` 5 条用例。 |

## 测试证据

命令（PowerShell，cwd = aika-crossplatform）：

```
npx vitest run src/services/providerClient.test.ts src/app/plugins/plugins.test.ts src/services/runtime/providerAdapter.test.ts
```

退出码 0。结果：Test Files 3 passed (3)，Tests 39 passed (39)。

新增用例（全部 PASS）：

- 请求 OpenAI 兼容 /models 端点，返回按字典序排序的 id，带 Bearer 头。
- Anthropic 使用 `x-api-key` 头请求 `/v1/models`。
- Gemini 去掉 `models/` 前缀并只保留支持 `generateContent` 的模型（embedding 被过滤）。
- models 端点 401 时报出实际主机名与上游错误信息。
- 空列表如实返回空数组，不编造。

Linter：0 诊断。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| 四种协议都能拉到模型列表（单测覆盖各端点/请求头/解析） | PASS（单测级） | providerClient.test.ts listModels describe |
| 用户可在下拉中选择模型，也可保留手动填写 | PASS | App.tsx：下拉出现于列表非空时；`value` 不在列表中仍显示手动输入值 |
| 未填地址/Key 不发请求并提示 | PASS | `handleFetchModels` 前置校验 |
| 切换平台或重新打开设置后旧列表失效 | PASS | `choosePreset` / `openSettings` 清空 models 与状态 |
| 端口化：App 不直接 import providerClient | PASS | App.tsx 经 `useService(ProviderModelsToken)` 取得 |

## 共享接口影响

- 新增 token `llm.providerModels`（仅新增，未变更既有 token）；注册方为 `runtimePlugin`，消费方仅 `App.tsx`。
- 无既有消费者受影响；无 Tauri 命令变更。

## 待联调项（NOT RUN）

- 真实平台端到端拉取（OpenAI / 通义 / DeepSeek / Anthropic / Gemini / 自定义中转）未在本阶段执行，需真实 Key 联调。单测只证明端点、请求头、解析与错误口径编排正确。
