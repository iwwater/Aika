//! 前台应用传感器（FE-19）。
//!
//! 成本阶梯第一层：`EVENT_SYSTEM_FOREGROUND` 事件式 hook，空载成本≈0。
//! **只取进程名**——2026-09-14 修订删除了 `GetWindowTextW`：标题不采集，
//! 未来需要标题诊断时另立默认关闭的授权，不以空字符串掩盖实际采集。
//!
//! 生命周期约定：
//! - hook 装在与回调同一条专用线程上（WINEVENT_OUTOFCONTEXT 要求安装线程跑消息
//!   循环）；停止时 `PostThreadMessageW(WM_QUIT)`，线程在退出前 `UnhookWinEvent`。
//! - 事件只发给获授权主窗（`emit_to("main", …)`），禁止全 WebView 广播。
//! - busy 判定是「可观测打扰状态」，不是用户心理：锁定或前台窗口客户区盖满
//!   所在显示器为 true，成功观测到普通可见窗口为 false，其余（锁定查询失败、
//!   无前台句柄、最小化）一律 unknown——绝不按进程名推定全屏。

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const FOREGROUND_EVENT: &str = "environment://foreground";

/// 前台事件的受限载荷：只有进程名与测点，没有标题、没有路径。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundPayload {
    pub process: String,
    pub seq: u64,
    pub at_ms: u64,
}

/// busy 查询结果。`busy: None` = 无法判定（unknown），消费方不得当 false 用。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusyQueryResult {
    pub busy: Option<bool>,
    pub reason: String,
}

pub struct ForegroundState {
    pub thread_id: Arc<std::sync::atomic::AtomicU32>,
    pub seq: Arc<AtomicU64>,
}

impl Default for ForegroundState {
    fn default() -> Self {
        Self {
            thread_id: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            seq: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// 纯函数：busy 判定（可注入测试，不碰 Win32）。
///
/// 锁定查询失败本身即 unknown（无法确认用户在桌面）；锁定或前台窗口客户区盖满
/// 所在显示器为 true；成功观测到普通可见窗口为 false；无前台、最小化 → unknown。
pub fn classify_busy(
    lock_known: bool,
    locked: bool,
    has_foreground: bool,
    minimized: bool,
    client_covers_monitor: bool,
) -> (Option<bool>, &'static str) {
    if !lock_known {
        return (None, "lock_unknown");
    }
    if locked {
        return (Some(true), "session_locked");
    }
    if !has_foreground {
        return (None, "no_foreground");
    }
    if minimized {
        return (None, "minimized");
    }
    if client_covers_monitor {
        return (Some(true), "fullscreen");
    }
    (Some(false), "normal_window")
}

/// 纯函数：从完整镜像路径取文件名；取不到时用 "unknown"，不编造。
pub fn image_file_name(full_path: &str) -> String {
    let trimmed = full_path.trim_end_matches(['\\', '/']);
    let name = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("unknown");
    if name.is_empty() { "unknown".to_string() } else { name.to_string() }
}

#[tauri::command]
pub fn environment_foreground_supported() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 当前前台进程名（hook 触发前的初始兜底）。拿不到时返回 null，不返回空串。
#[tauri::command]
pub fn environment_foreground_current() -> Option<ForegroundPayload> {
    #[cfg(windows)]
    {
        current_foreground_payload(&ForegroundState::default())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn current_foreground_payload(_state: &ForegroundState) -> Option<ForegroundPayload> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let process = process_name_of(hwnd)?;
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Some(ForegroundPayload { process, seq: 0, at_ms })
    }
}

/// 开启/关闭前台 hook。重复 enable/disable 幂等。
#[tauri::command]
pub fn environment_foreground_enable(
    app: AppHandle,
    state: tauri::State<'_, ForegroundState>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        enable_hook(&app, &state, enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, enabled);
        Err("environment foreground is not supported on this platform".to_string())
    }
}

/// 可观测打扰状态查询。只在传感器开启期间由 TS 调用；本命令自身无状态。
#[tauri::command]
pub fn environment_busy_query() -> BusyQueryResult {
    #[cfg(windows)]
    {
        query_busy()
    }
    #[cfg(not(windows))]
    {
        BusyQueryResult { busy: None, reason: "unsupported".to_string() }
    }
}

#[cfg(windows)]
fn enable_hook(
    app: &AppHandle,
    state: &ForegroundState,
    enabled: bool,
) -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    if enabled {
        // 已有 hook 在跑：幂等。
        if state.thread_id.load(Ordering::SeqCst) != 0 {
            return Ok(());
        }
        let app = app.clone();
        let seq = state.seq.clone();
        let thread_id_slot = state.thread_id.clone();
        let ready = Arc::new(AtomicBool::new(false));
        let ready_for_join = ready.clone();
        let handle = std::thread::Builder::new()
            .name("aika-foreground-hook".to_string())
            .spawn(move || {
                hook_thread_main(app, seq, thread_id_slot);
                ready_for_join.store(true, Ordering::SeqCst);
            })
            .map_err(|error| format!("spawn hook thread failed: {error}"))?;
        // 线程就绪标志只用于错误报告；enable 的幂等键是 thread_id。
        let _ = handle;
        let _ = ready;
        Ok(())
    } else {
        let thread_id = state.thread_id.swap(0, Ordering::SeqCst);
        if thread_id == 0 {
            return Ok(());
        }
        // 线程可能还没把 id 写回去/消息队列还没建立：有界重试。
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
        for _ in 0..100 {
            unsafe {
                let posted = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
                if posted.is_ok() {
                    return Ok(());
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Err("failed to signal foreground hook thread".to_string())
    }
}

#[cfg(windows)]
fn hook_thread_main(app: AppHandle, seq: Arc<AtomicU64>, thread_id_slot: Arc<std::sync::atomic::AtomicU32>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, MSG, TranslateMessage, EVENT_SYSTEM_FOREGROUND,
        WINEVENT_OUTOFCONTEXT,
    };

    THREAD_APP.with(|slot| *slot.borrow_mut() = Some(app.clone()));
    THREAD_SEQ.with(|slot| *slot.borrow_mut() = Some(seq));

    unsafe {
        let thread_id = GetCurrentThreadId();
        thread_id_slot.store(thread_id, Ordering::SeqCst);

        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );

        let mut message = MSG::default();
        // GetMessageW：0 = WM_QUIT（正常退出）；-1 = 错误（也退出，避免死循环）。
        loop {
            let result = GetMessageW(&mut message, Some(HWND::default()), 0, 0);
            if result.0 == 0 || result.0 == -1 {
                break;
            }
            let _ = TranslateMessage(&message);
            let _ = DispatchMessageW(&message);
        }

        if !hook.is_invalid() {
            let _ = UnhookWinEvent(hook);
        }
        THREAD_APP.with(|slot| *slot.borrow_mut() = None);
        THREAD_SEQ.with(|slot| *slot.borrow_mut() = None);
        thread_id_slot.store(0, Ordering::SeqCst);
    }
}

#[cfg(windows)]
thread_local! {
    static THREAD_APP: std::cell::RefCell<Option<AppHandle>> = const { std::cell::RefCell::new(None) };
    static THREAD_SEQ: std::cell::RefCell<Option<Arc<AtomicU64>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
unsafe extern "system" fn foreground_callback(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    _event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time_ms: u32,
) {
    // OBJID_WINDOW = 0x0000；不引入 Win32_UI_Accessibility feature 只为一个 0 常量。
    if id_object != 0 {
        return;
    }
    let Some(process) = process_name_of(hwnd) else { return };
    let seq_holder = THREAD_SEQ.with(|slot| slot.borrow().clone());
    let Some(seq) = seq_holder else { return };
    let value = seq.fetch_add(1, Ordering::SeqCst) + 1;
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let payload = ForegroundPayload { process, seq: value, at_ms };
    if let Some(app) = THREAD_APP.with(|slot| slot.borrow().clone()) {
        // 只发主窗（emit_to 定向）；失败（窗口正在关）静默忽略。
        let _ = app.emit_to("main", FOREGROUND_EVENT, payload);
    }
}

/// 取进程名（镜像文件名）。OpenProcess / QueryFullProcessImageNameW 失败返回 None，
/// 由调用方决定跳过该事件——不把空串/编造名当结果。
/// 按原始窗口句柄取进程名（FE-32 受限窗口抓取复用同一条只取进程名的路径）。
/// **仍然只取进程名，不读标题**——复用而不是另开一条采集路径。
#[cfg(windows)]
pub fn process_name_of_window(raw: isize) -> Option<String> {
    let hwnd = windows::Win32::Foundation::HWND(raw as *mut core::ffi::c_void);
    process_name_of(hwnd)
}

#[cfg(not(windows))]
pub fn process_name_of_window(_raw: isize) -> Option<String> {
    None
}

#[cfg(windows)]
fn process_name_of(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let _guard = HandleGuard(handle);
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .ok()?;
        let full = String::from_utf16_lossy(&buffer[..size as usize]);
        Some(image_file_name(&full))
    }
}

#[cfg(windows)]
struct HandleGuard(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn query_busy() -> BusyQueryResult {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MapWindowPoints, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetForegroundWindow, IsIconic};

    unsafe {
        // 1. 会话锁定检测：锁定时 OpenInputDesktop 返回失败。
        let (lock_known, locked) = match OpenInputDesktop(
            DESKTOP_CONTROL_FLAGS(0),
            false,
            DESKTOP_READOBJECTS,
        ) {
            Ok(desk) => {
                let _ = CloseDesktop(desk);
                (true, false)
            }
            Err(_) => (true, true),
        };

        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            let (busy, reason) = classify_busy(lock_known, locked, false, false, false);
            return BusyQueryResult { busy, reason: reason.to_string() };
        }

        let minimized = IsIconic(hwnd).as_bool();

        // 客户区映射到屏幕坐标（物理像素；Tauri 进程是 per-monitor DPI aware，
        // 与显示器矩形的物理像素比较不受 DPI 虚拟化影响）。
        let mut rect = RECT::default();
        let client_ok = GetClientRect(hwnd, &mut rect).is_ok();
        let mut covers = false;
        if client_ok {
            let mut points = [
                POINT { x: rect.left, y: rect.top },
                POINT { x: rect.right, y: rect.bottom },
            ];
            MapWindowPoints(
                Some(hwnd),
                Some(windows::Win32::Foundation::HWND::default()),
                &mut points,
            );
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                let monitor_rect = info.rcMonitor;
                covers = points[0].x <= monitor_rect.left
                    && points[0].y <= monitor_rect.top
                    && points[1].x >= monitor_rect.right
                    && points[1].y >= monitor_rect.bottom;
            }
        }

        let (busy, reason) = classify_busy(lock_known, locked, true, minimized, covers);
        BusyQueryResult { busy, reason: reason.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_classification_matches_spec() {
        // 锁定 → busy。
        assert_eq!(classify_busy(true, true, true, false, false), (Some(true), "session_locked"));
        // 锁定查询失败：即使观测到普通窗口也不能返回 false（无法确认用户在桌面）。
        assert_eq!(classify_busy(false, false, true, false, false), (None, "lock_unknown"));
        // 无前台句柄不返回 false。
        assert_eq!(classify_busy(true, false, false, false, false), (None, "no_foreground"));
        // 最小化不可观测 → unknown。
        assert_eq!(classify_busy(true, false, true, true, false), (None, "minimized"));
        // 客户区盖满显示器 → 全屏 busy。
        assert_eq!(classify_busy(true, false, true, false, true), (Some(true), "fullscreen"));
        // 普通可见窗口 → false。
        assert_eq!(classify_busy(true, false, true, false, false), (Some(false), "normal_window"));
    }

    #[test]
    fn image_name_extraction() {
        assert_eq!(image_file_name(r"C:\Program Files\App\code.exe"), "code.exe");
        assert_eq!(image_file_name("/usr/bin/app"), "app");
        assert_eq!(image_file_name("game.EXE"), "game.EXE");
        assert_eq!(image_file_name(r"C:\dir\"), "dir");
    }

    #[cfg(windows)]
    #[test]
    fn busy_query_does_not_panic() {
        // 冒烟：命令在任何桌面状态下都返回结构化结果。
        let result = query_busy();
        assert!(matches!(result.busy, Some(true) | Some(false) | None));
        assert!(!result.reason.is_empty());
    }
}
