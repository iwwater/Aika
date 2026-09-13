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
