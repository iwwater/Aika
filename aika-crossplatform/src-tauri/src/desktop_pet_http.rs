//! 桌宠接入的原生 HTTP 传输（PET-03）。
//!
//! 页面**不能**指定 URL：它给的是固定端点 key。loopback 校验、固定路径、禁用
//! 代理与重定向、响应字节上限都在这一层强制——这样即使 WebView 里被注入脚本，
//! 也拿不到「请求任意地址」的能力。前端那份归一化是可用性，这份才是安全边界。
//!
//! 本模块只做字节搬运与准入：不做 schema 投影（在 TS 侧统一做），不做重试
//! （POST 绝不自动重发），不认识 Aiki 的业务概念。

use std::time::Duration;

use serde::Serialize;

/// 单请求硬超时；与 TS 侧 `PET_REQUEST_TIMEOUT_MS` 一致。
pub const REQUEST_TIMEOUT_MS: u64 = 1_500;
/// 响应体上限（256KiB）。超限直接判失败，不截断后当成功。
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// 允许的超时区间：调用方可以更紧，但不能把上限抬到无意义地大。
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 10_000;

/// 固定端点表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetEndpoint {
    Status,
    Say,
    Action,
    Event,
}

impl PetEndpoint {
    pub fn parse(key: &str) -> Option<Self> {
        match key {
            "status" => Some(Self::Status),
            "say" => Some(Self::Say),
            "action" => Some(Self::Action),
            "event" => Some(Self::Event),
            _ => None,
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::Status => "/api/status",
            Self::Say => "/api/say",
            Self::Action => "/api/action",
            Self::Event => "/api/event",
        }
    }

    pub fn is_post(self) -> bool {
        !matches!(self, Self::Status)
    }
}

/// 解析并归一化 loopback 端点，返回 `(host, port)`。
///
/// 只接受 `http://`、`127.0.0.1` / `localhost` / `::1`，且不得带凭证、路径、
/// query 或 fragment。`localhost` 归一化为 `127.0.0.1`，与 TS 侧同一口径。
pub fn parse_loopback_base(base: &str) -> Option<(String, u16)> {
    let rest = base.strip_prefix("http://")?;
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return None;
    }
    let (host, port_text) = rest.rsplit_once(':')?;
    if host.is_empty() || port_text.is_empty() {
        return None;
    }
    let host = match host {
        "127.0.0.1" | "localhost" => "127.0.0.1".to_string(),
        "[::1]" | "::1" => "[::1]".to_string(),
        _ => return None,
    };
    let port: u16 = port_text.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some((host, port))
}

/// 由固定表拼 URL；base 非法时返回 None，调用方据此判 blocked。
pub fn endpoint_url(base: &str, endpoint: PetEndpoint) -> Option<String> {
    let (host, port) = parse_loopback_base(base)?;
    Some(format!("http://{}:{}{}", host, port, endpoint.path()))
}

pub fn body_within_limit(len: usize) -> bool {
    len <= MAX_RESPONSE_BYTES
}

#[derive(Debug, Serialize)]
pub struct PetHttpOutcome {
    pub status: u16,
    pub body: String,
}

/// 失败只回一个分类码，不带上游正文、不带本机路径。
#[derive(Debug, Serialize)]
pub struct PetHttpError {
    pub kind: String,
}

impl PetHttpError {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
        }
    }
}

#[tauri::command]
pub async fn desktop_pet_http_request(
    base: String,
    endpoint: String,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<PetHttpOutcome, PetHttpError> {
    let endpoint = PetEndpoint::parse(&endpoint).ok_or_else(|| PetHttpError::new("blocked"))?;
    let url = endpoint_url(&base, endpoint).ok_or_else(|| PetHttpError::new("blocked"))?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(REQUEST_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    // 环境代理与重定向一概不用：桌宠只可能在本机，走代理既没意义又扩大攻击面。
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| PetHttpError::new("connection"))?;

    let mut request = if endpoint.is_post() {
        client
            .post(&url)
            .header("Content-Type", "application/json")
    } else {
        client.get(&url)
    };
    if let Some(payload) = body {
        request = request.body(payload);
    }

    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            PetHttpError::new("timeout")
        } else {
            PetHttpError::new("connection")
        }
    })?;

    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|error| {
        if error.is_timeout() {
            PetHttpError::new("timeout")
        } else {
            PetHttpError::new("connection")
        }
    })?;
    if !body_within_limit(bytes.len()) {
        return Err(PetHttpError::new("too_large"));
    }
    Ok(PetHttpOutcome {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_accepted_and_normalized() {
        assert_eq!(
            parse_loopback_base("http://127.0.0.1:17321"),
            Some(("127.0.0.1".to_string(), 17321))
        );
        assert_eq!(
            parse_loopback_base("http://localhost:17321"),
            Some(("127.0.0.1".to_string(), 17321))
        );
        assert_eq!(
            parse_loopback_base("http://[::1]:17321"),
            Some(("[::1]".to_string(), 17321))
        );
    }

    #[test]
    fn everything_that_is_not_loopback_http_is_rejected() {
        for bad in [
            "http://10.0.0.5:17321",
            "http://192.168.1.10:17321",
            "http://example.com:17321",
            "https://127.0.0.1:17321",
            "http://127.0.0.1:0",
            "http://127.0.0.1",
            "http://127.0.0.1:17321/api/status",
            "http://127.0.0.1:17321/?redirect=1",
            "http://user:pass@127.0.0.1:17321",
            "ftp://127.0.0.1:17321",
            "",
        ] {
            assert!(parse_loopback_base(bad).is_none(), "不应接受 {bad}");
        }
    }

    #[test]
    fn urls_come_from_the_fixed_table_only() {
        assert_eq!(
            endpoint_url("http://127.0.0.1:17321", PetEndpoint::Status).unwrap(),
            "http://127.0.0.1:17321/api/status"
        );
        assert_eq!(
            endpoint_url("http://localhost:17321", PetEndpoint::Event).unwrap(),
            "http://127.0.0.1:17321/api/event"
        );
        // base 非法时根本没有 URL 可拼。
        assert!(endpoint_url("http://10.0.0.5:17321", PetEndpoint::Say).is_none());
    }

    #[test]
    fn endpoint_keys_are_a_closed_set() {
        assert_eq!(PetEndpoint::parse("status").map(PetEndpoint::path), Some("/api/status"));
        assert_eq!(PetEndpoint::parse("say").map(PetEndpoint::path), Some("/api/say"));
        assert_eq!(PetEndpoint::parse("action").map(PetEndpoint::path), Some("/api/action"));
        assert_eq!(PetEndpoint::parse("event").map(PetEndpoint::path), Some("/api/event"));
        assert!(!PetEndpoint::parse("status").unwrap().is_post());
        assert!(PetEndpoint::parse("action").unwrap().is_post());
        // 不存在的端点必须是 None：否则页面就能自己造路径。
        assert!(PetEndpoint::parse("emotion").is_none());
        assert!(PetEndpoint::parse("../secret").is_none());
        assert!(PetEndpoint::parse("http://evil.example").is_none());
    }

    #[test]
    fn response_size_is_bounded() {
        assert!(body_within_limit(MAX_RESPONSE_BYTES));
        assert!(!body_within_limit(MAX_RESPONSE_BYTES + 1));
    }
}
