//! 反向点击通道的接收端（MVP-12）。
//!
//! 桌宠（PetShell）把「用户点了宠物」这个事实 POST 回来，这里受理。四条边界：
//!
//! 1. **只监听回环**，只有一个路由 `POST /api/pet/click`，端口由系统分配。
//! 2. **没武装就一律 403**：只有当前由我们派生、且仍在所有权存续期的实例能上报。
//! 3. **凭据一次性归属**：`arm` 生成新凭据并使旧凭据立即失效，`disarm` 后连它一起
//!    作废——这就是「撤销迟到输入」的落点（换实例＝换凭据，不是「同一个凭据长期有效」）。
//! 4. **版本封闭 + 按 eventId 去重**：`schemaVersion` 不是 1 就 400，不回退猜测；
//!    同一条 `eventId` 重复投递只计一次效果。
//!
//! 事件只发给**授权主窗**（与 `foreground` / `screen` 同一条规则），不做全 WebView 广播。
//! 受理只表示「Aiki 收到了一次已授权的点击事实」；点击在 Aiki 侧触发什么产品行为，
//! 由消费者决定，不在本模块里发明。

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    hash::{BuildHasher, Hasher},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

/// 事件名；只发给授权主窗。
pub const PET_CLICK_EVENT: &str = "pet://click";
/// 反向契约版本。不是它即 400。
pub const CLICK_SCHEMA_VERSION: u32 = 1;
/// 去重窗口：同一条 eventId 在窗口内重复投递只计一次效果。
const DEDUP_WINDOW: usize = 256;
const LOOPBACK: &str = "127.0.0.1";
const CLICK_ROUTE: &str = "/api/pet/click";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetClickPayload {
    pub button: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetClickEvent {
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub event_type: String,
    pub event_id: String,
    pub at_ms: u64,
    pub payload: PetClickPayload,
}

/// 计数。不落盘、不外发；供设置页与验收读数使用。
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetClickDiagnostics {
    /// 是否持有所有权（有实例被派生且未释放）。
    pub armed: bool,
    pub accepted: u64,
    pub duplicates: u64,
    /// 凭据不符。
    pub unauthorized: u64,
    /// 没有实例被武装时的投递。
    pub unarmed: u64,
    pub rejected_version: u64,
    pub rejected_body: u64,
    pub last_event_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct Inner {
    token: Option<String>,
    order: VecDeque<String>,
    seen: HashSet<String>,
    diagnostics: PetClickDiagnostics,
}

#[derive(Debug)]
pub struct PetClickEndpointState {
    port: u16,
    inner: Mutex<Inner>,
}

#[derive(Debug, PartialEq, Eq)]
enum AuthOutcome {
    Ok,
    /// 当前没有实例被武装：这种投递连凭据都不该有。
    Unarmed,
    /// 有实例在位，但凭据不符（含缺失）。
    Unauthorized,
}

#[derive(Debug, PartialEq, Eq)]
enum AcceptOutcome {
    Accepted,
    Duplicate,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// 生成一次性凭据。
///
/// 不引入 `rand`：`RandomState` 由 OS 播种且每次构造不同，配合时间与 pid 拼出 128 位。
/// 凭据只在内存里，随所有权释放一起丢弃，不进日志、不进快照、不落盘。
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    let first_seed = RandomState::new();
    let second_seed = RandomState::new();
    let mut first = first_seed.build_hasher();
    first.write_u128(now_ms() as u128);
    let mut second = second_seed.build_hasher();
    second.write_u64(u64::from(std::process::id()));
    second.write_u128(now_ms() as u128);
    format!("{:016x}{:016x}", first.finish(), second.finish())
}

impl PetClickEndpointState {
    pub fn url(&self) -> String {
        format!("http://{LOOPBACK}:{}{CLICK_ROUTE}", self.port)
    }

    /// 武装：生成新凭据并返回 `(url, token)`。旧凭据立刻失效——换实例就是换凭据。
    pub fn arm(&self) -> (String, String) {
        let token = random_token();
        let mut inner = self.inner.lock().expect("click endpoint poisoned");
        inner.token = Some(token.clone());
        inner.order.clear();
        inner.seen.clear();
        inner.diagnostics.armed = true;
        (self.url(), token)
    }

    /// 解除武装：归还所有权、撤销迟到输入。旧凭据立刻不可用。
    pub fn disarm(&self) {
        let mut inner = self.inner.lock().expect("click endpoint poisoned");
        inner.token = None;
        inner.order.clear();
        inner.seen.clear();
        inner.diagnostics.armed = false;
    }

    pub fn diagnostics(&self) -> PetClickDiagnostics {
        self.inner
            .lock()
            .expect("click endpoint poisoned")
            .diagnostics
            .clone()
    }

    fn authorize(&self, presented: Option<&str>) -> AuthOutcome {
        let inner = self.inner.lock().expect("click endpoint poisoned");
        let Some(expected) = inner.token.as_deref() else {
            return AuthOutcome::Unarmed;
        };
        match presented {
            Some(token) if token == expected => AuthOutcome::Ok,
            // 缺失与不符归一类：都不告诉对方差在哪。
            _ => AuthOutcome::Unauthorized,
        }
    }

    fn record(&self, update: impl FnOnce(&mut PetClickDiagnostics)) {
        let mut inner = self.inner.lock().expect("click endpoint poisoned");
        update(&mut inner.diagnostics);
    }

    fn accept(&self, event: &PetClickEvent) -> AcceptOutcome {
        let mut inner = self.inner.lock().expect("click endpoint poisoned");
        if inner.seen.contains(&event.event_id) {
            inner.diagnostics.duplicates += 1;
            return AcceptOutcome::Duplicate;
        }
        while inner.seen.len() >= DEDUP_WINDOW {
            match inner.order.pop_front() {
                Some(oldest) => {
                    inner.seen.remove(&oldest);
                }
                None => break,
            }
        }
        inner.order.push_back(event.event_id.clone());
        inner.seen.insert(event.event_id.clone());
        inner.diagnostics.accepted += 1;
        inner.diagnostics.last_event_at_ms = Some(event.at_ms);
        AcceptOutcome::Accepted
    }
}

/// 启动接收端：绑回环、端口由系统分配，返回可共享的状态。
pub fn start(app: AppHandle) -> Result<Arc<PetClickEndpointState>, String> {
    let listener = TcpListener::bind((LOOPBACK, 0))
        .map_err(|error| format!("failed to bind pet click endpoint: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("failed to read pet click endpoint port: {error}"))?
        .port();
    let state = Arc::new(PetClickEndpointState {
        port,
        inner: Mutex::new(Inner::default()),
    });

    let endpoint = Arc::clone(&state);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let endpoint = Arc::clone(&endpoint);
            let app = app.clone();
            thread::spawn(move || {
                let emit = |event: &PetClickEvent| {
                    let _ = app.emit_to(
                        crate::window_access::MAIN_WINDOW_LABEL,
                        PET_CLICK_EVENT,
                        event.clone(),
                    );
                };
                handle_stream(stream, &endpoint, &emit);
            });
        }
    });

    Ok(state)
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Result<Request, String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "missing method".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "missing path".to_string())?
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    let mut content_length = 0_usize;
    let mut authorization = None;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else { continue };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.trim().parse::<usize>().unwrap_or(0),
            "authorization" => authorization = Some(value.trim().to_string()),
            _ => {}
        }
    }

    // 上限 64 KiB：点击事件是几十字节，超出即视为异常负载。
    let mut body = vec![0_u8; content_length.min(64 * 1024)];
    if !body.is_empty() {
        reader
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
    }
    Ok(Request {
        method,
        path,
        authorization,
        body,
    })
}

/// 只接受 `Authorization: Bearer <token>`；裸令牌或其它方案都不是凭据。
fn bearer_token(header: Option<&str>) -> Option<String> {
    let value = header?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn handle_stream(
    mut stream: TcpStream,
    state: &PetClickEndpointState,
    on_click: &dyn Fn(&PetClickEvent),
) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let Ok(request) = read_request(&stream) else {
        let _ = respond_json(&mut stream, 400, &serde_json::json!({ "ok": false, "error": "bad request" }));
        return;
    };

    if request.method == "OPTIONS" {
        let _ = respond_empty(&mut stream, 204);
        return;
    }
    if request.method != "POST" || request.path != CLICK_ROUTE {
        let _ = respond_json(
            &mut stream,
            404,
            &serde_json::json!({ "ok": false, "error": "route not found" }),
        );
        return;
    }

    // ① 先认凭据：未武装 403（没有实例在位），凭据不符 401。
    match state.authorize(bearer_token(request.authorization.as_deref()).as_deref()) {
        AuthOutcome::Unarmed => {
            state.record(|diagnostics| diagnostics.unarmed += 1);
            let _ = respond_json(
                &mut stream,
                403,
                &serde_json::json!({ "ok": false, "error": "no owned pet instance is armed" }),
            );
            return;
        }
        AuthOutcome::Unauthorized => {
            state.record(|diagnostics| diagnostics.unauthorized += 1);
            let _ = respond_json(
                &mut stream,
                401,
                &serde_json::json!({ "ok": false, "error": "click credential rejected" }),
            );
            return;
        }
        AuthOutcome::Ok => {}
    }

    // ② 版本与形状封闭。
    let Ok(event) = serde_json::from_slice::<PetClickEvent>(&request.body) else {
        state.record(|diagnostics| diagnostics.rejected_body += 1);
        let _ = respond_json(
            &mut stream,
            400,
            &serde_json::json!({ "ok": false, "error": "invalid JSON body" }),
        );
        return;
    };
    if event.schema_version != CLICK_SCHEMA_VERSION {
        state.record(|diagnostics| diagnostics.rejected_version += 1);
        let _ = respond_json(
            &mut stream,
            400,
            &serde_json::json!({
                "ok": false,
                "error": format!("unsupported schemaVersion: {}", event.schema_version),
            }),
        );
        return;
    }
    if event.event_type != "click" || event.event_id.trim().is_empty() {
        state.record(|diagnostics| diagnostics.rejected_body += 1);
        let _ = respond_json(
            &mut stream,
            400,
            &serde_json::json!({ "ok": false, "error": "type must be click and eventId must be set" }),
        );
        return;
    }

    // ③ 去重后受理。
    let outcome = state.accept(&event);
    if outcome == AcceptOutcome::Accepted {
        on_click(&event);
    }
    let _ = respond_json(
        &mut stream,
        200,
        &serde_json::json!({
            "ok": true,
            "duplicate": outcome == AcceptOutcome::Duplicate,
        }),
    );
}

fn respond_json<T: Serialize>(stream: &mut TcpStream, status: u16, value: &T) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&body)
}

fn respond_empty(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        reason(status)
    );
    stream.write_all(head.as_bytes())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "OK",
    }
}

/// 只允许「主窗」调用 arm/disarm：不把「谁能让 Aiki 接受点击」变成任意窗口的能力。
pub fn assert_caller_allowed(caller: &str) -> Result<(), String> {
    crate::window_access::assert_allowed_caller(caller, &[crate::window_access::MAIN_WINDOW_LABEL])
}

/// 派生桌宠前要拿到的注入项：URL 与一次性凭据。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmOutcome {
    pub url: String,
    pub token: String,
}

/// 武装通道并返回注入项。每次调用都换新凭据，且只对**本次**派生有效。
#[tauri::command]
pub fn pet_click_arm(
    window: tauri::Window,
    state: tauri::State<'_, Arc<PetClickEndpointState>>,
) -> Result<ArmOutcome, String> {
    assert_caller_allowed(window.label())?;
    let (url, token) = state.arm();
    Ok(ArmOutcome { url, token })
}

/// 归还所有权：撤销迟到输入，凭据立刻失效。
#[tauri::command]
pub fn pet_click_disarm(
    window: tauri::Window,
    state: tauri::State<'_, Arc<PetClickEndpointState>>,
) -> Result<(), String> {
    assert_caller_allowed(window.label())?;
    state.disarm();
    Ok(())
}

/// 计数读数。**不含凭据**，所以不限制调用窗口。
#[tauri::command]
pub fn pet_click_diagnostics(
    state: tauri::State<'_, Arc<PetClickEndpointState>>,
) -> PetClickDiagnostics {
    state.diagnostics()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, version: u32) -> PetClickEvent {
        PetClickEvent {
            schema_version: version,
            event_type: "click".to_string(),
            event_id: id.to_string(),
            at_ms: 1_700_000_000_000,
            payload: PetClickPayload { button: "left".to_string() },
        }
    }

    fn state() -> PetClickEndpointState {
        PetClickEndpointState {
            port: 1,
            inner: Mutex::new(Inner::default()),
        }
    }

    #[test]
    fn arms_with_a_fresh_credential_and_retires_the_previous_one() {
        let endpoint = state();
        assert_eq!(endpoint.authorize(None), AuthOutcome::Unarmed);

        let (url, first) = endpoint.arm();
        assert!(url.ends_with(CLICK_ROUTE));
        assert_eq!(first.len(), 32, "凭据是 128 位十六进制");
        assert_eq!(endpoint.authorize(Some(&first)), AuthOutcome::Ok);

        // 换实例 = 换凭据：旧凭据立刻失效，而不是长期有效。
        let (_, second) = endpoint.arm();
        assert_ne!(first, second);
        assert_eq!(endpoint.authorize(Some(&first)), AuthOutcome::Unauthorized);
        assert_eq!(endpoint.authorize(Some(&second)), AuthOutcome::Ok);

        // 归还所有权后连当前凭据一起作废。
        endpoint.disarm();
        assert_eq!(endpoint.authorize(Some(&second)), AuthOutcome::Unarmed);
        assert!(!endpoint.diagnostics().armed);
    }

    #[test]
    fn rejects_missing_blank_and_non_bearer_credentials() {
        let endpoint = state();
        let (_, token) = endpoint.arm();
        assert_eq!(endpoint.authorize(None), AuthOutcome::Unauthorized);
        assert_eq!(endpoint.authorize(Some("")), AuthOutcome::Unauthorized);
        assert_eq!(endpoint.authorize(Some("   ")), AuthOutcome::Unauthorized);
        assert_eq!(endpoint.authorize(Some(&token[..token.len() - 1])), AuthOutcome::Unauthorized);

        // 裸令牌与非 Bearer 方案都不算凭据。
        assert_eq!(bearer_token(Some(&token)), None);
        assert_eq!(bearer_token(Some(&format!("Basic {token}"))), None);
        assert_eq!(bearer_token(Some(&format!("Bearer {token}"))).as_deref(), Some(token.as_str()));
        assert_eq!(bearer_token(Some("Bearer   ")), None);
    }

    #[test]
    fn dedups_repeated_event_ids_and_keeps_the_window_bounded() {
        let endpoint = state();
        endpoint.arm();

        assert_eq!(endpoint.accept(&event("a", 1)), AcceptOutcome::Accepted);
        assert_eq!(endpoint.accept(&event("a", 1)), AcceptOutcome::Duplicate);
        assert_eq!(endpoint.accept(&event("b", 1)), AcceptOutcome::Accepted);

        let diagnostics = endpoint.diagnostics();
        assert_eq!(diagnostics.accepted, 2);
        assert_eq!(diagnostics.duplicates, 1);

        // 窗口有界：灌满之后仍只记一次，且旧的被淘汰。
        for index in 0..DEDUP_WINDOW + 10 {
            endpoint.accept(&event(&format!("filler-{index}"), 1));
        }
        assert_eq!(endpoint.accept(&event("a", 1)), AcceptOutcome::Accepted);
    }

    /// 真起一个监听者，把 HTTP 层的状态码逐条钉住。
    #[test]
    fn answers_the_frozen_status_codes_over_a_real_socket() {
        let listener = TcpListener::bind((LOOPBACK, 0)).expect("bind test listener");
        let port = listener.local_addr().unwrap().port();
        let endpoint = Arc::new(PetClickEndpointState {
            port,
            inner: Mutex::new(Inner::default()),
        });

        let accepted = Arc::new(Mutex::new(0_u64));
        let endpoint_for_thread = Arc::clone(&endpoint);
        let counter = Arc::clone(&accepted);
        thread::spawn(move || {
            for stream in listener.incoming().take(6) {
                let Ok(stream) = stream else { continue };
                let endpoint = Arc::clone(&endpoint_for_thread);
                let counter = Arc::clone(&counter);
                thread::spawn(move || {
                    handle_stream(stream, &endpoint, &|_| {
                        *counter.lock().unwrap() += 1;
                    });
                });
            }
        });

        let call = |token: Option<&str>, body: &str| -> (u16, String) {
            let mut stream = TcpStream::connect((LOOPBACK, port)).expect("connect endpoint");
            let auth = token.map(|value| format!("Authorization: Bearer {value}\r\n")).unwrap_or_default();
            let request = format!(
                "POST {CLICK_ROUTE} HTTP/1.1\r\nHost: {LOOPBACK}:{port}\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            let status = response
                .split_whitespace()
                .nth(1)
                .and_then(|code| code.parse::<u16>().ok())
                .unwrap_or(0);
            (status, response)
        };

        let body = serde_json::to_string(&event("e1", CLICK_SCHEMA_VERSION)).unwrap();

        // 未武装：没有实例在位，403。
        assert_eq!(call(Some("whatever"), &body).0, 403);

        let (_, token) = endpoint.arm();
        // 凭据不符：401。
        assert_eq!(call(Some("wrong-token"), &body).0, 401);
        assert_eq!(call(None, &body).0, 401);
        // 版本封闭：400。
        let future = serde_json::to_string(&event("e2", CLICK_SCHEMA_VERSION + 1)).unwrap();
        assert_eq!(call(Some(&token), &future).0, 400);
        // 受理：200；重复投递同为 200 但标记 duplicate，且不再触发消费者。
        let (status, first) = call(Some(&token), &body);
        assert_eq!(status, 200);
        assert!(first.contains("\"duplicate\":false"), "{first}");
        let (status, second) = call(Some(&token), &body);
        assert_eq!(status, 200);
        assert!(second.contains("\"duplicate\":true"), "{second}");

        for _ in 0..100 {
            if endpoint.diagnostics().accepted == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let diagnostics = endpoint.diagnostics();
        assert_eq!(diagnostics.accepted, 1);
        assert_eq!(diagnostics.duplicates, 1);
        assert_eq!(diagnostics.unauthorized, 2);
        assert_eq!(diagnostics.unarmed, 1);
        assert_eq!(diagnostics.rejected_version, 1);
        assert_eq!(*accepted.lock().unwrap(), 1, "只有首次受理才通知消费者");
    }
}
