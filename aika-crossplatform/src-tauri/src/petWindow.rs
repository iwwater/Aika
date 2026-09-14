//! 桌宠窗口（FE-20）。
//!
//! 按需创建/销毁：隐藏即销毁，不常驻占内存；状态只有「设置开关」一份。
//! pet 窗口是多 JS context 的薄展示端，与主窗唯一通道是 Rust 中继
//! （`pet://presentation` 定向 emit），全产品仍只有一套 CompanionRuntime。
//!
//! 权限边界（2026-09-14 修订）：`pet_window_broadcast` 只允许主窗调用——
//! pet 侧伪造展示帧等于绕过主窗聚合；窗口找回/穿透恢复由主窗入口驱动。
//! 校验是运行时的窗口 label 检查（纯函数可测），不依赖 capabilities 静态清单。

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const PET_PRESENTATION_EVENT: &str = "pet://presentation";
pub const PET_SNAPSHOT_REQUEST_EVENT: &str = "pet://snapshot-request";
/// pet → 主窗的受控意图（FE-31）。
pub const PET_INTENT_EVENT: &str = "pet://intent";
pub const PET_WINDOW_LABEL: &str = "pet";
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 展示帧单帧上限：字幕/气泡各 2000 字符 + 结构开销，64KB 足够宽裕；
/// 超限在 Rust 侧直接拒绝，不依赖调用方自觉。
pub const MAX_BROADCAST_BYTES: usize = 64 * 1024;

/// pet 意图单条上限：文本 2000 字符 + 结构开销，8KB 足够宽裕。
pub const MAX_INTENT_BYTES: usize = 8 * 1024;

/// 运行时调用方校验（纯函数，单元可测）。
pub fn assert_allowed_caller(caller: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&caller) {
        Ok(())
    } else {
        Err(format!(
            "window \"{caller}\" is not allowed to call this command"
        ))
    }
}

fn pet_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(PET_WINDOW_LABEL)
}

/// 显示桌宠；已存在则 show + set_focus（重复 show 只显示已有窗口）。
#[tauri::command]
pub fn pet_window_show(app: AppHandle) -> Result<(), String> {
    if let Some(window) = pet_window(&app) {
        window
            .show()
            .map_err(|error| format!("failed to show pet window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("failed to focus pet window: {error}"))?;
        return Ok(());
    }
    let window =
        WebviewWindowBuilder::new(&app, PET_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
            .title("Aika")
            .center()
            .visible(true)
            // fallback 路径优先保证肉眼可见；正式 Live2D 接入后再恢复透明窗口。
            .transparent(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .min_inner_size(220.0, 300.0)
            .shadow(false)
            .inner_size(320.0, 420.0)
            .build()
            .map_err(|error| format!("failed to create pet window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus pet window: {error}"))
}

/// 隐藏桌宠；保留预创建的 WebView，下一次显示无需重走窗口创建链路。
#[tauri::command]
pub fn pet_window_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = pet_window(&app) {
        window
            .hide()
            .map_err(|error| format!("failed to hide pet window: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn pet_window_set_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = pet_window(&app).ok_or_else(|| "pet window not found".to_string())?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| format!("failed to set click-through: {error}"))
}

/// 找回：主显示器工作区内居中，并关闭穿透。窗口大于工作区时约束尺寸。
#[tauri::command]
pub fn pet_window_reset_position(app: AppHandle) -> Result<(), String> {
    let window = pet_window(&app).ok_or_else(|| "pet window not found".to_string())?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| format!("failed to disable click-through: {error}"))?;
    reset_to_work_area(&window)
}

/// 主窗把展示快照中继给 pet。**只允许主窗调用**（pet 不能伪造展示帧）。
#[tauri::command]
pub fn pet_window_broadcast(
    window: WebviewWindow,
    app: AppHandle,
    payload: Value,
) -> Result<(), String> {
    assert_allowed_caller(window.label(), &[MAIN_WINDOW_LABEL])?;
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BROADCAST_BYTES {
        return Err("pet broadcast payload too large".to_string());
    }
    app.emit_to(PET_WINDOW_LABEL, PET_PRESENTATION_EVENT, payload)
        .map_err(|error| format!("failed to emit to pet: {error}"))
}

/// pet 就绪后请求一次主窗当前快照（先订阅再请求，主窗 relay 收到后立即广播）。
#[tauri::command]
pub fn pet_window_request_snapshot(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    assert_allowed_caller(window.label(), &[PET_WINDOW_LABEL])?;
    app.emit_to(MAIN_WINDOW_LABEL, PET_SNAPSHOT_REQUEST_EVENT, ())
        .map_err(|error| format!("failed to request snapshot: {error}"))
}

/// pet 意图上行（FE-31，`pet.intent.v1`）。**只允许 pet 窗口调用**。
///
/// 与 broadcast 正好相反的方向与权限：主窗不能伪造 pet 的用户动作，pet 也不能
/// 伪造展示帧。这里只做两件事——来源校验与体积上限；形状白名单校验在主窗的
/// `validatePetIntent` 里（Rust 不复制那张表，避免两处口径漂移）。
#[tauri::command]
pub fn pet_intent_submit(
    window: WebviewWindow,
    app: AppHandle,
    payload: Value,
) -> Result<(), String> {
    assert_allowed_caller(window.label(), &[PET_WINDOW_LABEL])?;
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_INTENT_BYTES {
        return Err("pet intent payload too large".to_string());
    }
    app.emit_to(MAIN_WINDOW_LABEL, PET_INTENT_EVENT, payload)
        .map_err(|error| format!("failed to emit pet intent: {error}"))
}

/// pet 的「回到主窗」。
#[tauri::command]
pub fn pet_window_focus_main(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    Ok(())
}

#[cfg(windows)]
fn reset_to_work_area(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    let hwnd = window
        .hwnd()
        .map(|handle| HWND(handle.0))
        .map_err(|error| format!("failed to get pet hwnd: {error}"))?;
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("failed to query monitor info".to_string());
        }
        let work = info.rcWork;
        let work_width = (work.right - work.left).max(1);
        let work_height = (work.bottom - work.top).max(1);

        // 物理像素换算：窗口尺寸按工作区约束（逻辑坐标经 DPI 缩放后不越界）。
        let scale = window.scale_factor().unwrap_or(1.0);
        let max_logical_w = work_width as f64 / scale;
        let max_logical_h = work_height as f64 / scale;
        let (logical_w, logical_h) = {
            let size = window.outer_size().map_err(|error| error.to_string())?;
            let w = (size.width as f64 / scale).min(max_logical_w);
            let h = (size.height as f64 / scale).min(max_logical_h);
            (w, h)
        };
        if logical_w != max_logical_w || logical_h != max_logical_h {
            let _ = window.set_size(tauri::LogicalSize::new(logical_w, logical_h));
        }

        let centered_x = work.left + ((work_width as f64 - logical_w * scale) / 2.0) as i32;
        let centered_y = work.top + ((work_height as f64 - logical_h * scale) / 2.0) as i32;
        window
            .set_position(tauri::PhysicalPosition::new(centered_x, centered_y))
            .map_err(|error| format!("failed to move pet window: {error}"))
    }
}

#[cfg(not(windows))]
fn reset_to_work_area(window: &WebviewWindow) -> Result<(), String> {
    // 非 Windows 开发平台没有现成工作区 API：退化为当前显示器内居中，如实不假称精确。
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let x = monitor.position().x + ((monitor.size().width as i64 - size.width as i64) / 2) as i32;
    let y = monitor.position().y + ((monitor.size().height as i64 - size.height as i64) / 2) as i32;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_checks_deny_pet_broadcast_but_allow_menu_commands() {
        // 广播：主窗可发，pet 伪造被拒（FE-20-I 的运行时负例基础）。
        assert!(assert_allowed_caller("main", &[MAIN_WINDOW_LABEL]).is_ok());
        assert!(assert_allowed_caller("pet", &[MAIN_WINDOW_LABEL]).is_err());
        assert!(assert_allowed_caller("unknown", &[MAIN_WINDOW_LABEL]).is_err());
        // 快照请求与意图上行：只有 pet 发起，主窗不能伪造用户动作（FE-31-F）。
        assert!(assert_allowed_caller("pet", &[PET_WINDOW_LABEL]).is_ok());
        assert!(assert_allowed_caller("main", &[PET_WINDOW_LABEL]).is_err());
        assert!(assert_allowed_caller("unknown", &[PET_WINDOW_LABEL]).is_err());
    }
}
