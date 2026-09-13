//! 远程出站网关（FE-15 宿主侧）。
//!
//! 手机不是第二个客户端，是一块远程屏幕——所以这里**只做字节搬运与准入**，
//! 不做任何业务判断。真正的语义（白名单投影、turnId→授权目标、cursor 单调、
//! trace 四门）在 TS 侧 `services/outbound/outboundGateway.ts`（FE-14）。
//!
//! 本模块承担的 Host 侧职责（对应 FE-15-B/C/E）：
//! - **会话缓存**：每主体/会话最多 500 帧并设总字节上限，超限明确截断。
//! - **cursor/epoch**：请求带 epoch+cursor，返回 events/oldest/latest/gap；
//!   epoch 变化或 cursor 过期 → 明确 `gap`，不从 0 盲目执行旧命令。
//! - **准入**：Origin 白名单、尺寸上限、认证（凭证门在 TS 侧 FE-17-pre）。
//! - **Runtime 在线性**：Runtime 心跳失联时 POST 命令返回 503，不伪称完成。
//!
//! 旧手机路由（`/api/messages`、`/api/send`）只兼容业务载荷，必须走同一套
//! 认证与曝光开关，`?t=` 不再授予长期权限。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 每主体/会话最多缓存的帧数（SPEC：500）。
pub const MAX_BUFFER_FRAMES: usize = 500;
/// 每主体/会话帧缓存的总字节上限（SPEC：设总字节上限）。
pub const MAX_BUFFER_BYTES: usize = 4 * 1024 * 1024;
/// 单条请求体上限。
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// 长轮询单次等待上限（SPEC：≤25s）。
pub const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(25);
/// Runtime 心跳失效判定窗口。
pub const RUNTIME_STALE_AFTER: Duration = Duration::from_secs(30);

/// 一帧缓存项。`seq` 是宿主分配的单调序号（全局 epoch 内）。
#[derive(Clone, Debug)]
pub struct BufferedFrame {
    pub seq: u64,
    pub bytes: usize,
    /// 已序列化好的帧 JSON；宿主不解析它（业务形状归 TS 侧）。
    pub payload: String,
}

/// 按会话归属的帧缓存，带数量与字节双上限。
///
/// 超限时从**最旧**的一端丢弃并计数——丢的是历史，保留的是最新状态，
/// 这样重连的客户端至少能看到当前值；被丢掉的部分通过 `gap` 如实告知，
/// 不谎称连续。
#[derive(Default)]
pub struct FrameBuffer {
    frames: VecDeque<BufferedFrame>,
    bytes: usize,
    dropped: u64,
}

impl FrameBuffer {
    pub fn push(&mut self, frame: BufferedFrame) {
        self.bytes += frame.bytes;
        self.frames.push_back(frame);
        while self.frames.len() > MAX_BUFFER_FRAMES || self.bytes > MAX_BUFFER_BYTES {
            match self.frames.pop_front() {
                Some(dropped) => {
                    self.bytes -= dropped.bytes;
                    self.dropped += 1;
                }
                None => break,
            }
        }
    }

    /// 取 `after` 之后的所有帧。返回 `(帧, 是否发生截断)`。
    ///
    /// 截断的判定：请求的 cursor 比缓存里最旧的一帧还旧——说明中间有帧已被
    /// 丢弃，客户端必须重新同步，而不是从当前位置无缝续读。
    pub fn since(&self, after: Option<u64>) -> (Vec<BufferedFrame>, bool) {
        let Some(oldest) = self.frames.front().map(|frame| frame.seq) else {
            // 缓存空：只要历史上丢过帧，就算一次截断。
            return (Vec::new(), self.dropped > 0);
        };
        let truncated = match after {
            Some(cursor) => cursor + 1 < oldest,
            None => self.dropped > 0,
        };
        let selected = self
            .frames
            .iter()
            .filter(|frame| after.map(|cursor| frame.seq > cursor).unwrap_or(true))
            .cloned()
            .collect();
        (selected, truncated)
    }

    pub fn cursor_window(&self) -> (Option<u64>, Option<u64>) {
        (
            self.frames.front().map(|frame| frame.seq),
            self.frames.back().map(|frame| frame.seq),
        )
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// 缓存里是否还有帧（长轮询靠它判断要不要继续等）。
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

/// 一个已配对会话的宿主侧状态。
struct Session {
    /// 会话归属主体；命令的带外主体取自这里，**不信任 body**。
    principal_id: String,
    /// 会话 id：帧缓存与订阅的归属键（同一主体可有多个会话）。
    conversation_id: String,
    /// 最后发布该会话帧的连接标识（TS 侧的投递目标）。
    ///
    /// 只用于诊断可见性——**不用它做授权判断**：授权永远由
    /// （主体 + 会话）决定，连接 id 是客户端可控的提示性字段。
    last_connection_id: Option<String>,
    buffer: FrameBuffer,
}

/// 网关的进程内状态。
///
/// 注意：帧缓存只缓存**已经产生**的帧，网关不生产帧——生产在 TS 侧。
/// 所以 Runtime 停摆时这里不会凭空造数据，只会如实报 offline。
pub struct GatewayState {
    /// 重启即换；与 TS 侧 gatewayEpoch 对齐（由 TS 在 publish 时带进来）。
    epoch: Mutex<String>,
    sessions: Mutex<HashMap<String, Session>>,
    /// 全局单调 seq：cursor 单调的保证。
    seq: AtomicU64,
    /// Runtime 最近一次心跳时刻。
    last_heartbeat: Mutex<Option<Instant>>,
    /// Runtime 是否声明在线。
    runtime_online: AtomicBool,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            epoch: Mutex::new(String::new()),
            sessions: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            last_heartbeat: Mutex::new(None),
            runtime_online: AtomicBool::new(false),
        }
    }
}

/// 客户端读帧的结果，直接序列化成 HTTP 响应体。
#[derive(Debug)]
pub struct EventsPage {
    pub epoch: String,
    pub events: Vec<String>,
    pub oldest: Option<u64>,
    pub latest: Option<u64>,
    /// 需要重新同步（cursor 过期 / epoch 变化 / 缓存曾截断）。
    pub gap: bool,
    /// Runtime 是否在线（离线时客户端不该显示「她在想」）。
    pub runtime_online: bool,
}

/// 命令准入结果。
#[derive(Debug, PartialEq, Eq)]
pub enum CommandAdmission {
    /// 已受理，携带 requestId 供关联终态。
    Accepted { request_id: String },
    /// Runtime 不在线——明确 503，不伪称完成。
    RuntimeOffline,
    /// 会话不可识别或已被撤销。
    Unauthorized(&'static str),
    /// 请求体超限或格式不对。
    Rejected(&'static str),
}

impl GatewayState {
    pub fn set_epoch(&self, epoch: &str) {
        if let Ok(mut current) = self.epoch.lock() {
            *current = epoch.to_string();
        }
    }

    pub fn epoch(&self) -> String {
        self.epoch.lock().map(|guard| guard.clone()).unwrap_or_default()
    }

    /// 登记/更新一个受信会话（凭证门通过后由调用方登记）。
    pub fn upsert_session(&self, principal_id: &str, conversation_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions
                .entry(session_key(principal_id, conversation_id))
                .or_insert_with(|| Session {
                    principal_id: principal_id.to_string(),
                    conversation_id: conversation_id.to_string(),
                    last_connection_id: None,
                    buffer: FrameBuffer::default(),
                });
        }
    }

    /// 撤销某主体的全部会话：立即不可见，且其缓存被清空（不留下可读残留）。
    pub fn revoke_principal(&self, principal_id: &str) -> usize {
        let Ok(mut sessions) = self.sessions.lock() else {
            return 0;
        };
        let keys: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| session.principal_id == principal_id)
            .map(|(key, _)| key.clone())
            .collect();
        for key in &keys {
            sessions.remove(key);
        }
        keys.len()
    }

    pub fn has_session(&self, principal_id: &str, conversation_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(&session_key(principal_id, conversation_id)))
            .unwrap_or(false)
    }

    /// 脱敏会话清单：只有主体/会话与缓存规模，无任何正文或凭证。
    /// 供宿主诊断与 FE-17-host/dev-relay 的设备/会话可见性使用。
    pub fn session_summaries(&self) -> Vec<SessionSummary> {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .values()
                    .map(|session| SessionSummary {
                        principal_id: session.principal_id.clone(),
                        conversation_id: session.conversation_id.clone(),
                        last_connection_id: session.last_connection_id.clone(),
                        buffered_frames: session.buffer.len(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 缓存一帧，不带来源连接（测试与内部调用用）。
    #[cfg(test)]
    pub fn buffer_frame(&self, principal_id: &str, conversation_id: &str, payload: String) -> u64 {
        self.buffer_frame_from(principal_id, conversation_id, None, payload)
    }

    /// 缓存一帧并记录来源连接（仅用于诊断可见性）。
    pub fn buffer_frame_from(
        &self,
        principal_id: &str,
        conversation_id: &str,
        connection_id: Option<&str>,
        payload: String,
    ) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let bytes = payload.len();
        if let Ok(mut sessions) = self.sessions.lock() {
            let session = sessions
                .entry(session_key(principal_id, conversation_id))
                .or_insert_with(|| Session {
                    principal_id: principal_id.to_string(),
                    conversation_id: conversation_id.to_string(),
                    last_connection_id: None,
                    buffer: FrameBuffer::default(),
                });
            if let Some(connection) = connection_id {
                session.last_connection_id = Some(connection.to_string());
            }
            session.buffer.push(BufferedFrame { seq, bytes, payload });
        }
        seq
    }

    /// 该会话缓存里是否已有帧（长轮询据此决定要不要立刻返回）。
    pub fn has_frames(&self, principal_id: &str, conversation_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .get(&session_key(principal_id, conversation_id))
                    .map(|session| !session.buffer.is_empty())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// 读帧。`after` 是客户端上次看到的 seq。
    pub fn read_events(
        &self,
        principal_id: &str,
        conversation_id: &str,
        client_epoch: Option<&str>,
        after: Option<u64>,
    ) -> EventsPage {
        let server_epoch = self.epoch();
        // epoch 变化 = 重启，旧 cursor 一律作废，必须重同步。
        let epoch_changed = client_epoch.map(|value| value != server_epoch).unwrap_or(true);
        let Ok(sessions) = self.sessions.lock() else {
            return EventsPage {
                epoch: server_epoch,
                events: Vec::new(),
                oldest: None,
                latest: None,
                gap: true,
                runtime_online: self.runtime_online(),
            };
        };
        let Some(session) = sessions.get(&session_key(principal_id, conversation_id)) else {
            return EventsPage {
                epoch: server_epoch,
                events: Vec::new(),
                oldest: None,
                latest: None,
                gap: true,
                runtime_online: self.runtime_online(),
            };
        };
        let (oldest, latest) = session.buffer.cursor_window();
        if epoch_changed {
            return EventsPage {
                epoch: server_epoch,
                events: Vec::new(),
                oldest,
                latest,
                gap: true,
                runtime_online: self.runtime_online(),
            };
        }
        let (frames, truncated) = session.buffer.since(after);
        EventsPage {
            epoch: server_epoch,
            events: frames.into_iter().map(|frame| frame.payload).collect(),
            oldest,
            latest,
            gap: truncated,
            runtime_online: self.runtime_online(),
        }
    }

    pub fn mark_runtime_online(&self) {
        self.runtime_online.store(true, Ordering::SeqCst);
        if let Ok(mut heartbeat) = self.last_heartbeat.lock() {
            *heartbeat = Some(Instant::now());
        }
    }

    pub fn mark_runtime_offline(&self) {
        self.runtime_online.store(false, Ordering::SeqCst);
    }

    /// Runtime 在线性：既看声明，也看心跳是否超期——只声明不心跳不算在线。
    pub fn runtime_online(&self) -> bool {
        if !self.runtime_online.load(Ordering::SeqCst) {
            return false;
        }
        match self.last_heartbeat.lock() {
            Ok(heartbeat) => heartbeat
                .map(|at| at.elapsed() < RUNTIME_STALE_AFTER)
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    /// 命令准入。**身份从会话取，不从请求体取**（FE-15-E：非主窗口不能伪造主体）。
    pub fn admit_command(
        &self,
        principal_id: &str,
        conversation_id: &str,
        body_len: usize,
    ) -> CommandAdmission {
        if body_len > MAX_BODY_BYTES {
            return CommandAdmission::Rejected("body-too-large");
        }
        if principal_id.trim().is_empty() || conversation_id.trim().is_empty() {
            return CommandAdmission::Unauthorized("no-session");
        }
        if !self.has_session(principal_id, conversation_id) {
            return CommandAdmission::Unauthorized("session-unknown");
        }
        if !self.runtime_online() {
            return CommandAdmission::RuntimeOffline;
        }
        let request_id = format!("req-{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1);
        CommandAdmission::Accepted { request_id }
    }
}

pub fn session_key(principal_id: &str, conversation_id: &str) -> String {
    format!("{principal_id}:{conversation_id}")
}

/// 脱敏会话摘要（无正文、无凭证）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SessionSummary {
    pub principal_id: String,
    pub conversation_id: String,
    /// 最近发布该会话帧的连接标识；仅诊断可见，不参与授权。
    pub last_connection_id: Option<String>,
    pub buffered_frames: usize,
}

/// Origin 校验：fail-closed。有 Origin 就必须在白名单内；没有 Origin 的
/// （同源导航、非浏览器客户端）交给调用方按凭证继续判断，但**不自动放行私有数据**。
pub fn check_origin(origin: Option<&str>, allowed: &[String]) -> Result<(), &'static str> {
    match origin {
        None => Ok(()),
        Some(value) if value.trim().is_empty() => Err("missing-origin"),
        Some(value) if allowed.iter().any(|item| item == value) => Ok(()),
        Some(_) => Err("bad-origin"),
    }
}

/// 旧路由兼容判定：`?t=` 不再授予长期权限。
///
/// 返回值只表示「这个路径是否属于旧兼容路由」；是否放行仍由统一认证门决定。
/// 生产里由 `classify_route` 的 `Legacy` 分支覆盖同一组路径，
/// 这个函数供路由测试与宿主诊断单点核对用。
#[cfg(test)]
pub fn is_legacy_route(path: &str) -> bool {
    matches!(path, "/api/messages" | "/api/send")
}

/// 路径 → 新协议路由分类。
#[derive(Debug, PartialEq, Eq)]
pub enum GatewayRoute {
    Events,
    Commands,
    /// 历史消息（首屏拉一次）；业务载荷由桌面端提供。
    History,
    Legacy(&'static str),
    NotFound,
}

pub fn classify_route(method: &str, path: &str) -> GatewayRoute {
    match (method, path) {
        ("GET", "/api/v1/events") => GatewayRoute::Events,
        ("POST", "/api/v1/commands") => GatewayRoute::Commands,
        ("GET", "/api/v1/history") => GatewayRoute::History,
        ("GET", "/api/messages") => GatewayRoute::Legacy("messages"),
        ("POST", "/api/send") => GatewayRoute::Legacy("send"),
        _ => GatewayRoute::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(payload: &str) -> BufferedFrame {
        BufferedFrame {
            seq: 0,
            bytes: payload.len(),
            payload: payload.to_string(),
        }
    }

    #[test]
    fn buffer_drops_oldest_beyond_frame_limit() {
        let mut buffer = FrameBuffer::default();
        for index in 0..(MAX_BUFFER_FRAMES + 20) {
            let mut item = frame("x");
            item.seq = index as u64 + 1;
            buffer.push(item);
        }
        assert_eq!(buffer.len(), MAX_BUFFER_FRAMES);
        let (_, latest) = buffer.cursor_window();
        // 保留的是最新的 500 帧，最旧 20 帧被丢掉。
        let (oldest, _) = buffer.cursor_window();
        assert_eq!(oldest, Some(21));
        assert_eq!(latest, Some((MAX_BUFFER_FRAMES + 20) as u64));
    }

    #[test]
    fn buffer_respects_byte_limit() {
        let mut buffer = FrameBuffer::default();
        // 每帧 1MB，字节上限 4MB → 最多留 4 帧。
        let big = "y".repeat(1024 * 1024);
        for index in 0..6u64 {
            let mut item = frame(&big);
            item.seq = index + 1;
            buffer.push(item);
        }
        assert!(buffer.len() <= MAX_BUFFER_BYTES / (1024 * 1024));
        assert!(buffer.bytes <= MAX_BUFFER_BYTES);
    }

    #[test]
    fn truncated_cursor_reports_gap_instead_of_pretending_continuous() {
        let mut buffer = FrameBuffer::default();
        for index in 0..(MAX_BUFFER_FRAMES + 10) as u64 {
            let mut item = frame("z");
            item.seq = index + 1;
            buffer.push(item);
        }
        // 请求一个已经很旧的 cursor（1）：中间被丢过，必须报 gap。
        let (frames, truncated) = buffer.since(Some(1));
        assert!(truncated, "过期 cursor 必须报截断");
        assert_eq!(frames.len(), MAX_BUFFER_FRAMES);
        // 请求最新 cursor：无截断。
        let latest = frames.last().map(|frame| frame.seq).unwrap_or(0);
        let (tail, truncated_tail) = buffer.since(Some(latest));
        assert!(!truncated_tail);
        assert!(tail.is_empty());
    }

    #[test]
    fn epoch_change_forces_resync() {
        let state = GatewayState::default();
        state.set_epoch("epoch-1");
        state.upsert_session("host-A", "conv-1");
        state.buffer_frame("host-A", "conv-1", "{\"a\":1}".to_string());

        // 同 epoch + 从头读：拿到帧，不报 gap。
        let page = state.read_events("host-A", "conv-1", Some("epoch-1"), None);
        assert_eq!(page.events.len(), 1);
        assert!(!page.gap);

        // epoch 变了（重启）：即使 cursor 合法也必须重同步。
        state.set_epoch("epoch-2");
        let page = state.read_events("host-A", "conv-1", Some("epoch-1"), Some(1));
        assert!(page.gap, "epoch 变化必须报 gap");
        assert!(page.events.is_empty());
    }

    #[test]
    fn revoked_session_is_not_readable() {
        let state = GatewayState::default();
        state.set_epoch("e");
        state.upsert_session("ext-A", "conv-1");
        state.buffer_frame("ext-A", "conv-1", "secret".to_string());
        assert!(state.has_session("ext-A", "conv-1"));

        assert_eq!(state.revoke_principal("ext-A"), 1);
        assert!(!state.has_session("ext-A", "conv-1"));
        let page = state.read_events("ext-A", "conv-1", Some("e"), None);
        assert!(page.gap);
        assert!(page.events.is_empty());
    }

    #[test]
    fn commands_require_live_runtime_and_known_session() {
        let state = GatewayState::default();
        state.set_epoch("e");
        state.upsert_session("ext-A", "conv-1");

        // 未登记会话 → 未授权。
        assert_eq!(
            state.admit_command("nobody", "conv-1", 10),
            CommandAdmission::Unauthorized("session-unknown")
        );
        // 已登记但 Runtime 离线 → 503（不伪称完成）。
        assert_eq!(state.admit_command("ext-A", "conv-1", 10), CommandAdmission::RuntimeOffline);

        // Runtime 上线后才受理。
        state.mark_runtime_online();
        match state.admit_command("ext-A", "conv-1", 10) {
            CommandAdmission::Accepted { request_id } => assert!(!request_id.is_empty()),
            other => panic!("期望 Accepted，得到 {other:?}"),
        }
    }

    #[test]
    fn oversized_body_is_rejected() {
        let state = GatewayState::default();
        state.upsert_session("ext-A", "conv-1");
        state.mark_runtime_online();
        assert_eq!(
            state.admit_command("ext-A", "conv-1", MAX_BODY_BYTES + 1),
            CommandAdmission::Rejected("body-too-large")
        );
    }

    #[test]
    fn origin_check_is_fail_closed() {
        let allowed = vec!["http://127.0.0.1:5173".to_string()];
        assert!(check_origin(Some("http://127.0.0.1:5173"), &allowed).is_ok());
        assert_eq!(check_origin(Some("http://evil.example"), &allowed), Err("bad-origin"));
        assert_eq!(check_origin(Some("   "), &allowed), Err("missing-origin"));
        // 无 Origin 交给凭证门继续判断，不在这里直接拒。
        assert!(check_origin(None, &allowed).is_ok());
    }

    #[test]
    fn runtime_goes_offline_without_heartbeat() {
        let state = GatewayState::default();
        state.set_epoch("e");
        state.upsert_session("ext-A", "conv-1");
        state.mark_runtime_online();
        assert!(state.runtime_online());
        // 把心跳置为超期：只声明在线不再算数。
        *state.last_heartbeat.lock().unwrap() = Some(Instant::now() - RUNTIME_STALE_AFTER * 2);
        assert!(!state.runtime_online());
        assert_eq!(state.admit_command("ext-A", "conv-1", 10), CommandAdmission::RuntimeOffline);
    }

    #[test]
    fn legacy_routes_are_recognised_but_not_privileged() {
        assert!(is_legacy_route("/api/messages"));
        assert!(is_legacy_route("/api/send"));
        assert!(!is_legacy_route("/api/v1/events"));
        assert_eq!(classify_route("GET", "/api/v1/events"), GatewayRoute::Events);
        assert_eq!(classify_route("POST", "/api/v1/commands"), GatewayRoute::Commands);
        assert_eq!(classify_route("GET", "/api/v1/history"), GatewayRoute::History);
        assert_eq!(classify_route("GET", "/api/messages"), GatewayRoute::Legacy("messages"));
        assert_eq!(classify_route("POST", "/api/send"), GatewayRoute::Legacy("send"));
        assert_eq!(classify_route("GET", "/api/v1/sql"), GatewayRoute::NotFound);
    }

    #[test]
    fn cursor_is_monotonic_across_sessions() {
        let state = GatewayState::default();
        state.set_epoch("e");
        let first = state.buffer_frame("a", "c1", "1".to_string());
        let second = state.buffer_frame("b", "c2", "2".to_string());
        assert!(second > first, "cursor 必须全局单调，跨会话不重置");
    }

    #[test]
    fn session_summaries_are_redacted_and_track_connection() {
        let state = GatewayState::default();
        state.set_epoch("e");
        state.buffer_frame_from("ext-A", "conv-1", Some("conn-7"), "{\"secret\":\"body\"}".to_string());
        let summaries = state.session_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].principal_id, "ext-A");
        assert_eq!(summaries[0].conversation_id, "conv-1");
        assert_eq!(summaries[0].last_connection_id.as_deref(), Some("conn-7"));
        assert_eq!(summaries[0].buffered_frames, 1);
        // 摘要里不能有任何正文残留。
        let rendered = format!("{summaries:?}");
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains("body"));
    }

    #[test]
    fn has_frames_reflects_buffer_state() {
        let state = GatewayState::default();
        state.set_epoch("e");
        assert!(!state.has_frames("ext-A", "conv-1"));
        state.buffer_frame("ext-A", "conv-1", "x".to_string());
        assert!(state.has_frames("ext-A", "conv-1"));
        assert!(!state.has_frames("ext-A", "conv-2"));
    }
}
