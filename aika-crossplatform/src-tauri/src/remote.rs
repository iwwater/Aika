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

/// 桌面端跑完一轮要多久是模型说了算，不是我们说了算。
/// 超时只是为了不让一个卡死的请求永远占着连接，所以给得宽。
const REPLY_TIMEOUT: Duration = Duration::from_secs(180);
/// 停服务时最多等这么久：accept 循环按这个节奏醒来看一眼停止标志。
const POLL_INTERVAL: Duration = Duration::from_millis(300);

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
}

#[derive(Default)]
pub struct RemoteState {
    running: Mutex<Option<Running>>,
    /// 已经发给前端、还在等回答的请求。
    pending: Mutex<HashMap<String, Sender<String>>>,
    counter: AtomicU64,
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

fn handle(app: &AppHandle, state: &RemoteState, token: &str, mut request: Request) {
    let url = request.url().to_string();
    let path = path_of(&url).to_string();
    let given = header_token(&request).or_else(|| query_token(&url));

    // 哪怕只在家里的 WiFi 上：同一个网络里的任何设备都能读到她的记忆，
    // 这不能靠「应该没人会试」来防。
    if !given
        .map(|value| token_matches(token, &value))
        .unwrap_or(false)
    {
        let _ = request.respond(json_response(401, r#"{"error":"token 不对"}"#.to_string()));
        return;
    }

    if request.method() == &Method::Get && (path == "/" || path == "/index.html") {
        let _ = request.respond(html_response(include_str!("../mobile/index.html")));
        return;
    }

    let kind = match (request.method(), path.as_str()) {
        (&Method::Get, "/api/messages") => "messages",
        (&Method::Post, "/api/send") => "send",
        _ => {
            let _ = request.respond(json_response(404, r#"{"error":"没有这个接口"}"#.to_string()));
            return;
        }
    };

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
) -> Result<RemoteInfo, String> {
    if token.len() < 16 {
        return Err("token 太短了，至少 16 位".to_string());
    }
    stop_running(&state)?;

    let server = Server::http((Ipv4Addr::UNSPECIFIED, port))
        .map_err(|error| format!("端口 {port} 开不了：{error}"))?;
    let stop = Arc::new(AtomicBool::new(false));

    {
        let app = app.clone();
        let stop = stop.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match server.recv_timeout(POLL_INTERVAL) {
                    // 每个请求单独一个线程：发一轮要等模型，不能把取消息的轮询也堵住。
                    Ok(Some(request)) => {
                        let app = app.clone();
                        let token = token.clone();
                        std::thread::spawn(move || {
                            let state = app.state::<RemoteState>();
                            handle(&app, &state, &token, request);
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
    *state.running.lock().map_err(|_| "内部状态锁坏了")? = Some(Running { port, token, stop });
    Ok(info)
}

fn stop_running(state: &State<'_, RemoteState>) -> Result<(), String> {
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
}
