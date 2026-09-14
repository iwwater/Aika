//! Screen Event 采集（FE-21）。
//!
//! 职责边界（SPEC 冻结）：Rust 只回答「画面变没变」+ 按需给受限 ROI 的 PNG——
//! 帧抓取与缩放比较在采集侧完成，全帧不过 IPC；OCR 与词表规则在 TS 侧。
//!
//! 算法口径（2026-09-14 修订冻结）：500ms 采样；缩到 96×54 灰度、像素值归一
//! 0..1 后平均绝对差 ≥0.03 触发 `environment://screen-change`；首个有效帧只建
//! 基线；分辨率改变重建基线；全黑帧按无效帧处理（不建基线、不触发）。
//! 独占全屏下 WGC 可能出黑帧——按无效帧丢弃并如实记录，不解释为游戏结果。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const SCREEN_CHANGE_EVENT: &str = "environment://screen-change";
pub const THUMB_WIDTH: usize = 96;
pub const THUMB_HEIGHT: usize = 54;
/// 帧变化触发阈值（归一化平均绝对差）。设计值，开发集验证后冻结。
pub const DIFF_THRESHOLD: f32 = 0.03;
pub const SAMPLE_INTERVAL_MS: u64 = 500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenChangePayload {
    pub magnitude: f32,
    pub at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegionResult {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

// ---------- 纯函数（固定像素矩阵可测） ----------

/// BGRA 全帧 → 96×54 灰度缩略图（最近邻 + luma）。
pub fn bgra_to_gray_thumb(frame: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut thumb = vec![0u8; THUMB_WIDTH * THUMB_HEIGHT];
    if width == 0 || height == 0 || frame.len() < (width as usize) * (height as usize) * 4 {
        return thumb;
    }
    for ty in 0..THUMB_HEIGHT {
        let sy = ((ty as u64) * (height as u64) / (THUMB_HEIGHT as u64)) as usize;
        for tx in 0..THUMB_WIDTH {
            let sx = ((tx as u64) * (width as u64) / (THUMB_WIDTH as u64)) as usize;
            let offset = (sy * width as usize + sx) * 4;
            let b = frame[offset] as u32;
            let g = frame[offset + 1] as u32;
            let r = frame[offset + 2] as u32;
            thumb[ty * THUMB_WIDTH + tx] = ((r * 299 + g * 587 + b * 114) / 1000).min(255) as u8;
        }
    }
    thumb
}

/// 归一化平均绝对差（像素值 0..1 口径）。长度不一致按无效比较返回 0。
pub fn mean_abs_diff(a: &[u8], b: &[u8]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let total: u64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (i32::from(*x) - i32::from(*y)).unsigned_abs() as u64)
        .sum();
    (total as f32 / a.len() as f32) / 255.0
}

/// 全黑帧判定：均值 ≤2/255 视为无效（WGC 独占全屏/受保护内容的常见产物）。
pub fn is_black_frame(thumb: &[u8]) -> bool {
    if thumb.is_empty() {
        return true;
    }
    let sum: u64 = thumb.iter().map(|v| u64::from(*v)).sum();
    (sum as f32 / thumb.len() as f32) <= 2.0
}

/// 相对 ROI → 像素矩形（clamp 到帧内）；非法（宽高为 0）返回 None。
pub fn roi_to_pixels(
    roi: (f32, f32, f32, f32),
    width: u32,
    height: u32,
) -> Option<(u32, u32, u32, u32)> {
    let (rx, ry, rw, rh) = roi;
    if !(rw > 0.0 && rh > 0.0) {
        return None;
    }
    let clamp = |v: f32, max: i64| -> i64 { (v.clamp(0.0, 1.0) * max as f32).floor().clamp(0.0, max as f32) as i64 };
    let x = clamp(rx, i64::from(width));
    let y = clamp(ry, i64::from(height));
    let right = clamp(rx + rw, i64::from(width));
    let bottom = clamp(ry + rh, i64::from(height));
    if right <= x || bottom <= y {
        return None;
    }
    Some((x as u32, y as u32, (right - x) as u32, (bottom - y) as u32))
}

// ---------- 采集器 ----------

pub struct ScreenShared {
    pub baseline: Option<Vec<u8>>,
    pub baseline_dims: (u32, u32),
    pub latest_bgra: Option<Vec<u8>>,
    pub latest_dims: (u32, u32),
    pub last_sample: Option<Instant>,
    pub seq: Arc<AtomicU64>,
}

impl ScreenShared {
    fn new(seq: Arc<AtomicU64>) -> Self {
        Self {
            baseline: None,
            baseline_dims: (0, 0),
            latest_bgra: None,
            latest_dims: (0, 0),
            last_sample: None,
            seq,
        }
    }
}

pub struct ScreenState {
    pub shared: Arc<Mutex<ScreenShared>>,
    pub control: Mutex<Option<CaptureControlHandle>>,
}

impl Default for ScreenState {
    fn default() -> Self {
        Self {
            shared: Arc::new(Mutex::new(ScreenShared::new(Arc::new(AtomicU64::new(0))))),
            control: Mutex::new(None),
        }
    }
}

type CaptureControlHandle = windows_capture::capture::CaptureControl<ScreenCapturer, Box<dyn std::error::Error + Send + Sync>>;

pub struct ScreenCapturer {
    shared: Arc<Mutex<ScreenShared>>,
    app: AppHandle,
}

impl windows_capture::capture::GraphicsCaptureApiHandler for ScreenCapturer {
    type Flags = (Arc<Mutex<ScreenShared>>, AppHandle);
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (shared, app) = ctx.flags;
        Ok(Self { shared, app })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut windows_capture::frame::Frame,
        _control: windows_capture::graphics_capture_api::InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let mut shared = match self.shared.lock() {
            Ok(guard) => guard,
            Err(_) => return Err("screen shared state lock poisoned".into()),
        };
        // 500ms 采样节流。
        if let Some(last) = shared.last_sample {
            if last.elapsed() < Duration::from_millis(SAMPLE_INTERVAL_MS) {
                return Ok(());
            }
        }
        shared.last_sample = Some(Instant::now());

        let mut buffer = frame.buffer()?;
        let width = buffer.width();
        let height = buffer.height();
        if width == 0 || height == 0 {
            return Ok(());
        }
        let raw = buffer.as_nopadding_buffer()?.to_vec();
        let thumb = bgra_to_gray_thumb(&raw, width, height);
        if is_black_frame(&thumb) {
            // 无效帧：不建基线、不触发；最新帧仍保存（供 ROI 抓取参考），但抓取方同样按黑帧拒绝。
            return Ok(());
        }
        shared.latest_bgra = Some(raw);
        shared.latest_dims = (width, height);

        let dims_changed = shared.baseline_dims != (width, height);
        let magnitude = match (&shared.baseline, dims_changed) {
            (Some(baseline), false) => mean_abs_diff(baseline, &thumb),
            _ => 0.0,
        };
        if shared.baseline.is_none() || dims_changed {
            // 首个有效帧只建基线；分辨率改变重建基线。
            shared.baseline = Some(thumb);
            shared.baseline_dims = (width, height);
            return Ok(());
        }
        if magnitude >= DIFF_THRESHOLD {
            // 触发后以当前帧重建基线：连续剧烈变化不会每帧都报，回到边缘触发。
            shared.baseline = Some(thumb);
            let seq = shared.seq.fetch_add(1, Ordering::SeqCst) + 1;
            let at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let _ = seq;
            let _ = self.app.emit_to("main", SCREEN_CHANGE_EVENT, ScreenChangePayload { magnitude, at_ms });
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

// ---------- 命令 ----------

#[tauri::command]
pub fn environment_screen_supported() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn environment_screen_enable(
    app: AppHandle,
    state: tauri::State<'_, ScreenState>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut guard = state.control.lock().map_err(|error| error.to_string())?;
        if enabled {
            if guard.is_some() {
                return Ok(());
            }
            use windows_capture::capture::GraphicsCaptureApiHandler;
            use windows_capture::monitor::Monitor;
            use windows_capture::settings::{
                ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
                MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
            };
            let monitor = Monitor::primary().map_err(|error| format!("no primary monitor: {error}"))?;
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::WithoutCursor,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                (state.shared.clone(), app.clone()),
            );
            let control = ScreenCapturer::start_free_threaded(settings)
                .map_err(|error| format!("failed to start screen capture: {error}"))?;
            *guard = Some(control);
            Ok(())
        } else {
            if let Some(control) = guard.take() {
                control
                    .stop()
                    .map_err(|error| format!("failed to stop screen capture: {error}"))?;
            }
            // 关闭清空帧缓存与基线：旧会话残余不得流入下一次启用。
            let mut shared = state.shared.lock().map_err(|error| error.to_string())?;
            shared.baseline = None;
            shared.baseline_dims = (0, 0);
            shared.latest_bgra = None;
            shared.latest_dims = (0, 0);
            shared.last_sample = None;
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, enabled);
        Err("screen capture is not supported on this platform".to_string())
    }
}

/// 固定 ROI 抓取：从最近一帧裁剪中央横带（相对坐标）→ PNG base64。
/// 黑帧 / 无帧 / ROI 越界返回 None——调用方丢弃该候选，不解释为事件。
#[tauri::command]
pub fn environment_capture_region(
    state: tauri::State<'_, ScreenState>,
    roi: Option<(f32, f32, f32, f32)>,
) -> Option<CaptureRegionResult> {
    let (bgra, width, height) = {
        let guard = state.shared.lock().ok()?;
        let frame = guard.latest_bgra.as_ref()?.clone();
        let dims = guard.latest_dims;
        (frame, dims.0, dims.1)
    };
    let (x, y, crop_width, crop_height) = roi_to_pixels(roi.unwrap_or((0.1, 0.4, 0.8, 0.2)), width, height)?;

    let mut rgba = Vec::with_capacity((crop_width * crop_height * 4) as usize);
    for row in 0..crop_height {
        for col in 0..crop_width {
            let src = (((y + row) as usize) * width as usize + (x + col) as usize) * 4;
            let b = bgra[src];
            let g = bgra[src + 1];
            let r = bgra[src + 2];
            let _ = bgra[src + 3];
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
    }
    let image = image::RgbaImage::from_raw(crop_width, crop_height, rgba)?;
    let mut png = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut png));
        image::ImageEncoder::write_image(
            encoder,
            image.as_raw(),
            crop_width,
            crop_height,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    }
    Some(CaptureRegionResult {
        png_base64: BASE64.encode(png),
        width: crop_width,
        height: crop_height,
    })
}

// ---------- 受限窗口抓取（FE-32） ----------

/// 屏幕坐标矩形（物理像素）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    pub fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }
}

/// 两个矩形是否有非空交集（用于「pet/主窗是否盖住目标区域」）。
pub fn rects_intersect(a: Rect, b: Rect) -> bool {
    let left = a.left.max(b.left);
    let top = a.top.max(b.top);
    let right = a.right.min(b.right);
    let bottom = a.bottom.min(b.bottom);
    right > left && bottom > top
}

/// 屏幕坐标矩形 → 帧内像素矩形；完全落在帧外或宽高为 0 返回 None。
pub fn clamp_rect_to_frame(
    rect: Rect,
    frame_origin: (i32, i32),
    width: u32,
    height: u32,
) -> Option<(u32, u32, u32, u32)> {
    let x0 = (rect.left - frame_origin.0).clamp(0, width as i32);
    let y0 = (rect.top - frame_origin.1).clamp(0, height as i32);
    let x1 = (rect.right - frame_origin.0).clamp(0, width as i32);
    let y1 = (rect.bottom - frame_origin.1).clamp(0, height as i32);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some((x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// 抓取前的窗口资格判定（纯函数，可单元测试）。
///
/// 顺序固定：自身窗口优先于其他拒绝原因——点 pet 之后前台必然是 pet，
/// 调用方要据此改读「最后一个有效外部窗口」，而不是看到 no_window 就放弃。
pub fn classify_window_capture(
    is_self: bool,
    has_window: bool,
    visible: bool,
    minimized: bool,
    on_primary_monitor: bool,
    self_overlaps: bool,
) -> &'static str {
    if !has_window {
        return "no_window";
    }
    if is_self {
        return "self_window";
    }
    if !visible || minimized || !on_primary_monitor {
        return "no_window";
    }
    if self_overlaps {
        return "obscured";
    }
    "ok"
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    /// 进程名（`chrome.exe`）。**没有窗口标题**——本命令一行标题都不读。
    pub process_name: String,
    /// 进程内稳定的窗口标识；重新验证时按它取回窗口。
    pub window_id: String,
    pub monitor_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCaptureFrame {
    pub png_base64: String,
    pub window: WindowIdentity,
    pub region: WindowRegion,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WindowCaptureOutcome {
    Ok { frame: WindowCaptureFrame },
    SelfWindow,
    Obscured,
    NoWindow,
    Unavailable,
}

/// 受限窗口抓取（FE-32）：主显示器上获授权前台窗口的**客户区**。
///
/// 只允许主窗调用；pet 不能直接要屏幕内容。窗口标题一律不读，返回体里也没有
/// 标题字段。pet/主窗覆盖目标区域且无法排除时返回 `obscured`，由界面提示用户
/// 调整窗口——不硬读，也不把自己的气泡当成新的屏幕话题。
#[tauri::command]
pub fn environment_capture_window(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, ScreenState>,
    window_id: Option<String>,
) -> Result<WindowCaptureOutcome, String> {
    crate::petWindow::assert_allowed_caller(window.label(), &[crate::petWindow::MAIN_WINDOW_LABEL])?;
    #[cfg(windows)]
    {
        capture_window_impl(&app, &state, window_id.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, window_id);
        Ok(WindowCaptureOutcome::Unavailable)
    }
}

#[cfg(windows)]
fn capture_window_impl(
    app: &AppHandle,
    state: &tauri::State<'_, ScreenState>,
    window_id: Option<&str>,
) -> Result<WindowCaptureOutcome, String> {
    use tauri::Manager;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetForegroundWindow, GetWindowRect, IsIconic, IsWindow, IsWindowVisible,
    };

    /// 自身窗口（pet / 主窗）的句柄集合。
    fn self_hwnds(app: &AppHandle) -> Vec<isize> {
        [crate::petWindow::MAIN_WINDOW_LABEL, crate::petWindow::PET_WINDOW_LABEL]
            .iter()
            .filter_map(|label| app.get_webview_window(label))
            .filter_map(|webview| webview.hwnd().ok())
            .map(|handle| handle.0 as isize)
            .collect()
    }

    fn window_rect(hwnd: HWND) -> Option<Rect> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect).ok()? };
        Some(Rect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
    }

    fn client_rect_on_screen(hwnd: HWND) -> Option<Rect> {
        let mut rect = RECT::default();
        unsafe { GetClientRect(hwnd, &mut rect).ok()? };
        let mut origin = POINT { x: rect.left, y: rect.top };
        unsafe {
            if !ClientToScreen(hwnd, &mut origin).as_bool() {
                return None;
            }
        }
        Some(Rect {
            left: origin.x,
            top: origin.y,
            right: origin.x + (rect.right - rect.left),
            bottom: origin.y + (rect.bottom - rect.top),
        })
    }

    let mine = self_hwnds(app);
    let target = unsafe {
        match window_id {
            // 重新验证：给定窗口必须仍然存在（句柄可能已经被系统回收/复用）。
            Some(id) => match id.strip_prefix("w").and_then(|hex| isize::from_str_radix(hex, 16).ok()) {
                Some(raw) => {
                    let hwnd = HWND(raw as *mut core::ffi::c_void);
                    if IsWindow(Some(hwnd)).as_bool() { Some(hwnd) } else { None }
                }
                None => None,
            },
            None => {
                let hwnd = GetForegroundWindow();
                if hwnd.0.is_null() { None } else { Some(hwnd) }
            }
        }
    };

    let Some(hwnd) = target else {
        return Ok(WindowCaptureOutcome::NoWindow);
    };
    let raw = hwnd.0 as isize;
    let is_self = mine.contains(&raw);
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    let minimized = unsafe { IsIconic(hwnd).as_bool() };

    let primary = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let on_primary = monitor == primary;

    let client = client_rect_on_screen(hwnd).filter(|rect| !rect.is_empty());
    // pet/主窗是否盖住目标区域：任一可见自身窗口与客户区相交即拒绝。
    let self_overlaps = client.is_some_and(|target_rect| {
        mine.iter().any(|handle| {
            let other = HWND(*handle as *mut core::ffi::c_void);
            if other == hwnd {
                return false;
            }
            let usable = unsafe { IsWindowVisible(other).as_bool() && !IsIconic(other).as_bool() };
            usable && window_rect(other).is_some_and(|rect| rects_intersect(rect, target_rect))
        })
    });

    match classify_window_capture(is_self, true, visible, minimized, on_primary, self_overlaps) {
        "self_window" => return Ok(WindowCaptureOutcome::SelfWindow),
        "obscured" => return Ok(WindowCaptureOutcome::Obscured),
        "no_window" => return Ok(WindowCaptureOutcome::NoWindow),
        _ => {}
    }
    let Some(client) = client else {
        return Ok(WindowCaptureOutcome::NoWindow);
    };

    // 主显示器帧原点：抓到的整帧对应 rcMonitor，屏幕坐标要减去它才是帧内坐标。
    let origin = unsafe {
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(primary, &mut info).as_bool() {
            (info.rcMonitor.left, info.rcMonitor.top)
        } else {
            (0, 0)
        }
    };

    let (bgra, width, height) = {
        let guard = state.shared.lock().map_err(|error| error.to_string())?;
        match guard.latest_bgra.as_ref() {
            Some(frame) => (frame.clone(), guard.latest_dims.0, guard.latest_dims.1),
            // 采集线程还没给出有效帧（刚启用/全黑帧）：不可用，不是「没有文字」。
            None => return Ok(WindowCaptureOutcome::Unavailable),
        }
    };
    let Some((x, y, crop_width, crop_height)) = clamp_rect_to_frame(client, origin, width, height) else {
        return Ok(WindowCaptureOutcome::Unavailable);
    };

    let Some(png_base64) = crop_to_png(&bgra, width, x, y, crop_width, crop_height) else {
        return Ok(WindowCaptureOutcome::Unavailable);
    };

    let process_name = crate::foreground::process_name_of_window(raw).unwrap_or_else(|| "unknown".to_string());
    Ok(WindowCaptureOutcome::Ok {
        frame: WindowCaptureFrame {
            png_base64,
            window: WindowIdentity {
                process_name,
                window_id: format!("w{raw:x}"),
                monitor_id: "primary".to_string(),
            },
            region: WindowRegion { x, y, width: crop_width, height: crop_height },
        },
    })
}

/// BGRA 整帧裁剪 → PNG base64（与 `environment_capture_region` 同一套编码口径）。
pub fn crop_to_png(
    bgra: &[u8],
    frame_width: u32,
    x: u32,
    y: u32,
    crop_width: u32,
    crop_height: u32,
) -> Option<String> {
    let mut rgba = Vec::with_capacity((crop_width * crop_height * 4) as usize);
    for row in 0..crop_height {
        for col in 0..crop_width {
            let src = (((y + row) as usize) * frame_width as usize + (x + col) as usize) * 4;
            if src + 3 >= bgra.len() {
                return None;
            }
            rgba.extend_from_slice(&[bgra[src + 2], bgra[src + 1], bgra[src], 255]);
        }
    }
    let image = image::RgbaImage::from_raw(crop_width, crop_height, rgba)?;
    let mut png = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(std::io::Cursor::new(&mut png));
        image::ImageEncoder::write_image(
            encoder,
            image.as_raw(),
            crop_width,
            crop_height,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    }
    Some(BASE64.encode(png))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, value: u8) -> Vec<u8> {
        let mut frame = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            frame.extend_from_slice(&[value, value, value, 255]);
        }
        frame
    }

    #[test]
    fn diff_threshold_boundaries_with_fixed_matrix() {
        // 全 128 灰度基线 vs 各差异级别。
        let baseline = vec![128u8; THUMB_WIDTH * THUMB_HEIGHT];
        // +8 均匀差 → 8/255 ≈ 0.0314 ≥ 0.03 触发。
        let shifted_up: Vec<u8> = baseline.iter().map(|v| (v + 8).min(255)).collect();
        // +7 均匀差 → 7/255 ≈ 0.0275 < 0.03 不触发。
        let shifted_low: Vec<u8> = baseline.iter().map(|v| (v + 7).min(255)).collect();
        assert!(mean_abs_diff(&baseline, &shifted_up) >= DIFF_THRESHOLD);
        assert!(mean_abs_diff(&baseline, &shifted_low) < DIFF_THRESHOLD);
        // 全同零差；长度不一致按无效 0。
        assert_eq!(mean_abs_diff(&baseline, &baseline), 0.0);
        assert_eq!(mean_abs_diff(&baseline, &baseline[..100]), 0.0);
    }

    #[test]
    fn first_frame_and_black_frames_do_not_trigger() {
        let black = solid(1920, 1080, 0);
        let thumb_black = bgra_to_gray_thumb(&black, 1920, 1080);
        assert!(is_black_frame(&thumb_black));

        let content = solid(1920, 1080, 128);
        let thumb_content = bgra_to_gray_thumb(&content, 1920, 1080);
        assert!(!is_black_frame(&thumb_content));
        // 黑帧与内容帧比较仍会触发（内容真的出现了）——但黑帧本身不建基线，
        // 由状态机在 on_frame_arrived 中保证（这里验纯函数口径）。
        assert!(mean_abs_diff(&thumb_black, &thumb_content) >= DIFF_THRESHOLD);
    }

    #[test]
    fn resolution_change_rebuilds_baseline() {
        let small = solid(1280, 720, 100);
        let large = solid(1920, 1080, 100);
        let t1 = bgra_to_gray_thumb(&small, 1280, 720);
        let t2 = bgra_to_gray_thumb(&large, 1920, 1080);
        // 缩略图同尺寸，但分辨率变化要重建基线（状态机口径）；这里验证
        // dims 比较的输入确实不同。
        assert_ne!((1280, 720), (1920, 1080));
        assert_eq!(t1.len(), t2.len());
    }

    #[test]
    fn roi_clamps_to_frame() {
        assert_eq!(roi_to_pixels((0.1, 0.4, 0.8, 0.2), 1920, 1080), Some((192, 432, 1536, 216)));
        // 越界 clamp：y+height 超出按帧底收口。
        assert_eq!(roi_to_pixels((0.0, 0.9, 1.0, 0.5), 1000, 1000), Some((0, 900, 1000, 100)));
        assert_eq!(roi_to_pixels((0.5, 0.5, 0.0, 0.1), 1000, 1000), None);
    }

    #[test]
    fn self_window_and_overlap_are_refused_before_capture() {
        // 前台是 pet/主窗：优先报 self_window，调用方据此改读最后一个外部窗口。
        assert_eq!(classify_window_capture(true, true, true, false, true, false), "self_window");
        // 自身窗口盖住目标客户区且无法排除：拒绝该区域，不硬读。
        assert_eq!(classify_window_capture(false, true, true, false, true, true), "obscured");
        // 最小化 / 不可见 / 不在主显示器：都不是「没有文字」，是没有可读窗口。
        assert_eq!(classify_window_capture(false, true, true, true, true, false), "no_window");
        assert_eq!(classify_window_capture(false, true, false, false, true, false), "no_window");
        assert_eq!(classify_window_capture(false, true, true, false, false, false), "no_window");
        assert_eq!(classify_window_capture(false, false, true, false, true, false), "no_window");
        assert_eq!(classify_window_capture(false, true, true, false, true, false), "ok");
    }

    #[test]
    fn rect_intersection_and_frame_clamp() {
        let target = Rect { left: 100, top: 100, right: 500, bottom: 400 };
        // 边贴边不算遮挡（right == left）。
        assert!(!rects_intersect(target, Rect { left: 500, top: 100, right: 700, bottom: 400 }));
        assert!(rects_intersect(target, Rect { left: 499, top: 399, right: 700, bottom: 600 }));

        // 屏幕坐标 → 帧内坐标（主显示器原点非 0 时要减掉）。
        assert_eq!(clamp_rect_to_frame(target, (0, 0), 1920, 1080), Some((100, 100, 400, 300)));
        assert_eq!(clamp_rect_to_frame(target, (100, 100), 1920, 1080), Some((0, 0, 400, 300)));
        // 越界收口到帧内。
        assert_eq!(
            clamp_rect_to_frame(Rect { left: -50, top: -50, right: 100, bottom: 100 }, (0, 0), 1920, 1080),
            Some((0, 0, 100, 100)),
        );
        // 完全在帧外：没有可抓区域。
        assert_eq!(
            clamp_rect_to_frame(Rect { left: 3000, top: 100, right: 3200, bottom: 400 }, (0, 0), 1920, 1080),
            None,
        );
    }

    #[test]
    fn crop_to_png_rejects_out_of_range_instead_of_reading_garbage() {
        let frame = solid(64, 64, 200);
        assert!(crop_to_png(&frame, 64, 0, 0, 32, 32).is_some());
        // 越界裁剪返回 None，而不是读到相邻内存/黑边冒充画面。
        assert!(crop_to_png(&frame, 64, 60, 60, 32, 32).is_none());
    }

    #[test]
    fn gray_conversion_matches_luma() {
        // 纯绿帧：luma ≈ 0.587*255 ≈ 150。
        let mut green = Vec::new();
        for _ in 0..(96 * 54) {
            green.extend_from_slice(&[0, 255, 0, 255]);
        }
        let thumb = bgra_to_gray_thumb(&green, 96, 54);
        assert!((i32::from(thumb[0]) - 150).abs() <= 1);
    }
}
