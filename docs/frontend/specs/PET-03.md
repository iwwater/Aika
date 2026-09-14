# PET-03 · OpenPet HTTP Adapter

状态：DRAFT / 实现 NOT RUN。需求 DPI-03；前置 PET-01 协议基线与 PET-02。依据 [契约](../DESKTOP_PET_CONTRACT.md)。

## 文件范围

`src/services/desktopPet/openPetAdapter.ts`、`openPetProtocol.ts`、定向测试与 fixtures；原生传输实现拟放 `src-tauri/src/desktop_pet_http.rs`，注册与注入只改 `src-tauri/src/lib.rs`、`src/app/hosts/` 的必要部分。不改 `petWindow.rs`、renderer 或第三方源码。

## 协议基线

| 方法 | 路径 | 请求 |
| --- | --- | --- |
| status | GET /api/status | 无 body |
| say | POST /api/say | `{ "text": "回来啦", "ttlMs": 4000 }` |
| action | POST /api/action | `{ "animationId": "<当前角色已验证ID>" }` |
| event | POST /api/event | `{ "type": "thinking", "message": "让我想一下……", "ttlMs": 4000 }` |

字段依据：[官方 CLI 实现](https://raw.githubusercontent.com/X-T-E-R/OpenPet/master/skills/openpet-cli/scripts/openpet_cli.py)。这是可变分支资料；实施必须用 PET-01 的锁定版本复核。没有 `/api/emotion`，也不引入 `/api/v1/action`。

## 实现要求

- 构造参数注入 HttpPort，生产使用原生宿主客户端、fake 只替换端口。Rust 端再次校验 loopback 与固定端点、body schema、大小限制；不把任意 URL 请求能力暴露给页面。
- 禁用代理与重定向，支持取消、超时、响应上限。1500ms 结束请求；只读探测可退避，POST 不自动重试。
- PET-01 的成功/失败 schema 成为 parser fixtures；200+错误对象、HTML、过大响应均不误报成功。发出后响应丢失=unknown。
- profile 将语义 action/emotion 转成 animationId。能力探测先 status + schema 校验，再结合角色映射；无显式 capabilities 端点不自造。
- 404/协议变化标 incompatible；可恢复连接错误标 offline。dispose 取消在途请求。

## 验收

| AC | 结果 |
| --- | --- |
| PET-03-A | 四端点黄金 fixture 精确校验方法、路径、body；emotion 只调用已验证 action |
| PET-03-B | 连接拒绝、POST 响应丢失、超时、4xx/5xx、200 错误体、坏 JSON、超大响应分类正确；POST 发送次数≤1 |
| PET-03-C | 非 loopback、跨地址 redirect、环境代理、任意路径均在生产传输层拒绝或禁用 |
| PET-03-D | 当前角色变化后不发送旧映射；未知响应不向任意服务发控制请求 |
| PET-03-E | fake 生产 adapter 测试与 Rust 本地 HTTP fixture 测试分别记录；真实 WebView→原生→OpenPet 留 PET-07 |

运行相关 Vitest 与对应 Rust 模块测试，避免全仓构建；记录实际命令在 `reports/PET-03_ACCEPTANCE.md`。禁止为了 CORS 去更改上游绑定地址或启用公网代理。
