//! 手机远程终端。
//!
//! **手机不是第二个客户端，是一块远程屏幕。** 它不存任何东西，也不直接连模型：
//! 记忆只有电脑上那一份，Key 也只在电脑上。每一轮仍然在桌面端跑完，
//! 这里的 HTTP 服务只负责搬运请求和结果。
//!
//! 这么定的理由在 DEVELOPMENT_PLAN 的 M7：手机上放一个本地库再和电脑对账，
//! 就要处理冲突合并；一旦两边记的事对不上，「她记得」这条产品价值直接作废。
//!
//! 代价也写在那儿，不粉饰：**电脑不开机手机就用不了**，主动消息也推不到手机。
//!
//! 服务只在局域网里听。出门用 Tailscale，不要自己做公网穿透——
//! 把她的记忆挂到公网上换来的方便不值得。

use std::collections::HashMap;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::gateway::{self, CommandAdmission, GatewayRoute, GatewayState};

/// 桌面端跑完一轮要多久是模型说了算，不是我们说了算。
/// 超时只是为了不让一个卡死的请求永远占着连接，所以给得宽。
const REPLY_TIMEOUT: Duration = Duration::from_secs(180);
/// 停服务时最多等这么久：accept 循环按这个节奏醒来看一眼停止标志。
const POLL_INTERVAL: Duration = Duration::from_millis(300);
/// 长轮询的分片等待：每片这么长就醒一次，检查停止标志与是否有新帧。
/// 总等待仍受 `gateway::LONG_POLL_TIMEOUT` 约束。
const LONG_POLL_SLICE: Duration = Duration::from_millis(200);

/// HTTP 读/命令侧的主体标识。必须与 TS 侧 `src/domain/identity.ts` 的
/// `LOCAL_PRINCIPAL_ID = "local"` 一致：前端 `outbound_publish` 用那个值建会话，
/// 这里若用别的字符串，会话键（`principal:conversation`）对不上——
/// 手机读不到帧、命令恒 401 session-unknown（ISSUE_tauri_webview_blank.md 第五节）。
pub const LOCAL_PRINCIPAL: &str = "local";

/// 前端要处理的一次远程请求。
#[derive(Clone, Serialize)]
pub struct RemoteRequest {
    pub id: String,
    /// "messages" 取最近的对话，"send" 发一轮。
    pub kind: String,
    pub body: String,
}

#[derive(Clone, Serialize)]
pub struct RemoteInfo {
    pub port: u16,
    /// 手机上直接打开的地址，token 带在查询串里。
    pub url: String,
    /// 局域网地址；拿不到时是回环地址，这时候手机连不上，界面要说清楚。
    pub host: String,
}

struct Running {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    /// 本轮的 Origin 白名单；空 = 只接受无 Origin 的请求（非浏览器客户端）。
    allowed_origins: Vec<String>,
    /// 曝光开关：LAN 需用户显式启用；绑非 loopback 时同时要求它。
    lan_enabled: bool,
}

#[derive(Default)]
pub struct RemoteState {
    running: Mutex<Option<Running>>,
    /// 已经发给前端、还在等回答的请求。
    pending: Mutex<HashMap<String, Sender<String>>>,
    counter: AtomicU64,
    /// 远程出站网关（FE-15 宿主侧）。与运行中的 HTTP 服务共用，
    /// 服务未启动时也有值——命令准入要能独立判断「未运行」。
    gateway: GatewayState,
}

/// 本机在局域网里的地址。
///
/// std 没有枚举网卡的接口，所以用这个惯用法：向一个外部地址 connect 一个 UDP socket
/// （UDP 的 connect 不发包，只是让内核选路），再问它选了哪个本地地址。
fn lan_address() -> String {
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// 定长比较，不在第一个不同的字节上提前返回。
fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn query_token(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key == "t" {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn header_token(request: &Request) -> Option<String> {
    request.headers().iter().find_map(|header| {
        if header.field.equiv("Authorization") {
            header
                .value
                .as_str()
                .strip_prefix("Bearer ")
                .map(|token| token.to_string())
        } else {
            None
        }
    })
}

fn path_of(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

fn json_response(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
        .expect("static header");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn html_response(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .expect("static header");
    Response::from_string(body)
        .with_status_code(200)
        .with_header(header)
}

/// 取请求头里的 Origin（浏览器页面跨源时必带）。
fn header_origin(request: &Request) -> Option<String> {
    request.headers().iter().find_map(|header| {
        if header.field.equiv("Origin") {
            Some(header.value.as_str().to_string())
        } else {
            None
        }
    })
}

/// 取查询串里的某个参数。
fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key == name {
            Some(value.to_string())
        } else {
            None
        }
    })
}

/// 把一次远程请求交给前端，等它跑完。
///
/// 桌面端的那一份代码才知道怎么组提示词、怎么调模型、怎么落库，
/// 所以这里不做任何业务判断，只当搬运工。
fn ask_frontend(
    app: &AppHandle,
    state: &RemoteState,
    kind: &str,
    body: String,
) -> Result<String, String> {
    let id = format!("r{}", state.counter.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = channel::<String>();
    state
        .pending
        .lock()
        .map_err(|_| "内部状态锁坏了".to_string())?
        .insert(id.clone(), sender);

    let emitted = app.emit(
        "remote://request",
        RemoteRequest {
            id: id.clone(),
            kind: kind.to_string(),
            body,
        },
    );
    if let Err(error) = emitted {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&id);
        }
        return Err(format!("桌面端没有收到这次请求：{error}"));
    }

    let answer = receiver.recv_timeout(REPLY_TIMEOUT);
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&id);
    }
    answer.map_err(|_| "桌面端没有在时限内给出结果".to_string())
}

fn handle(app: &AppHandle, state: &RemoteState, running: &Running, request: Request) {
    let url = request.url().to_string();
    let path = path_of(&url).to_string();
    let method = request.method().clone();

    // Origin fail-closed：配了白名单就只在名单内放行（FE-15-B）。
    // 无 Origin 的客户端交给 token 门继续判断，不在这里直接拒。
    let origin = header_origin(&request);
    if gateway::check_origin(origin.as_deref(), &running.allowed_origins).is_err() {
        let _ = request.respond(json_response(403, r#"{"error":"origin 不在白名单"}"#.to_string()));
        return;
    }

    // 首页是唯一的公开资源；它本身不含任何数据。
    if method == Method::Get && (path == "/" || path == "/index.html") {
        let _ = request.respond(html_response(include_str!("../mobile/index.html")));
        return;
    }

    // **统一鉴权门**：新协议与旧兼容路由都从这里过，`?t=` 不再授予长期权限
    // ——token 只是「本次请求的凭证」，不是「长期授权」（FE-15 旧路由条款）。
    let given = header_token(&request).or_else(|| query_token(&url));
    if !given
        .map(|value| token_matches(&running.token, &value))
        .unwrap_or(false)
    {
        let _ = request.respond(json_response(401, r#"{"error":"token 不对"}"#.to_string()));
        return;
    }

    match gateway::classify_route(method.as_str(), &path) {
        GatewayRoute::Events => handle_events(state, running, &url, request),
        GatewayRoute::Commands => handle_commands(app, state, running, request),
        // 历史首屏拉一次：业务载荷仍由桌面端提供（宿主不解析消息）。
        GatewayRoute::History => handle_history(app, state, request),
        // 旧路由只兼容业务载荷，必须走统一鉴权与曝光开关。
        GatewayRoute::Legacy(kind) => handle_legacy(app, state, kind, request),
        GatewayRoute::NotFound => {
            let _ = request.respond(json_response(404, r#"{"error":"没有这个接口"}"#.to_string()));
        }
    }
}

/// GET /api/v1/history：首屏历史。业务载荷照旧交给前端组装，
/// 宿主只做鉴权与搬运——记忆只有电脑上那一份。
fn handle_history(app: &AppHandle, state: &RemoteState, mut request: Request) {
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(json_response(400, r#"{"error":"请求体读不出来"}"#.to_string()));
        return;
    }
    match ask_frontend(app, state, "messages", body) {
        Ok(payload) => {
            let _ = request.respond(json_response(200, payload));
        }
        Err(error) => {
            let message = serde_json::json!({ "error": error }).to_string();
            let _ = request.respond(json_response(504, message));
        }
    }
}

/// GET /api/v1/events：带 epoch/cursor 的增量读；无新帧则长轮询（≤25s）。
fn handle_events(state: &RemoteState, running: &Running, url: &str, request: Request) {
    // 主体/会话由服务端映射得出（这里单主体：token 即主体）。
    let conversation = query_param(url, "conversation").unwrap_or_else(|| "local".to_string());
    let principal = LOCAL_PRINCIPAL.to_string();
    let client_epoch = query_param(url, "epoch");
    let after = query_param(url, "cursor").and_then(|value| value.parse::<u64>().ok());
    let once = query_param(url, "once").map(|value| value == "1").unwrap_or(false);

    let mut page = state
        .gateway
        .read_events(&principal, &conversation, client_epoch.as_deref(), after);

    // 长轮询：没帧就等，直到有新帧、超时或服务停止。
    if !once && page.events.is_empty() {
        let deadline = std::time::Instant::now() + gateway::LONG_POLL_TIMEOUT;
        while std::time::Instant::now() < deadline {
            if running.stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(LONG_POLL_SLICE);
            // 快路径：先问有没有帧，没有就不必组装 Vec。
            if !state.gateway.has_frames(&principal, &conversation) {
                continue;
            }
            let retry = state
                .gateway
                .read_events(&principal, &conversation, client_epoch.as_deref(), after);
            if !retry.events.is_empty() {
                page = retry;
                break;
            }
            // Runtime 上线/下线这类状态变化也要及时告诉客户端。
            if retry.runtime_online != page.runtime_online {
                page = retry;
                break;
            }
        }
    }

    let body = serde_json::json!({
        "epoch": page.epoch,
        "events": page.events,
        "oldest": page.oldest,
        "latest": page.latest,
        "gap": page.gap,
        "runtimeStatus": if page.runtime_online { "online" } else { "offline" },
    })
    .to_string();
    let _ = request.respond(json_response(200, body));
}

/// POST /api/v1/commands：认证/Origin/尺寸检查后受理，202 只是 accepted。
///
/// 受理不等于完成：准入通过后把命令原样交给 TS 侧网关（FE-14 语义在这里收口）
/// ——宿主只做搬运，不解析业务字段；主体由服务端注入，不信任 body 身份。
/// TS 侧是否真正提交（body 校验/去重/授权）由它自行判断，失败不回 202 撤回
/// ——202 的语义就是「宿主已受理」，终态靠事件流。
fn handle_commands(app: &AppHandle, state: &RemoteState, _running: &Running, mut request: Request) {
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(json_response(400, r#"{"error":"请求体读不出来"}"#.to_string()));
        return;
    }
    let principal = LOCAL_PRINCIPAL.to_string();
    // 会话从 body 的显式声明读，但**身份不从 body 取**——主体由服务端固定。
    let conversation = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("conversationId").and_then(|item| item.as_str()).map(str::to_string))
        .unwrap_or_else(|| "local".to_string());

    match state.gateway.admit_command(&principal, &conversation, body.len()) {
        CommandAdmission::Accepted { request_id } => {
            // 命令下行（FE-15 → FE-14）：形状与 TS 侧 `AuthenticatedCommand` 一致
            // （tauriTransport 以 `payload.command` 取值）。raw 保持手机发来的
            // JSON 原样；connectionId 用本次请求 id，可追溯且不与 WS 连接混淆。
            let payload = serde_json::json!({
                "command": {
                    "raw": serde_json::from_str::<serde_json::Value>(&body)
                        .unwrap_or(serde_json::Value::String(body.clone())),
                    "principal": { "principalId": principal },
                    "conversationId": conversation,
                    "connectionId": format!("http:{request_id}"),
                }
            });
            let emitted = app.emit("outbound://command", payload);
            if let Err(error) = emitted {
                // 桌面端收不到就直说：不假确认。与 legacy 的超时语义一致。
                let message = serde_json::json!({ "error": format!("桌面端没有收到这次命令：{error}") }).to_string();
                let _ = request.respond(json_response(502, message));
                return;
            }
            let body = serde_json::json!({
                "accepted": true,
                "requestId": request_id,
                "conversationId": conversation,
            })
            .to_string();
            let _ = request.respond(json_response(202, body));
        }
        CommandAdmission::RuntimeOffline => {
            // 明确 503：Runtime 不在线时不执行也不假确认。
            let body = serde_json::json!({ "error": "runtime-offline" }).to_string();
            let _ = request.respond(json_response(503, body));
        }
        CommandAdmission::Unauthorized(reason) => {
            let body = serde_json::json!({ "error": reason }).to_string();
            let _ = request.respond(json_response(401, body));
        }
        CommandAdmission::Rejected(reason) => {
            let body = serde_json::json!({ "error": reason }).to_string();
            let _ = request.respond(json_response(400, body));
        }
    }
}

/// 旧手机路由：业务载荷兼容，但走同一鉴权（已在 `handle` 里过）。
fn handle_legacy(app: &AppHandle, state: &RemoteState, kind: &str, mut request: Request) {
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(json_response(400, r#"{"error":"请求体读不出来"}"#.to_string()));
        return;
    }
    match ask_frontend(app, state, kind, body) {
        Ok(payload) => {
            let _ = request.respond(json_response(200, payload));
        }
        Err(error) => {
            let message = serde_json::json!({ "error": error }).to_string();
            let _ = request.respond(json_response(504, message));
        }
    }
}

#[tauri::command]
pub fn remote_start(
    app: AppHandle,
    state: State<'_, RemoteState>,
    port: u16,
    token: String,
    // 可选参数用 Option：tauri 的 invoke 参数不能带 serde 属性。
    // allowed_origins：Origin 白名单（浏览器页面跨源时校验）；空/缺省 = 只接受无 Origin 客户端。
    // lan_enabled：LAN 需用户显式启用（FE-17-pre 分层）；未启用时只绑 loopback。
    allowed_origins: Option<Vec<String>>,
    lan_enabled: Option<bool>,
) -> Result<RemoteInfo, String> {
    let allowed_origins = allowed_origins.unwrap_or_default();
    let lan_enabled = lan_enabled.unwrap_or(false);
    if token.len() < 16 {
        return Err("token 太短了，至少 16 位".to_string());
    }
    stop_running(&state)?;

    // 默认 loopback；LAN 要用户显式开关（FE-15：LAN 按用户设置启用）。
    let bind = if lan_enabled { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST };
    let server = Server::http((bind, port))
        .map_err(|error| format!("端口 {port} 开不了：{error}"))?;
    if lan_enabled {
        // LAN 是明文传输，如实提醒，不假装端到端加密。
        eprintln!("[remote] LAN 已启用：传输为明文，非端到端加密");
    }
    let stop = Arc::new(AtomicBool::new(false));

    {
        let app = app.clone();
        let stop = stop.clone();
        let allowed_origins = allowed_origins.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match server.recv_timeout(POLL_INTERVAL) {
                    // 每个请求单独一个线程：长轮询最长等 25s，发一轮要等模型，
                    // 都不能把取消息的轮询或停止流程堵住（FE-15-C）。
                    Ok(Some(request)) => {
                        let app = app.clone();
                        let allowed_origins = allowed_origins.clone();
                        std::thread::spawn(move || {
                            let state = app.state::<RemoteState>();
                            let Some(running) = snapshot_running(&state) else {
                                return;
                            };
                            let running = Running {
                                allowed_origins,
                                ..running
                            };
                            handle(&app, &state, &running, request);
                        });
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        });
    }

    let host = lan_address();
    let info = RemoteInfo {
        port,
        host: host.clone(),
        url: format!("http://{host}:{port}/?t={token}"),
    };
    *state.running.lock().map_err(|_| "内部状态锁坏了")? = Some(Running {
        port,
        token,
        stop,
        allowed_origins,
        lan_enabled,
    });
    Ok(info)
}

/// 复制当前运行参数（含 token），供每个请求线程独立持有，避免长期持锁。
fn snapshot_running(state: &RemoteState) -> Option<Running> {
    let running = state.running.lock().ok()?;
    running.as_ref().map(|running| Running {
        port: running.port,
        token: running.token.clone(),
        stop: running.stop.clone(),
        allowed_origins: running.allowed_origins.clone(),
        lan_enabled: running.lan_enabled,
    })
}

fn stop_running(state: &RemoteState) -> Result<(), String> {
    if let Some(running) = state
        .running
        .lock()
        .map_err(|_| "内部状态锁坏了".to_string())?
        .take()
    {
        running.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn remote_stop(state: State<'_, RemoteState>) -> Result<(), String> {
    stop_running(&state)
}
#[tauri::command]
pub fn remote_status(state: State<'_, RemoteState>) -> Result<Option<RemoteInfo>, String> {
    let running = state
        .running
        .lock()
        .map_err(|_| "内部状态锁坏了".to_string())?;
    Ok(running.as_ref().map(|running| {
        let host = lan_address();
        RemoteInfo {
            port: running.port,
            url: format!("http://{host}:{}/?t={}", running.port, running.token),
            host,
        }
    }))
}

#[derive(Deserialize)]
pub struct RemoteAnswer {
    pub id: String,
    /// 已经序列化好的 JSON，原样回给手机。
    pub payload: String,
}

/// 前端跑完一轮之后把结果交回来。找不到 id 说明那次请求已经超时了，安静丢掉。
#[tauri::command]
pub fn remote_respond(state: State<'_, RemoteState>, answer: RemoteAnswer) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .map_err(|_| "内部状态锁坏了".to_string())?
        .remove(&answer.id);
    if let Some(sender) = sender {
        let _ = sender.send(answer.payload);
    }
    Ok(())
}

/// TS 侧发布一帧。**只有主窗口调用**（FE-15-E）——调用方在 lib.rs 里
/// 由口令 `outbound_publish` 暴露，非主窗口的 WebView 拿不到这个入口。
#[derive(Deserialize)]
pub struct OutboundPublishInput {
    pub principal_id: String,
    /// TS 侧的投递目标标识；宿主只用它参与会话缓存键，不做业务判断。
    #[serde(default)]
    pub connection_id: Option<String>,
    pub conversation_id: String,
    /// 已序列化好的帧 JSON；宿主不解析（业务形状归 TS 侧 FE-14）。
    pub frame: serde_json::Value,
    /// TS 侧的 gatewayEpoch；宿主与它对齐，用于 epoch 变化判定。
    #[serde(default)]
    pub epoch: Option<String>,
}

#[tauri::command]
pub fn outbound_publish(
    state: State<'_, RemoteState>,
    input: OutboundPublishInput,
) -> Result<u64, String> {
    if let Some(epoch) = input.epoch.as_deref() {
        state.gateway.set_epoch(epoch);
    }
    state.gateway.upsert_session(&input.principal_id, &input.conversation_id);
    let payload = input.frame.to_string();
    Ok(state.gateway.buffer_frame_from(
        &input.principal_id,
        &input.conversation_id,
        input.connection_id.as_deref(),
        payload,
    ))
}

/// Runtime 心跳：前端定时调用。超期未调用即视为离线，命令返回 503。
#[tauri::command]
pub fn outbound_heartbeat(state: State<'_, RemoteState>) -> Result<(), String> {
    state.gateway.mark_runtime_online();
    Ok(())
}

/// Runtime 主动声明离线（例如模型未配置）。
#[tauri::command]
pub fn outbound_offline(state: State<'_, RemoteState>) -> Result<(), String> {
    state.gateway.mark_runtime_offline();
    Ok(())
}

/// 撤销一个主体：立即不可见、缓存清空，且其后命令准入失败。
#[tauri::command]
pub fn outbound_revoke(state: State<'_, RemoteState>, principal_id: String) -> Result<usize, String> {
    Ok(state.gateway.revoke_principal(&principal_id))
}

/// 脱敏会话清单：只有主体/会话/缓存规模与最后来源连接，无正文与凭证。
/// 供宿主诊断面板与 FE-17-host 的会话可见性使用——**不含任何可读内容**。
#[tauri::command]
pub fn outbound_sessions(
    state: State<'_, RemoteState>,
) -> Result<Vec<gateway::SessionSummary>, String> {
    Ok(state.gateway.session_summaries())
}

#[cfg(test)]
mod tests {
    use super::{path_of, query_token, token_matches};

    #[test]
    fn token_comparison_requires_exact_match() {
        assert!(token_matches("abcdef0123456789", "abcdef0123456789"));
        assert!(!token_matches("abcdef0123456789", "abcdef012345678"));
        assert!(!token_matches("abcdef0123456789", "abcdef0123456780"));
        assert!(!token_matches("abcdef0123456789", ""));
    }

    #[test]
    fn token_comes_from_the_query_string() {
        assert_eq!(query_token("/?t=abc"), Some("abc".to_string()));
        assert_eq!(query_token("/api/messages?x=1&t=abc"), Some("abc".to_string()));
        assert_eq!(query_token("/api/messages"), None);
        // 只认名字正好是 t 的那个参数，token 后缀不算
        assert_eq!(query_token("/?tt=abc"), None);
    }

    #[test]
    fn path_ignores_the_query_string() {
        assert_eq!(path_of("/api/messages?t=abc"), "/api/messages");
        assert_eq!(path_of("/"), "/");
    }

    #[test]
    fn http_principal_matches_the_one_ts_publishes_under() {
        // 前端 hosts/index.ts 以 LOCAL_PRINCIPAL_ID("local") 调 outbound_publish 建会话；
        // handle_events/handle_commands 的主体必须与它一致，否则会话键错位：
        // 手机读不到帧、命令恒 401 session-unknown（ISSUE_tauri_webview_blank.md 第五节）。
        let state = super::RemoteState::default();
        let gateway = &state.gateway;
        gateway.upsert_session(super::LOCAL_PRINCIPAL, "local");
        gateway.buffer_frame(super::LOCAL_PRINCIPAL, "local", "{}".to_string());

        let page = gateway.read_events(super::LOCAL_PRINCIPAL, "local", Some(&gateway.epoch()), None);
        assert_eq!(page.events.len(), 1, "帧必须落在 HTTP 读取的同一会话键下");

        gateway.mark_runtime_online();
        assert!(matches!(
            gateway.admit_command(super::LOCAL_PRINCIPAL, "local", 16),
            super::CommandAdmission::Accepted { .. }
        ));
    }
}
