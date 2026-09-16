//! 反向点击通道（MVP-12）。
//!
//! 方向是 **shell → Aiki**：把「用户点了宠物」这个事实报给派生本实例的 Aiki。
//! 四条硬约束写在这里，不是惯例而是边界：
//!
//! 1. **只有 owned 实例才有通道**。URL 与凭据都由 Aiki 在 spawn 时注入；缺任一个
//!    就整体不可用——attach 实例拿不到凭据，因此**零请求**，而不是「报给碰巧在跑的那个」。
//! 2. **只发回环**。URL 的 host 必须是 127.0.0.1 / localhost / ::1，其余一律拒绝。
//!    这不是通用 HTTP 客户端：没有重定向、没有任意 header、没有任意目标。
//! 3. **只报事实，不派发业务轮**。事件形状固定为 click；Aiki 决定怎么处理。
//! 4. **失败只记账**。不弹窗、不阻塞点击、不重试到成功，队列满丢最旧并计数。
//!
//! 队列只在内存里：进程重启后不回放历史点击（SPEC AC-B 明写）。

use serde::Serialize;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Aiki 在 spawn 时注入的两个环境变量名（与 `desktop_pet_process.rs` 一致）。
pub const CLICK_URL_ENV: &str = "PET_SHELL_CLICK_URL";
pub const CLICK_TOKEN_ENV: &str = "PET_SHELL_CLICK_TOKEN";

/// 反向契约版本。对面不认识就拒收，不做版本猜测。
const CLICK_SCHEMA_VERSION: u32 = 1;
/// 在途队列上限。点击是廉价事实，积压只说明对面不在线。
const CLICK_QUEUE_LIMIT: usize = 16;
/// 单次投递超时。
const CLICK_TIMEOUT_MS: u64 = 1500;
/// 连接失败 / 超时的重试次数：只重试一次，且沿用同一个 eventId。
const CLICK_RETRY_LIMIT: usize = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetClickPayload {
    pub button: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetClickEvent {
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub event_id: String,
    pub at_ms: u64,
    pub payload: PetClickPayload,
}

/// 可观测计数。不对外发、不落盘，只给设置页与验收读数用。
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetClickDiagnostics {
    /// 通道是否可用（凭据齐备）。false 时一切上报都是零请求。
    pub enabled: bool,
    pub enqueued: u64,
    pub delivered: u64,
    /// 队列满时被丢掉的旧点击。
    pub dropped: u64,
    pub retries: u64,
    pub failures: u64,
    /// 对面以 401/403 拒收的次数；出现即视为凭据失效并关闭通道。
    pub unauthorized: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClickEndpoint {
    host: String,
    port: u16,
    path: String,
    token: String,
}

#[derive(Debug, Default)]
struct ClickInner {
    endpoint: Option<ClickEndpoint>,
    queue: VecDeque<PetClickEvent>,
    in_flight: bool,
    /** eventId 的单调计数：与时间戳一起保证进程内唯一。 */
    next_id: u64,
    diagnostics: PetClickDiagnostics,
}

#[derive(Debug, Default)]
pub struct ClickChannel {
    inner: Mutex<ClickInner>,
}

/// 只允许 `http://<loopback>[:port]/path`。其余一律拒绝。
///
/// fail-closed 是刻意的：把「点击能送到哪儿」钉死在回环，攻击面就只剩本机；
/// 一旦允许任意 host，注入一个环境变量就等于给了 shell 一条外发通道。
fn parse_loopback_endpoint(url: &str) -> Option<(String, u16, String)> {
    let rest = url.trim().strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (raw_host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (authority, 80),
    };
    if port == 0 {
        return None;
    }
    let host = raw_host.trim_matches(|value| value == '[' || value == ']');
    let loopback = match host.parse::<IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    };
    if !loopback {
        return None;
    }
    Some((host.to_string(), port, path.to_string()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// 一条固定形状的 JSON POST。返回状态码；连接失败/超时返回 Err。
fn post_click(endpoint: &ClickEndpoint, body: &[u8]) -> Result<u16, String> {
    let address: SocketAddr = match endpoint.host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => SocketAddr::new(IpAddr::V4(v4), endpoint.port),
        Ok(IpAddr::V6(v6)) => SocketAddr::new(IpAddr::V6(v6), endpoint.port),
        // 非 IP 的回环写法只有 localhost，解析失败时**不回退到「随便找个地址」**：
        // 回环 v4 与用户的注入目标语义一致，且不可能指向外部。
        Err(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), endpoint.port),
    };
    let timeout = Duration::from_millis(CLICK_TIMEOUT_MS);
    let mut stream =
        TcpStream::connect_timeout(&address, timeout).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;

    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.path,
        endpoint.host,
        endpoint.port,
        endpoint.token,
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.write_all(body).map_err(|error| error.to_string())?;

    let mut status_line = String::new();
    BufReader::new(
        stream
            .try_clone()
            .map_err(|error| error.to_string())?,
    )
    .read_line(&mut status_line)
    .map_err(|error| error.to_string())?;
    // 响应体读完再关，避免对面「写完前我们已断开」这类假失败。
    let mut sink = Vec::new();
    let _ = stream.take(64 * 1024).read_to_end(&mut sink);

    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed status line: {}", status_line.trim()))
}

impl ClickChannel {
    /// 配置/关闭通道。任一参数缺失或 URL 不是回环，一律关成「不可用」。
    pub fn configure(&self, url: Option<&str>, token: Option<&str>) {
        let mut inner = self.inner.lock().expect("click channel poisoned");
        inner.endpoint = match (url, token) {
            (Some(url), Some(token)) => {
                let token = token.trim().to_string();
                match (parse_loopback_endpoint(url), token.is_empty()) {
                    (Some((host, port, path)), false) => {
                        Some(ClickEndpoint { host, port, path, token })
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        inner.diagnostics.enabled = inner.endpoint.is_some();
        if inner.endpoint.is_none() {
            inner.queue.clear();
        }
    }

    pub fn diagnostics(&self) -> PetClickDiagnostics {
        self.inner
            .lock()
            .expect("click channel poisoned")
            .diagnostics
            .clone()
    }

    /// 上报一次点击。返回是否入队；通道不可用时为 `false`，且不产生任何请求。
    pub fn report(self: &Arc<Self>) -> bool {
        let endpoint = {
            let mut inner = self.inner.lock().expect("click channel poisoned");
            let Some(endpoint) = inner.endpoint.clone() else {
                return false;
            };
            if inner.queue.len() >= CLICK_QUEUE_LIMIT {
                inner.queue.pop_front();
                inner.diagnostics.dropped += 1;
            }
            inner.next_id += 1;
            let at_ms = now_ms();
            let event_id = format!("{at_ms}-{}", inner.next_id);
            inner.queue.push_back(PetClickEvent {
                schema_version: CLICK_SCHEMA_VERSION,
                event_type: "click",
                event_id,
                at_ms,
                payload: PetClickPayload { button: "left" },
            });
            inner.diagnostics.enqueued += 1;
            if inner.in_flight {
                return true;
            }
            inner.in_flight = true;
            endpoint
        };
        // 投递放到线程上：点击路径绝不能等网络。
        let channel = Arc::clone(self);
        thread::spawn(move || channel.drain(endpoint));
        true
    }

    /// 串行投递：单在途 + 有界队列。队列空即结束并释放 in_flight。
    fn drain(self: Arc<Self>, endpoint: ClickEndpoint) {
        loop {
            let event = {
                let mut inner = self.inner.lock().expect("click channel poisoned");
                match inner.queue.pop_front() {
                    Some(event) => event,
                    None => {
                        inner.in_flight = false;
                        return;
                    }
                }
            };
            let Ok(body) = serde_json::to_vec(&event) else {
                continue;
            };
            let mut attempt = 0_usize;
            loop {
                match post_click(&endpoint, &body) {
                    Ok(status) if (200..300).contains(&status) => {
                        let mut inner = self.inner.lock().expect("click channel poisoned");
                        inner.diagnostics.delivered += 1;
                        break;
                    }
                    // 4xx：对面明确拒收，重试没有意义。401/403 视为凭据失效 → 关闭通道。
                    Ok(status) => {
                        let mut inner = self.inner.lock().expect("click channel poisoned");
                        inner.diagnostics.failures += 1;
                        inner.diagnostics.last_error =
                            Some(format!("click rejected with status {status}"));
                        if status == 401 || status == 403 {
                            inner.diagnostics.unauthorized += 1;
                            inner.endpoint = None;
                            inner.diagnostics.enabled = false;
                            inner.queue.clear();
                        }
                        break;
                    }
                    // 连接失败 / 超时：只重试一次，eventId 不变。
                    Err(error) => {
                        if attempt < CLICK_RETRY_LIMIT {
                            attempt += 1;
                            let mut inner = self.inner.lock().expect("click channel poisoned");
                            inner.diagnostics.retries += 1;
                            continue;
                        }
                        let mut inner = self.inner.lock().expect("click channel poisoned");
                        inner.diagnostics.failures += 1;
                        inner.diagnostics.last_error = Some(error);
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn accepts_only_loopback_http_endpoints() {
        assert_eq!(
            parse_loopback_endpoint("http://127.0.0.1:8766/api/pet/click"),
            Some(("127.0.0.1".to_string(), 8766, "/api/pet/click".to_string()))
        );
        assert_eq!(
            parse_loopback_endpoint("http://localhost:8766/api/pet/click"),
            Some(("localhost".to_string(), 8766, "/api/pet/click".to_string()))
        );
        // 无路径 → 根路径；无端口 → 80。
        assert_eq!(
            parse_loopback_endpoint("http://127.0.0.1"),
            Some(("127.0.0.1".to_string(), 80, "/".to_string()))
        );

        for rejected in [
            // 非回环：注入一个环境变量不得变成外发通道。
            "http://192.168.1.10:8766/api/pet/click",
            "http://example.test/api/pet/click",
            "http://0.0.0.0:8766/api/pet/click",
            // 非 http（含 https 与其它协议）。
            "https://127.0.0.1:8766/api/pet/click",
            "file:///etc/passwd",
            "127.0.0.1:8766/api/pet/click",
            // 端口非法。
            "http://127.0.0.1:0/api/pet/click",
            "http://127.0.0.1:not-a-port/api/pet/click",
            "",
        ] {
            assert!(
                parse_loopback_endpoint(rejected).is_none(),
                "accepted {rejected}"
            );
        }
    }

    /// 真起一个监听者，验证「点击真的变成一条带凭据的 POST」。
    #[test]
    fn delivers_a_click_with_credentials_to_the_configured_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
        let port = listener.local_addr().unwrap().port();

        let channel = Arc::new(ClickChannel::default());
        channel.configure(
            Some(&format!("http://127.0.0.1:{port}/api/pet/click")),
            Some("test-click-token-0123456789"),
        );
        assert!(channel.diagnostics().enabled);
        assert!(channel.report());

        let (mut stream, _) = listener.accept().expect("accept click post");
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        let mut content_length = 0_usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break;
            }
            if let Some(value) = trimmed.strip_prefix("Content-Length: ") {
                content_length = value.parse().unwrap();
            }
            head.push_str(trimmed);
            head.push('\n');
        }
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();

        assert!(head.starts_with("POST /api/pet/click HTTP/1.1"), "{head}");
        assert!(
            head.contains("Authorization: Bearer test-click-token-0123456789"),
            "{head}"
        );
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["type"], "click");
        assert_eq!(payload["payload"]["button"], "left");
        assert!(payload["eventId"].as_str().is_some_and(|id| !id.is_empty()));
        assert!(payload["atMs"].as_u64().is_some_and(|at| at > 0));

        // 投递是异步的：等计数器落地，避免用 sleep 猜。
        for _ in 0..200 {
            if channel.diagnostics().delivered == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let diagnostics = channel.diagnostics();
        assert_eq!(diagnostics.delivered, 1);
        assert_eq!(diagnostics.failures, 0);
    }

    #[test]
    fn stays_silent_without_credentials_and_drops_queued_clicks_when_disabled() {
        let channel = Arc::new(ClickChannel::default());
        // 无凭据：不入队、不请求。
        assert!(!channel.report());
        assert!(!channel.diagnostics().enabled);
        assert_eq!(channel.diagnostics().enqueued, 0);

        // 只有 URL 没有令牌，同样不可用。
        channel.configure(Some("http://127.0.0.1:8766/api/pet/click"), None);
        assert!(!channel.report());
        // 令牌为空白也不行。
        channel.configure(Some("http://127.0.0.1:8766/api/pet/click"), Some("   "));
        assert!(!channel.report());
        // 非回环 URL 即使令牌齐备也关掉通道。
        channel.configure(Some("http://10.0.0.5:8766/x"), Some("token-0123456789"));
        assert!(!channel.report());
        assert!(!channel.diagnostics().enabled);
    }

    #[test]
    fn closes_the_channel_when_the_receiver_rejects_the_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
        let port = listener.local_addr().unwrap().port();

        let channel = Arc::new(ClickChannel::default());
        channel.configure(
            Some(&format!("http://127.0.0.1:{port}/api/pet/click")),
            Some("stale-click-token-0123456789"),
        );
        assert!(channel.report());

        let (mut stream, _) = listener.accept().expect("accept click post");
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        let mut content_length = 0_usize;
        loop {
            let mut current = String::new();
            reader.read_line(&mut current).unwrap();
            let trimmed = current.trim_end();
            if trimmed.is_empty() {
                break;
            }
            if let Some(value) = trimmed.strip_prefix("Content-Length: ") {
                content_length = value.parse().unwrap();
            }
            line.push_str(trimmed);
        }
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        stream
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();

        for _ in 0..200 {
            if channel.diagnostics().failures == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let diagnostics = channel.diagnostics();
        assert_eq!(diagnostics.unauthorized, 1);
        assert_eq!(diagnostics.delivered, 0);
        // 凭据失效后通道关闭：再点击不再入队、不再请求。
        assert!(!channel.report());
        assert!(!channel.diagnostics().enabled);
        assert_eq!(channel.diagnostics().enqueued, 1);
    }
}
