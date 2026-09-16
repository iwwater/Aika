mod http_api;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::IpAddr,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};

const DEFAULT_PORT: u16 = 17321;
const DEFAULT_LISTEN_ADDRESS: &str = "127.0.0.1";
const DEFAULT_BUBBLE_TTL_MS: u64 = 4000;
const EVENT_PET_ACTION: &str = "pet-action";
const EVENT_PET_SAY: &str = "pet-say";
const EVENT_PET_SETTINGS: &str = "pet-settings";
const EVENT_RUNTIME_STATUS: &str = "runtime-status";
const RUNTIME_CONFIG_FILE: &str = "data/runtime-config.toml";
const LEGACY_RUNTIME_CONFIG_FILE: &str = "runtime-config.json";
const SETTINGS_CONFIG_FILE: &str = "data/settings.toml";
const RECENT_EVENT_LIMIT: usize = 12;
const DEFAULT_PET_ID: &str = "nia";
const MAX_SPRITESHEET_BYTES: usize = 12 * 1024 * 1024;
const PRODUCT_NAME: &str = "PetShell";
const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");
const UPSTREAM_PROJECT: &str = "OpenPet v0.1.6 (GPL-3.0-or-later)";
const TRAY_ID: &str = "petshell";
const SHUTDOWN_ENDPOINT: &str = "/api/shutdown";
const SHUTDOWN_CONTRACT_VERSION: u32 = 1;
const SHUTDOWN_AUTH_SCHEME: &str = "bearer-token";
/// Environment variable carrying the owner's exit token. Set by whoever spawned this
/// process; an attach client that only reaches the loopback port never sees it.
const EXIT_TOKEN_ENV: &str = "PET_SHELL_EXIT_TOKEN";
/// Short tokens are rejected as misconfiguration rather than silently accepted.
const MIN_EXIT_TOKEN_LEN: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PetActionAnimationId {
    Waving,
    Jumping,
    Failed,
    Waiting,
    Running,
    Review,
}

impl PetActionAnimationId {
    fn as_str(self) -> &'static str {
        match self {
            Self::Waving => "waving",
            Self::Jumping => "jumping",
            Self::Failed => "failed",
            Self::Waiting => "waiting",
            Self::Running => "running",
            Self::Review => "review",
        }
    }
}

impl Default for PetActionAnimationId {
    fn default() -> Self {
        Self::Waving
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PetLanguage {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
}

impl Default for PetLanguage {
    fn default() -> Self {
        Self::En
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClickActionMode {
    Fixed,
    Random,
}

impl Default for ClickActionMode {
    fn default() -> Self {
        Self::Random
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IdleActionId {
    Random,
    ActiveAction,
    Waving,
    Jumping,
    Failed,
    Waiting,
    Running,
    Review,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BubbleStyle {
    Soft,
    Comic,
    Glass,
    Terminal,
}

impl Default for BubbleStyle {
    fn default() -> Self {
        Self::Soft
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PetStoragePreset {
    AppData,
    CodexCustom,
    Custom,
}

impl Default for PetStoragePreset {
    fn default() -> Self {
        Self::CodexCustom
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompanionEventType {
    Thinking,
    ToolRunning,
    Reviewing,
    Success,
    Failure,
    Attention,
}

impl CompanionEventType {
    fn animation_id(self) -> PetActionAnimationId {
        match self {
            Self::Thinking => PetActionAnimationId::Waiting,
            Self::ToolRunning => PetActionAnimationId::Running,
            Self::Reviewing => PetActionAnimationId::Review,
            Self::Success => PetActionAnimationId::Jumping,
            Self::Failure => PetActionAnimationId::Failed,
            Self::Attention => PetActionAnimationId::Waving,
        }
    }

    fn default_bubble(self) -> &'static str {
        match self {
            Self::Thinking => "Thinking...",
            Self::ToolRunning => "Running a tool...",
            Self::Reviewing => "Reviewing changes...",
            Self::Success => "Done!",
            Self::Failure => "Something needs attention.",
            Self::Attention => "Need your attention.",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_path: String,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub imported: bool,
    /// 磁盘上的实际贴图路径，**仅进程内使用**。
    ///
    /// 导入宠物的目录名不保证等于 `id`（Codex 约定：目录名任意、身份写在
    /// `pet.json` 里），所以路径必须在扫描时随目录一起记下来；查询时若改用
    /// `id` 去拼目录，快照就会广告一个取不到的 URL（MVP-13 DEF-3）。
    /// 不参与 JSON：既不写出，也不从 `pet.json` 读入。
    #[serde(skip)]
    pub(crate) local_spritesheet: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCatalogItem {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_path: String,
    pub spritesheet_url: String,
    pub source_name: Option<String>,
    pub source_url: Option<String>,
    pub imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct RuntimeApiConfig {
    pub listen_address: String,
    pub port: u16,
}

impl Default for RuntimeApiConfig {
    fn default() -> Self {
        Self {
            listen_address: DEFAULT_LISTEN_ADDRESS.to_string(),
            port: DEFAULT_PORT,
        }
    }
}

fn bundled_pet_manifests() -> Vec<PetManifest> {
    vec![PetManifest {
        id: DEFAULT_PET_ID.to_string(),
        display_name: "Nia".to_string(),
        description:
            "A larger elf-eared blonde Nia pet with independently generated action animations."
                .to_string(),
        spritesheet_path: "spritesheet.webp".to_string(),
        source_name: None,
        source_url: None,
        imported: false,
        // 内置宠物走内嵌资源，不经文件系统，所以没有本地贴图路径。
        local_spritesheet: None,
    }]
}

fn url_host_for_listen_address(listen_address: &str) -> String {
    match listen_address {
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" => "[::1]".to_string(),
        value if value.contains(':') && !value.starts_with('[') => format!("[{value}]"),
        value => value.to_string(),
    }
}

fn api_base_url(config: &RuntimeApiConfig) -> String {
    format!(
        "http://{}:{}",
        url_host_for_listen_address(&config.listen_address),
        config.port
    )
}

fn catalog_item(pet: &PetManifest, config: &RuntimeApiConfig) -> PetCatalogItem {
    let spritesheet_url = if pet.imported {
        format!("{}/api/pets/{}/spritesheet", api_base_url(config), pet.id)
    } else {
        format!("/pets/{}/{}", pet.id, pet.spritesheet_path)
    };

    PetCatalogItem {
        id: pet.id.clone(),
        display_name: pet.display_name.clone(),
        description: pet.description.clone(),
        spritesheet_path: pet.spritesheet_path.clone(),
        spritesheet_url,
        source_name: pet.source_name.clone(),
        source_url: pet.source_url.clone(),
        imported: pet.imported,
    }
}

fn path_to_display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "failed to resolve user home directory".to_string())
}

fn codex_pet_storage_dir() -> Result<PathBuf, String> {
    Ok(user_home_dir()?.join(".codex").join("pets"))
}

fn app_data_pet_storage_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pets")
}

/// Live2D 模型在应用数据目录下的位置（`<app data>/live2d/models`）。
///
/// 模型**不入包**（MVP-14 处置 DEF-1）：它们由使用者按
/// `scripts/fetch-live2d-assets.mjs` 放在这里，经回环 HTTP 提供给 WebView。
fn live2d_models_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("live2d").join("models")
}

/// 把 URL 里的相对路径解析成模型目录下的真实文件路径。
///
/// 这是模型资源的**唯一信任边界**：目录内容由使用者放置、路径来自 HTTP 请求，
/// 所以只接受由 `[A-Za-z0-9._-]` 组成的段，拒绝空段、`.` 与 `..`，并要求至少
/// 「外观目录 + 文件名」两段。任何不满足的输入一律返回 `None`——不做纠正、不做
/// 规范化后再判断，避免 `..` 在规范化过程里被消掉而绕过检查。
fn resolve_live2d_asset(models_dir: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.len() > 512 {
        return None;
    }
    let mut path = models_dir.to_path_buf();
    let mut segments = 0_usize;
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        if !segment
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
        {
            return None;
        }
        path.push(segment);
        segments += 1;
    }
    (segments >= 2).then_some(path)
}

fn resolve_pet_storage_dir(app_data_dir: &Path, settings: &PetSettings) -> Result<PathBuf, String> {
    match settings.pet_storage_preset {
        PetStoragePreset::AppData => Ok(app_data_pet_storage_dir(app_data_dir)),
        PetStoragePreset::CodexCustom => codex_pet_storage_dir(),
        PetStoragePreset::Custom => settings
            .custom_pet_storage_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "custom pet storage directory is required".to_string()),
    }
}

fn normalize_pet_settings(mut settings: PetSettings) -> PetSettings {
    settings.scale = settings.scale.clamp(0.5, 2.0);
    settings.event_bubble_ttl_ms = settings.event_bubble_ttl_ms.clamp(500, 60_000);
    settings.bubble_font_size_px = settings.bubble_font_size_px.clamp(10, 28);
    settings.bubble_max_width_px = settings.bubble_max_width_px.clamp(180, 520);
    settings.walking_speed_px = settings.walking_speed_px.clamp(1.0, 32.0);
    settings.idle_threshold_ms = settings.idle_threshold_ms.max(5_000);
    settings.idle_action_frequency_ms = settings.idle_action_frequency_ms.max(5_000);
    settings.bubble_font_family = settings
        .bubble_font_family
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    if settings.bubble_font_family.is_empty() {
        settings.bubble_font_family = PetSettings::default().bubble_font_family;
    }
    // 只保证它是安全字符串；「这个外观是否存在」由 renderer 依据自己的目录判定，
    // 免得同一份清单在两端各写一遍、迟早漂移。
    settings.live2d_appearance = sanitize_pet_id(&settings.live2d_appearance);
    settings.custom_pet_storage_dir = settings.custom_pet_storage_dir.and_then(|value| {
        let trimmed = value.trim().chars().take(512).collect::<String>();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    settings
}

/// 表现出口。任一时刻只有一个 renderer 在输出（MVP-10 的槽位约束）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetRendererId {
    Sprite,
    Live2d,
}

impl Default for PetRendererId {
    fn default() -> Self {
        Self::Sprite
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct PetSettings {
    pub language: PetLanguage,
    pub scale: f64,
    pub reduced_motion: bool,
    pub autonomous_walking: bool,
    /// 首版换装是整模型切换，所以这一项就是「当前外观」。合法性由 renderer 判定。
    pub live2d_appearance: String,
    pub renderer: PetRendererId,
    pub hover_pause: bool,
    pub active_pet_id: String,
    pub click_action_mode: ClickActionMode,
    pub click_action: PetActionAnimationId,
    pub click_action_pool: Vec<PetActionAnimationId>,
    pub event_reactions: bool,
    pub event_bubbles: bool,
    pub event_bubble_ttl_ms: u64,
    pub bubble_style: BubbleStyle,
    pub bubble_font_family: String,
    pub bubble_font_size_px: u16,
    pub bubble_max_width_px: u16,
    pub idle_self_play: bool,
    pub idle_threshold_ms: u64,
    pub idle_action_frequency_ms: u64,
    pub idle_action: IdleActionId,
    pub walking_speed_px: f64,
    pub pet_storage_preset: PetStoragePreset,
    pub custom_pet_storage_dir: Option<String>,
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            language: PetLanguage::default(),
            scale: 1.0,
            reduced_motion: false,
            autonomous_walking: false,
            live2d_appearance: "hiyori".to_string(),
            renderer: PetRendererId::default(),
            hover_pause: true,
            active_pet_id: DEFAULT_PET_ID.to_string(),
            click_action_mode: ClickActionMode::Random,
            click_action: PetActionAnimationId::Waving,
            click_action_pool: vec![
                PetActionAnimationId::Waving,
                PetActionAnimationId::Jumping,
                PetActionAnimationId::Waiting,
                PetActionAnimationId::Running,
                PetActionAnimationId::Review,
            ],
            event_reactions: true,
            event_bubbles: true,
            event_bubble_ttl_ms: 4000,
            bubble_style: BubbleStyle::Soft,
            bubble_font_family: "Aptos Display".to_string(),
            bubble_font_size_px: 14,
            bubble_max_width_px: 292,
            idle_self_play: true,
            idle_threshold_ms: 45_000,
            idle_action_frequency_ms: 30_000,
            idle_action: IdleActionId::Random,
            walking_speed_px: 8.0,
            pet_storage_preset: PetStoragePreset::CodexCustom,
            custom_pet_storage_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPayload {
    pub animation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SayPayload {
    pub text: String,
    pub ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionEventPayload {
    #[serde(rename = "type")]
    pub event_type: CompanionEventType,
    pub message: Option<String>,
    pub ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImportPayload {
    pub source: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCompanionEvent {
    pub event_type: CompanionEventType,
    pub message: Option<String>,
    pub animation_id: PetActionAnimationId,
    pub bubble_text: Option<String>,
    pub received_at_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetStorageSnapshot {
    pub preset: PetStoragePreset,
    pub custom_dir: Option<String>,
    pub active_dir: String,
    pub app_data_dir: String,
    pub codex_dir: String,
}

/// Real identity of this program. Never claims to be the upstream project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInfo {
    pub name: String,
    pub version: String,
    /// Attribution only. Aiki must not use this for version matching.
    pub upstream: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownCapability {
    pub endpoint: String,
    pub version: u32,
    pub auth: String,
    /// False when no exit token was provided at launch, so the endpoint refuses everyone.
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCapabilities {
    pub single_instance: bool,
    /// True for the process that owns the instance lock.
    pub instance_owner: bool,
    pub shutdown: ShutdownCapability,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub listen_address: String,
    pub port: u16,
    pub configured_listen_address: String,
    pub configured_port: u16,
    pub api_base_url: String,
    pub api_listening: bool,
    pub api_error: Option<String>,
    pub api_restart_required: bool,
    pub pet_visible: bool,
    pub product: ProductInfo,
    pub capabilities: IdentityCapabilities,
    pub settings: PetSettings,
    pub pet_storage: PetStorageSnapshot,
    pub active_pet: PetCatalogItem,
    pub pet_catalog: Vec<PetCatalogItem>,
    pub last_action: Option<String>,
    pub bubble_text: Option<String>,
    pub recent_events: Vec<RecentCompanionEvent>,
    pub started_at_ms: u128,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetStorageFolderKind {
    Active,
    AppData,
    CodexCustom,
}

#[derive(Debug)]
struct RuntimeState {
    active_api_config: RuntimeApiConfig,
    configured_api_config: RuntimeApiConfig,
    runtime_config_path: Option<PathBuf>,
    settings_config_path: Option<PathBuf>,
    app_data_dir: Option<PathBuf>,
    api_listening: bool,
    api_error: Option<String>,
    pet_visible: bool,
    settings: PetSettings,
    pet_catalog: Vec<PetManifest>,
    imported_pets_dir: Option<PathBuf>,
    last_action: Option<String>,
    bubble_text: Option<String>,
    bubble_expires_at_ms: Option<u128>,
    recent_events: Vec<RecentCompanionEvent>,
    started_at_ms: u128,
    instance_owner: bool,
    exit_token: Option<String>,
    exit_token_reason: Option<String>,
    shutdown_requested: bool,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<RuntimeState>>,
}

fn pet_storage_snapshot_from_state(state: &RuntimeState) -> PetStorageSnapshot {
    let fallback_app_data = PathBuf::from(".");
    let app_data_dir = state.app_data_dir.as_ref().unwrap_or(&fallback_app_data);
    let app_data_pets = app_data_pet_storage_dir(app_data_dir);
    let codex_dir = codex_pet_storage_dir().unwrap_or_else(|_| app_data_pets.clone());
    let active_dir = state
        .imported_pets_dir
        .clone()
        .unwrap_or_else(|| codex_dir.clone());

    PetStorageSnapshot {
        preset: state.settings.pet_storage_preset,
        custom_dir: state.settings.custom_pet_storage_dir.clone(),
        active_dir: path_to_display(&active_dir),
        app_data_dir: path_to_display(&app_data_pets),
        codex_dir: path_to_display(&codex_dir),
    }
}

/// Outcome of a protocol-exit request. Each variant maps to one HTTP status so the
/// caller can tell "not allowed" from "wrong credential" from "already going down".
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ShutdownDecision {
    Accepted,
    AlreadyInProgress,
    TokenRequired,
    TokenInvalid,
    NotAvailable(String),
}

fn shutdown_capability_from_state(state: &RuntimeState) -> ShutdownCapability {
    let available = state.exit_token.is_some();
    ShutdownCapability {
        endpoint: SHUTDOWN_ENDPOINT.to_string(),
        version: SHUTDOWN_CONTRACT_VERSION,
        auth: SHUTDOWN_AUTH_SCHEME.to_string(),
        available,
        reason: if available {
            None
        } else {
            state
                .exit_token_reason
                .clone()
                .or_else(|| Some("protocol exit is not enabled".to_string()))
        },
    }
}

/// Length-independent comparison so the token cannot be guessed byte by byte.
fn constant_time_eq(expected: &[u8], presented: &[u8]) -> bool {
    if expected.len() != presented.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (left, right) in expected.iter().zip(presented.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn exit_token_from_env() -> Option<String> {
    std::env::var(EXIT_TOKEN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl AppState {
    fn new(api_config: RuntimeApiConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeState {
                active_api_config: api_config.clone(),
                configured_api_config: api_config,
                runtime_config_path: None,
                settings_config_path: None,
                app_data_dir: None,
                api_listening: false,
                api_error: None,
                pet_visible: true,
                settings: PetSettings::default(),
                pet_catalog: bundled_pet_manifests(),
                imported_pets_dir: None,
                last_action: None,
                bubble_text: None,
                bubble_expires_at_ms: None,
                recent_events: Vec::new(),
                started_at_ms: now_ms(),
                instance_owner: true,
                exit_token: None,
                exit_token_reason: Some("exit token not configured".to_string()),
                shutdown_requested: false,
            })),
        }
    }

    /// Records who this process is. `exit_token` being absent is not an error: it means
    /// the protocol exit path stays closed to every caller.
    pub fn configure_identity(&self, instance_owner: bool, exit_token: Option<String>) {
        let reason = match exit_token.as_deref() {
            None => Some(format!("{EXIT_TOKEN_ENV} was not provided at launch")),
            Some(token) if token.len() < MIN_EXIT_TOKEN_LEN => Some(format!(
                "{EXIT_TOKEN_ENV} is shorter than {MIN_EXIT_TOKEN_LEN} characters"
            )),
            Some(_) => None,
        };
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.instance_owner = instance_owner;
        state.exit_token = if reason.is_some() { None } else { exit_token };
        state.exit_token_reason = reason;
    }

    pub fn shutdown_capability(&self) -> ShutdownCapability {
        let state = self.inner.lock().expect("runtime state poisoned");
        shutdown_capability_from_state(&state)
    }

    /// Authorises a protocol exit. The token is compared in constant time and is never
    /// echoed back, logged or included in an error message.
    pub(crate) fn begin_shutdown(&self, presented_token: Option<&str>) -> ShutdownDecision {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        let Some(expected) = state.exit_token.clone() else {
            return ShutdownDecision::NotAvailable(
                state
                    .exit_token_reason
                    .clone()
                    .unwrap_or_else(|| "protocol exit is not enabled on this instance".to_string()),
            );
        };
        let Some(presented) = presented_token else {
            return ShutdownDecision::TokenRequired;
        };
        if !constant_time_eq(expected.as_bytes(), presented.as_bytes()) {
            return ShutdownDecision::TokenInvalid;
        }
        if state.shutdown_requested {
            return ShutdownDecision::AlreadyInProgress;
        }
        state.shutdown_requested = true;
        ShutdownDecision::Accepted
    }

    pub fn port(&self) -> u16 {
        self.inner
            .lock()
            .expect("runtime state poisoned")
            .active_api_config
            .port
    }

    pub fn api_bind_config(&self) -> RuntimeApiConfig {
        self.inner
            .lock()
            .expect("runtime state poisoned")
            .active_api_config
            .clone()
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        if state
            .bubble_expires_at_ms
            .is_some_and(|expires_at_ms| now_ms() >= expires_at_ms)
        {
            state.bubble_text = None;
            state.bubble_expires_at_ms = None;
        }
        let active_api_config = state.active_api_config.clone();
        let pet_catalog = state
            .pet_catalog
            .iter()
            .map(|pet| catalog_item(pet, &active_api_config))
            .collect::<Vec<_>>();
        let active_pet = pet_catalog
            .iter()
            .find(|pet| pet.id == state.settings.active_pet_id)
            .cloned()
            .or_else(|| pet_catalog.first().cloned())
            .unwrap_or_else(|| catalog_item(&bundled_pet_manifests()[0], &active_api_config));
        let pet_storage = pet_storage_snapshot_from_state(&state);

        RuntimeSnapshot {
            listen_address: active_api_config.listen_address.clone(),
            port: active_api_config.port,
            configured_listen_address: state.configured_api_config.listen_address.clone(),
            configured_port: state.configured_api_config.port,
            api_base_url: api_base_url(&active_api_config),
            api_listening: state.api_listening,
            api_error: state.api_error.clone(),
            api_restart_required: state.configured_api_config != active_api_config,
            pet_visible: state.pet_visible,
            product: ProductInfo {
                name: PRODUCT_NAME.to_string(),
                version: PRODUCT_VERSION.to_string(),
                upstream: UPSTREAM_PROJECT.to_string(),
            },
            capabilities: IdentityCapabilities {
                single_instance: true,
                instance_owner: state.instance_owner,
                shutdown: shutdown_capability_from_state(&state),
            },
            settings: state.settings.clone(),
            pet_storage,
            active_pet,
            pet_catalog,
            last_action: state.last_action.clone(),
            bubble_text: state.bubble_text.clone(),
            recent_events: state.recent_events.clone(),
            started_at_ms: state.started_at_ms,
        }
    }

    pub fn mark_api_listening(&self, listen_address: String, port: u16) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.active_api_config = RuntimeApiConfig {
            listen_address,
            port,
        };
        state.api_listening = true;
        state.api_error = None;
    }

    pub fn mark_api_error(&self, error: String) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.api_listening = false;
        state.api_error = Some(error);
    }

    pub fn set_pet_visible(&self, visible: bool) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.pet_visible = visible;
    }

    pub fn pet_visible(&self) -> bool {
        self.inner
            .lock()
            .expect("runtime state poisoned")
            .pet_visible
    }

    fn configure_app_paths(
        &self,
        app_data_dir: PathBuf,
        settings_config_path: Option<PathBuf>,
    ) -> Result<(), String> {
        let next_imported_dir = {
            let state = self.inner.lock().expect("runtime state poisoned");
            resolve_pet_storage_dir(&app_data_dir, &state.settings)?
        };
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.app_data_dir = Some(app_data_dir);
        state.settings_config_path = settings_config_path;
        state.imported_pets_dir = Some(next_imported_dir);
        Ok(())
    }

    fn configure_settings(&self, settings: PetSettings) -> Result<(), String> {
        let next_settings = normalize_pet_settings(settings);
        let next_imported_dir = {
            let state = self.inner.lock().expect("runtime state poisoned");
            state
                .app_data_dir
                .as_deref()
                .map(|app_data_dir| resolve_pet_storage_dir(app_data_dir, &next_settings))
                .transpose()?
        };
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.settings = next_settings;
        if let Some(imported_dir) = next_imported_dir {
            state.imported_pets_dir = Some(imported_dir);
        }
        Ok(())
    }

    fn configure_runtime_api(
        &self,
        config: RuntimeApiConfig,
        runtime_config_path: Option<PathBuf>,
    ) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.active_api_config = config.clone();
        state.configured_api_config = config;
        state.runtime_config_path = runtime_config_path;
    }

    fn update_runtime_api_config(
        &self,
        config: RuntimeApiConfig,
    ) -> Result<RuntimeApiConfig, String> {
        let normalized = normalize_api_config(config)?;
        let config_path = {
            let mut state = self.inner.lock().expect("runtime state poisoned");
            state.configured_api_config = normalized.clone();
            state.runtime_config_path.clone()
        };

        if let Some(path) = config_path {
            save_runtime_api_config(&path, &normalized)?;
        }

        Ok(normalized)
    }

    pub fn record_action(&self, animation_id: String) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.last_action = Some(animation_id);
    }

    pub fn record_say(&self, text: String, ttl_ms: Option<u64>) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.bubble_text = if text.trim().is_empty() {
            None
        } else {
            Some(text)
        };
        state.bubble_expires_at_ms = state
            .bubble_text
            .as_ref()
            .map(|_| now_ms() + u128::from(ttl_ms.unwrap_or(DEFAULT_BUBBLE_TTL_MS).max(500)));
    }

    pub fn record_companion_event(
        &self,
        event: RecentCompanionEvent,
        record_action: bool,
        visible_bubble_text: Option<String>,
        bubble_ttl_ms: Option<u64>,
    ) {
        let mut state = self.inner.lock().expect("runtime state poisoned");
        if record_action {
            state.last_action = Some(event.animation_id.as_str().to_string());
        }
        if let Some(text) = visible_bubble_text.filter(|text| !text.trim().is_empty()) {
            state.bubble_text = Some(text);
            state.bubble_expires_at_ms = Some(
                now_ms() + u128::from(bubble_ttl_ms.unwrap_or(DEFAULT_BUBBLE_TTL_MS).max(500)),
            );
        }
        state.recent_events.insert(0, event);
        state.recent_events.truncate(RECENT_EVENT_LIMIT);
    }

    pub fn settings(&self) -> PetSettings {
        self.inner
            .lock()
            .expect("runtime state poisoned")
            .settings
            .clone()
    }

    fn update_settings(&self, settings: PetSettings) -> Result<PetSettings, String> {
        let mut next_settings = normalize_pet_settings(settings);
        let (config_path, app_data_dir) = {
            let state = self.inner.lock().expect("runtime state poisoned");
            if !state
                .pet_catalog
                .iter()
                .any(|pet| pet.id == next_settings.active_pet_id)
            {
                next_settings.active_pet_id = state
                    .pet_catalog
                    .first()
                    .map(|pet| pet.id.clone())
                    .unwrap_or_else(|| DEFAULT_PET_ID.to_string());
            }
            (
                state.settings_config_path.clone(),
                state.app_data_dir.clone(),
            )
        };
        let next_imported_dir = app_data_dir
            .as_deref()
            .map(|dir| resolve_pet_storage_dir(dir, &next_settings))
            .transpose()?;

        {
            let mut state = self.inner.lock().expect("runtime state poisoned");
            state.settings = next_settings.clone();
            if let Some(imported_dir) = next_imported_dir {
                state.imported_pets_dir = Some(imported_dir);
            }
        }

        if let Some(path) = config_path {
            save_pet_settings(&path, &next_settings)?;
        }

        Ok(next_settings)
    }

    fn persist_settings(&self) -> Result<(), String> {
        let (settings, path) = {
            let state = self.inner.lock().expect("runtime state poisoned");
            (state.settings.clone(), state.settings_config_path.clone())
        };
        if let Some(path) = path {
            save_pet_settings(&path, &settings)?;
        }
        Ok(())
    }

    fn refresh_imported_pets(&self) -> Result<(), String> {
        let imported_dir = {
            self.inner
                .lock()
                .expect("runtime state poisoned")
                .imported_pets_dir
                .clone()
        };
        let mut catalog = bundled_pet_manifests();

        if let Some(dir) = imported_dir {
            fs::create_dir_all(&dir)
                .map_err(|error| format!("failed to create imported pets dir: {error}"))?;
            let entries = fs::read_dir(&dir)
                .map_err(|error| format!("failed to read imported pets dir: {error}"))?;
            let mut imported = Vec::new();
            for entry in entries.flatten() {
                let pet_dir = entry.path();
                if !pet_dir.is_dir() {
                    continue;
                }
                let manifest_path = pet_dir.join("pet.json");
                let Ok(raw) = fs::read_to_string(&manifest_path) else {
                    continue;
                };
                let Ok(mut manifest) = serde_json::from_str::<PetManifest>(&raw) else {
                    continue;
                };
                if !is_valid_pet_id(&manifest.id)
                    || manifest.spritesheet_path.trim().is_empty()
                    || manifest.display_name.trim().is_empty()
                {
                    continue;
                }
                manifest.imported = true;
                manifest.spritesheet_path = "spritesheet.webp".to_string();
                // 目录名可以不同于清单 id（Codex 约定），所以路径在这里定死，
                // 查询时不再用 id 去拼目录。
                manifest.local_spritesheet = Some(pet_dir.join(&manifest.spritesheet_path));
                if manifest
                    .local_spritesheet
                    .as_ref()
                    .is_some_and(|path| path.is_file())
                {
                    imported.push(manifest);
                }
            }
            imported.sort_by(|left, right| left.display_name.cmp(&right.display_name));
            catalog.extend(imported);
        }

        let mut state = self.inner.lock().expect("runtime state poisoned");
        state.pet_catalog = catalog;
        if !state
            .pet_catalog
            .iter()
            .any(|pet| pet.id == state.settings.active_pet_id)
        {
            state.settings.active_pet_id = DEFAULT_PET_ID.to_string();
        }
        Ok(())
    }

    pub(crate) fn imported_pet_spritesheet_path(&self, id: &str) -> Option<PathBuf> {
        let state = self.inner.lock().expect("runtime state poisoned");
        let pet = state
            .pet_catalog
            .iter()
            .find(|pet| pet.imported && pet.id == id)?;
        // 用扫描时记下的实际路径：目录名与清单 id 可以不同（Codex 约定），
        // 用 id 拼目录会让快照广告的 URL 404。
        let path = pet.local_spritesheet.clone()?;
        path.is_file().then_some(path)
    }

    /// 解析一个 Live2D 模型资源（相对 `<app data>/live2d/models`）。
    ///
    /// 返回 `None` 即 404：路径非法、越界，或文件不存在。锁只在取目录时持有。
    pub(crate) fn live2d_asset_path(&self, relative: &str) -> Option<PathBuf> {
        let models_dir = {
            let state = self.inner.lock().expect("runtime state poisoned");
            live2d_models_dir(state.app_data_dir.as_ref()?)
        };
        let path = resolve_live2d_asset(&models_dir, relative)?;
        path.is_file().then_some(path)
    }

    fn imported_pets_dir(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .expect("runtime state poisoned")
            .imported_pets_dir
            .clone()
    }

    fn has_bundled_pet_id(&self, id: &str) -> bool {
        bundled_pet_manifests().iter().any(|pet| pet.id == id)
    }
}

#[derive(Debug)]
struct ResolvedLocalPetSource {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: PathBuf,
    source_name: Option<String>,
    source_url: Option<String>,
    force: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPetManifest {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    spritesheet_path: Option<String>,
    #[serde(default)]
    source_name: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
}

fn is_valid_pet_id(value: &str) -> bool {
    let len = value.len();
    (2..=72).contains(&len)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn sanitize_pet_id(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            output.push(character);
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
        if output.len() >= 64 {
            break;
        }
    }
    let trimmed = output.trim_matches('-').to_string();
    if trimmed.len() >= 2 {
        trimmed
    } else {
        "imported-pet".to_string()
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn option_trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn validate_webp(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 16 {
        return Err("spritesheet is too small to be a valid WebP file".to_string());
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("spritesheet must be a WebP image".to_string());
    }
    Ok(())
}

fn validate_webp_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("failed to inspect spritesheet: {error}"))?;
    if metadata.len() > MAX_SPRITESHEET_BYTES as u64 {
        return Err(format!(
            "spritesheet is larger than {} MB",
            MAX_SPRITESHEET_BYTES / 1024 / 1024
        ));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read spritesheet.webp: {error}"))?;
    validate_webp(&bytes)?;
    Ok(bytes)
}

fn read_local_manifest(path: &Path) -> Result<LocalPetManifest, String> {
    let raw =
        fs::read_to_string(path).map_err(|error| format!("failed to read pet.json: {error}"))?;
    serde_json::from_str::<LocalPetManifest>(&raw)
        .map_err(|error| format!("invalid pet.json: {error}"))
}

fn safe_package_path(base: &Path, value: &str) -> Result<PathBuf, String> {
    let raw = Path::new(value);
    if raw.is_absolute()
        || raw
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("spritesheetPath must stay inside the package directory".to_string());
    }
    let base = fs::canonicalize(base)
        .map_err(|error| format!("failed to resolve package directory: {error}"))?;
    let candidate = fs::canonicalize(base.join(raw))
        .map_err(|error| format!("failed to resolve spritesheetPath: {error}"))?;
    if !candidate.starts_with(&base) {
        return Err("spritesheetPath must stay inside the package directory".to_string());
    }
    Ok(candidate)
}

fn resolve_local_pet_source(payload: LocalImportPayload) -> Result<ResolvedLocalPetSource, String> {
    let source = PathBuf::from(payload.source.trim());
    if payload.source.trim().is_empty() {
        return Err("source path is required".to_string());
    }
    let source = fs::canonicalize(&source)
        .map_err(|error| format!("source path does not exist or cannot be read: {error}"))?;

    let mut manifest: Option<LocalPetManifest> = None;
    let mut package_dir: Option<PathBuf> = None;
    let mut spritesheet_path: Option<PathBuf> = None;

    if source.is_dir() {
        let manifest_path = source.join("pet.json");
        if !manifest_path.is_file() {
            return Err("package directory must contain pet.json".to_string());
        }
        manifest = Some(read_local_manifest(&manifest_path)?);
        package_dir = Some(source.clone());
    } else if source.is_file()
        && source
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("pet.json"))
    {
        manifest = Some(read_local_manifest(&source)?);
        package_dir = source.parent().map(Path::to_path_buf);
    } else if source.is_file() {
        spritesheet_path = Some(source.clone());
    } else {
        return Err(
            "source path must be a package directory, pet.json, or spritesheet.webp".to_string(),
        );
    }

    if let Some(manifest) = manifest.as_ref() {
        let dir = package_dir
            .as_deref()
            .ok_or_else(|| "package directory could not be resolved".to_string())?;
        let spritesheet_value = manifest
            .spritesheet_path
            .as_deref()
            .unwrap_or("spritesheet.webp");
        spritesheet_path = Some(safe_package_path(dir, spritesheet_value)?);
    }

    let spritesheet_path =
        spritesheet_path.ok_or_else(|| "spritesheet path could not be resolved".to_string())?;
    if spritesheet_path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("webp"))
    {
        return Err("current runtime imports require a .webp spritesheet".to_string());
    }

    let manifest_ref = manifest.as_ref();
    let id_hint = option_trimmed(&payload.id)
        .or_else(|| manifest_ref.and_then(|manifest| option_trimmed(&manifest.id)))
        .or_else(|| {
            package_dir
                .as_ref()
                .and_then(|dir| dir.file_name())
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .or_else(|| {
            spritesheet_path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "imported-pet".to_string());
    let id = sanitize_pet_id(&id_hint);
    if !is_valid_pet_id(&id) {
        return Err(format!("invalid pet id after sanitization: {id}"));
    }

    let display_name = option_trimmed(&payload.display_name)
        .or_else(|| manifest_ref.and_then(|manifest| option_trimmed(&manifest.display_name)))
        .unwrap_or_else(|| id.replace('-', " "));
    if display_name.trim().is_empty() {
        return Err("displayName is required".to_string());
    }

    Ok(ResolvedLocalPetSource {
        id,
        display_name: truncate_chars(&display_name, 96),
        description: truncate_chars(
            &option_trimmed(&payload.description)
                .or_else(|| manifest_ref.and_then(|manifest| option_trimmed(&manifest.description)))
                .unwrap_or_else(|| "Imported local pet.".to_string()),
            280,
        ),
        spritesheet_path,
        source_name: manifest_ref
            .and_then(|manifest| option_trimmed(&manifest.source_name))
            .or_else(|| Some("Local".to_string())),
        source_url: manifest_ref.and_then(|manifest| option_trimmed(&manifest.source_url)),
        force: payload.force,
    })
}

fn reserve_import_id(state: &AppState, requested_id: &str) -> String {
    if state.has_bundled_pet_id(requested_id) {
        sanitize_pet_id(&format!("imported-{requested_id}"))
    } else {
        requested_id.to_string()
    }
}

pub(crate) fn import_local_pet(
    app: &AppHandle,
    state: &AppState,
    payload: LocalImportPayload,
) -> Result<RuntimeSnapshot, String> {
    let resolved = resolve_local_pet_source(payload)?;
    let spritesheet_bytes = validate_webp_file(&resolved.spritesheet_path)?;
    let id = reserve_import_id(state, &resolved.id);
    let pets_dir = state
        .imported_pets_dir()
        .ok_or_else(|| "imported pet storage is not configured".to_string())?;
    let pet_dir = pets_dir.join(&id);
    if pet_dir.exists() && !resolved.force {
        return Err(format!(
            "imported pet '{id}' already exists; pass force to overwrite pet.json and spritesheet.webp"
        ));
    }
    fs::create_dir_all(&pet_dir)
        .map_err(|error| format!("failed to create imported pet directory: {error}"))?;
    fs::write(pet_dir.join("spritesheet.webp"), spritesheet_bytes)
        .map_err(|error| format!("failed to write spritesheet.webp: {error}"))?;

    let manifest = PetManifest {
        id: id.clone(),
        display_name: resolved.display_name,
        description: resolved.description,
        spritesheet_path: "spritesheet.webp".to_string(),
        source_name: resolved.source_name,
        source_url: resolved.source_url,
        imported: true,
        // 落盘后紧接着 refresh_imported_pets()，实际路径由扫描写回。
        local_spritesheet: None,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("failed to serialize pet.json: {error}"))?;
    fs::write(pet_dir.join("pet.json"), manifest_json)
        .map_err(|error| format!("failed to write pet.json: {error}"))?;

    state.refresh_imported_pets()?;
    let mut settings = state.settings();
    settings.active_pet_id = id;
    let settings = state.update_settings(settings)?;
    let _ = app.emit_to("pet", EVENT_PET_SETTINGS, settings);
    emit_status(app, state);
    Ok(state.snapshot())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn normalize_listen_address(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("listenAddress is required".to_string());
    }

    let ip = trimmed
        .parse::<IpAddr>()
        .map_err(|_| "listenAddress must be an IP address".to_string())?;
    let allowed = match ip {
        IpAddr::V4(address) => address.is_loopback() || address.is_unspecified(),
        IpAddr::V6(address) => address.is_loopback() || address.is_unspecified(),
    };

    if !allowed {
        return Err(
            "listenAddress must be loopback or unspecified, such as 127.0.0.1 or 0.0.0.0"
                .to_string(),
        );
    }

    Ok(ip.to_string())
}

fn normalize_api_config(config: RuntimeApiConfig) -> Result<RuntimeApiConfig, String> {
    if config.port == 0 {
        return Err("port must be between 1 and 65535".to_string());
    }

    Ok(RuntimeApiConfig {
        listen_address: normalize_listen_address(&config.listen_address)?,
        port: config.port,
    })
}

fn runtime_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(RUNTIME_CONFIG_FILE))
        .map_err(|error| format!("failed to resolve runtime config path: {error}"))
}

fn legacy_runtime_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(LEGACY_RUNTIME_CONFIG_FILE))
        .map_err(|error| format!("failed to resolve legacy runtime config path: {error}"))
}

fn settings_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SETTINGS_CONFIG_FILE))
        .map_err(|error| format!("failed to resolve settings config path: {error}"))
}

fn load_runtime_api_config(path: &Path, legacy_path: Option<&Path>) -> RuntimeApiConfig {
    let toml_config = fs::read_to_string(path)
        .ok()
        .and_then(|raw| toml::from_str::<RuntimeApiConfig>(&raw).ok());
    let legacy_config = || {
        legacy_path
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<RuntimeApiConfig>(&raw).ok())
    };

    toml_config
        .or_else(legacy_config)
        .and_then(|config| normalize_api_config(config).ok())
        .unwrap_or_default()
}

fn save_runtime_api_config(path: &Path, config: &RuntimeApiConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create runtime config directory: {error}"))?;
    }
    let raw = toml::to_string_pretty(config)
        .map_err(|error| format!("failed to serialize runtime config: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to save runtime config: {error}"))
}

fn load_pet_settings(path: &Path) -> PetSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| toml::from_str::<PetSettings>(&raw).ok())
        .map(normalize_pet_settings)
        .unwrap_or_default()
}

fn save_pet_settings(path: &Path, settings: &PetSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create settings config directory: {error}"))?;
    }
    let raw = toml::to_string_pretty(settings)
        .map_err(|error| format!("failed to serialize settings config: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to save settings config: {error}"))
}

fn env_runtime_api_config(mut config: RuntimeApiConfig) -> RuntimeApiConfig {
    if let Ok(value) = std::env::var("CODEX_PET_RUNTIME_HOST") {
        if let Ok(listen_address) = normalize_listen_address(&value) {
            config.listen_address = listen_address;
        }
    }

    if let Ok(value) = std::env::var("CODEX_PET_RUNTIME_PORT") {
        if let Ok(port) = value.parse::<u16>() {
            if port > 0 {
                config.port = port;
            }
        }
    }

    config
}

fn open_folder_path(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create folder before opening it: {error}"))?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open folder {}: {error}", path.display()))
}

fn normalize_external_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim();
    let url = url::Url::parse(trimmed).map_err(|_| "Enter a valid absolute URL.".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url.to_string()),
        _ => Err("Only http and https links can be opened from Settings.".to_string()),
    }
}

fn open_external_url_with_system(url: &str) -> Result<(), String> {
    let url = normalize_external_url(url)?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(&url);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open external link {url}: {error}"))
}

fn emit_status(app: &AppHandle, state: &AppState) {
    let _ = app.emit(EVENT_RUNTIME_STATUS, state.snapshot());
}

fn pet_window_is_visible(app: &AppHandle) -> Option<bool> {
    app.get_webview_window("pet")
        .and_then(|window| window.is_visible().ok())
}

fn sync_pet_visibility(app: &AppHandle, state: &AppState) {
    if let Some(visible) = pet_window_is_visible(app) {
        state.set_pet_visible(visible);
    }
}

fn show_and_focus(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window '{label}' was not found"))?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    if label == "pet" {
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        return Ok(());
    }
    window.set_focus().map_err(|error| error.to_string())
}

fn hide_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window '{label}' was not found"))?;
    window.hide().map_err(|error| error.to_string())
}

fn show_pet_window(app: &AppHandle, state: &AppState) -> Result<RuntimeSnapshot, String> {
    show_and_focus(app, "pet")?;
    state.set_pet_visible(true);
    emit_status(app, state);
    Ok(state.snapshot())
}

fn hide_pet_window(app: &AppHandle, state: &AppState) -> Result<RuntimeSnapshot, String> {
    hide_window(app, "pet")?;
    state.set_pet_visible(false);
    emit_status(app, state);
    Ok(state.snapshot())
}

fn toggle_pet_window(app: &AppHandle, state: &AppState) -> Result<RuntimeSnapshot, String> {
    let visible = pet_window_is_visible(app).unwrap_or_else(|| state.pet_visible());
    if visible {
        hide_pet_window(app, state)
    } else {
        show_pet_window(app, state)
    }
}

struct TrayLabels {
    open_settings: &'static str,
    show_pet: &'static str,
    hide_pet: &'static str,
    quit: &'static str,
}

fn tray_labels(language: PetLanguage) -> TrayLabels {
    match language {
        PetLanguage::ZhCn => TrayLabels {
            open_settings: "打开设置",
            show_pet: "显示宠物",
            hide_pet: "隐藏宠物",
            quit: "退出",
        },
        PetLanguage::En => TrayLabels {
            open_settings: "Open Settings",
            show_pet: "Show Pet",
            hide_pet: "Hide Pet",
            quit: "Quit",
        },
    }
}

fn build_tray_menu(app: &AppHandle, language: PetLanguage) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = tray_labels(language);
    let open_settings = MenuItem::with_id(
        app,
        "open_settings",
        labels.open_settings,
        true,
        None::<&str>,
    )?;
    let show_pet = MenuItem::with_id(app, "show_pet", labels.show_pet, true, None::<&str>)?;
    let hide_pet = MenuItem::with_id(app, "hide_pet", labels.hide_pet, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open_settings, &show_pet, &hide_pet, &quit])
}

fn update_tray_menu(app: &AppHandle, language: PetLanguage) -> Result<(), String> {
    let menu = build_tray_menu(app, language).map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))
            .map_err(|error| format!("failed to update tray menu: {error}"))?;
    }
    Ok(())
}

fn build_tray(app: &tauri::App, language: PetLanguage) -> tauri::Result<()> {
    let menu = build_tray_menu(app.handle(), language)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(PRODUCT_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_settings" => {
                let _ = show_and_focus(app, "settings");
            }
            "show_pet" => {
                let state = app.state::<AppState>();
                let _ = show_pet_window(app, &state);
            }
            "hide_pet" => {
                let state = app.state::<AppState>();
                let _ = hide_pet_window(app, &state);
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn hide_settings_window_on_close<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &WindowEvent,
) {
    if window.label() != "settings" {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[tauri::command]
fn get_runtime_snapshot(app: AppHandle, state: tauri::State<AppState>) -> RuntimeSnapshot {
    sync_pet_visibility(&app, &state);
    state.snapshot()
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: tauri::State<AppState>,
    settings: PetSettings,
) -> Result<RuntimeSnapshot, String> {
    let settings = state.update_settings(settings)?;
    state.refresh_imported_pets()?;
    state.persist_settings()?;
    let language = settings.language;
    let _ = app.emit_to("pet", EVENT_PET_SETTINGS, settings);
    let _ = update_tray_menu(&app, language);
    emit_status(&app, &state);
    Ok(state.snapshot())
}

#[tauri::command]
fn update_api_config(
    app: AppHandle,
    state: tauri::State<AppState>,
    config: RuntimeApiConfig,
) -> Result<RuntimeSnapshot, String> {
    state.update_runtime_api_config(config)?;
    emit_status(&app, &state);
    Ok(state.snapshot())
}

#[tauri::command]
fn trigger_action(
    app: AppHandle,
    state: tauri::State<AppState>,
    animation_id: String,
) -> RuntimeSnapshot {
    let payload = ActionPayload {
        animation_id: animation_id.trim().to_string(),
    };
    state.record_action(payload.animation_id.clone());
    let _ = app.emit_to("pet", EVENT_PET_ACTION, payload);
    emit_status(&app, &state);
    state.snapshot()
}

#[tauri::command]
fn say(
    app: AppHandle,
    state: tauri::State<AppState>,
    text: String,
    ttl_ms: Option<u64>,
) -> RuntimeSnapshot {
    let payload = SayPayload {
        text: text.trim().chars().take(512).collect(),
        ttl_ms,
    };
    state.record_say(payload.text.clone(), payload.ttl_ms);
    let _ = app.emit_to("pet", EVENT_PET_SAY, payload);
    emit_status(&app, &state);
    state.snapshot()
}

#[tauri::command]
fn trigger_event(
    app: AppHandle,
    state: tauri::State<AppState>,
    event_type: CompanionEventType,
    message: Option<String>,
    ttl_ms: Option<u64>,
) -> RuntimeSnapshot {
    let payload = CompanionEventPayload {
        event_type,
        message,
        ttl_ms,
    };
    emit_companion_event(&app, &state, payload);
    state.snapshot()
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    show_and_focus(&app, "settings")
}

#[tauri::command]
fn show_pet(app: AppHandle, state: tauri::State<AppState>) -> Result<RuntimeSnapshot, String> {
    show_pet_window(&app, &state)
}

#[tauri::command]
fn hide_pet(app: AppHandle, state: tauri::State<AppState>) -> Result<RuntimeSnapshot, String> {
    hide_pet_window(&app, &state)
}

#[tauri::command]
fn toggle_pet_visibility(
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<RuntimeSnapshot, String> {
    toggle_pet_window(&app, &state)
}

#[tauri::command]
fn open_pet_storage_folder(
    state: tauri::State<AppState>,
    folder: PetStorageFolderKind,
) -> Result<String, String> {
    let snapshot = state.snapshot().pet_storage;
    let path = match folder {
        PetStorageFolderKind::Active => PathBuf::from(snapshot.active_dir),
        PetStorageFolderKind::AppData => PathBuf::from(snapshot.app_data_dir),
        PetStorageFolderKind::CodexCustom => PathBuf::from(snapshot.codex_dir),
    };
    open_folder_path(&path)?;
    Ok(path_to_display(&path))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_with_system(&url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new(RuntimeApiConfig::default());
    // Single instance per Windows user session, keyed by the app identifier. The exit
    // token comes from whoever spawned us; without it the protocol exit stays closed.
    state.configure_identity(true, exit_token_from_env());

    tauri::Builder::default()
        // Registered first so a duplicate launch exits during plugin setup, before this
        // process creates any window or starts the HTTP service.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let state = app.state::<AppState>();
            // Never open a second window and never infer ownership from the port:
            // surface the running instance and let the caller probe /api/status.
            let _ = show_and_focus(app, "pet");
            sync_pet_visibility(app, &state);
            emit_status(app, &state);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .manage(state.clone())
        .on_window_event(hide_settings_window_on_close)
        .setup(move |app| {
            match runtime_config_path(app.handle()) {
                Ok(path) => {
                    let legacy_path = legacy_runtime_config_path(app.handle()).ok();
                    let config = env_runtime_api_config(load_runtime_api_config(
                        &path,
                        legacy_path.as_deref(),
                    ));
                    state.configure_runtime_api(config, Some(path));
                }
                Err(error) => {
                    state.mark_api_error(error);
                    state.configure_runtime_api(
                        env_runtime_api_config(RuntimeApiConfig::default()),
                        None,
                    );
                }
            }
            match app.handle().path().app_data_dir() {
                Ok(app_data_dir) => {
                    let settings_path = settings_config_path(app.handle()).ok();
                    if let Err(error) =
                        state.configure_app_paths(app_data_dir, settings_path.clone())
                    {
                        state.mark_api_error(error);
                    }
                    if let Some(path) = settings_path {
                        if let Err(error) = state.configure_settings(load_pet_settings(&path)) {
                            state.mark_api_error(error);
                        }
                    }
                    if let Err(error) = state.refresh_imported_pets() {
                        state.mark_api_error(error);
                    }
                }
                Err(error) => state.mark_api_error(format!("failed to resolve app data: {error}")),
            }
            build_tray(app, state.settings().language)?;
            // The pet window is created hidden so a duplicate process never flashes one;
            // the owner shows it once it is certain it owns the instance.
            let _ = show_and_focus(app.handle(), "pet");
            sync_pet_visibility(app.handle(), &state);
            http_api::start_http_api(app.handle().clone(), state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_snapshot,
            update_settings,
            update_api_config,
            trigger_action,
            say,
            trigger_event,
            open_settings,
            show_pet,
            hide_pet,
            toggle_pet_visibility,
            open_pet_storage_folder,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running PetShell");
}

pub(crate) fn emit_http_action(app: &AppHandle, state: &AppState, payload: ActionPayload) {
    state.record_action(payload.animation_id.clone());
    let _ = app.emit_to("pet", EVENT_PET_ACTION, payload);
    emit_status(app, state);
}

pub(crate) fn emit_http_say(app: &AppHandle, state: &AppState, payload: SayPayload) {
    state.record_say(payload.text.clone(), payload.ttl_ms);
    let _ = app.emit_to("pet", EVENT_PET_SAY, payload);
    emit_status(app, state);
}

pub(crate) fn emit_companion_event(
    app: &AppHandle,
    state: &AppState,
    payload: CompanionEventPayload,
) {
    let settings = state.settings();
    let animation_id = payload.event_type.animation_id();
    let message = payload
        .message
        .unwrap_or_default()
        .trim()
        .chars()
        .take(512)
        .collect::<String>();
    let custom_message = if message.is_empty() {
        None
    } else {
        Some(message)
    };
    let bubble_text = custom_message
        .clone()
        .or_else(|| Some(payload.event_type.default_bubble().to_string()));
    let recent = RecentCompanionEvent {
        event_type: payload.event_type,
        message: custom_message,
        animation_id,
        bubble_text: bubble_text.clone(),
        received_at_ms: now_ms(),
    };
    let visible_bubble_text = if settings.event_bubbles {
        bubble_text.clone()
    } else {
        None
    };
    let visible_bubble_ttl_ms = if settings.event_bubbles {
        payload.ttl_ms.or(Some(settings.event_bubble_ttl_ms))
    } else {
        None
    };

    state.record_companion_event(
        recent,
        settings.event_reactions,
        visible_bubble_text,
        visible_bubble_ttl_ms,
    );

    if settings.event_reactions {
        let _ = app.emit_to(
            "pet",
            EVENT_PET_ACTION,
            ActionPayload {
                animation_id: animation_id.as_str().to_string(),
            },
        );
    }

    if settings.event_bubbles {
        if let Some(text) = bubble_text {
            let _ = app.emit_to(
                "pet",
                EVENT_PET_SAY,
                SayPayload {
                    text,
                    ttl_ms: visible_bubble_ttl_ms,
                },
            );
        }
    }

    emit_status(app, state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_local_package_directory() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/pets/nia");
        let resolved = resolve_local_pet_source(LocalImportPayload {
            source: source.to_string_lossy().to_string(),
            id: None,
            display_name: None,
            description: None,
            force: false,
        })
        .unwrap();

        assert_eq!(resolved.id, "nia");
        assert_eq!(resolved.display_name, "Nia");
        assert!(resolved.spritesheet_path.ends_with("spritesheet.webp"));
    }

    #[test]
    fn validates_webp_header() {
        let mut valid = b"RIFF0000WEBPVP8 ".to_vec();
        valid.extend_from_slice(&[0; 8]);
        assert!(validate_webp(&valid).is_ok());
        assert!(validate_webp(b"not a webp image").is_err());
    }

    #[test]
    fn normalizes_external_settings_links() {
        assert_eq!(
            normalize_external_url(" https://example.test/attribution ").unwrap(),
            "https://example.test/attribution".to_string()
        );
        assert!(normalize_external_url("file:///C:/Users/example").is_err());
        assert!(normalize_external_url("javascript:alert(1)").is_err());
        assert!(normalize_external_url("not a url").is_err());
    }

    #[test]
    fn defaults_to_random_click_mode_with_fallback_pool() {
        let settings = PetSettings::default();
        assert_eq!(settings.click_action_mode, ClickActionMode::Random);
        assert_eq!(settings.click_action, PetActionAnimationId::Waving);
        assert!(settings.click_action_pool.contains(&settings.click_action));
    }

    #[test]
    fn keeps_imported_active_pet_when_loading_settings_before_catalog_refresh() {
        let root = std::env::temp_dir().join(format!(
            "petshell-active-pet-persist-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let imported_root = root.join("pets");
        let pet_dir = imported_root.join("imported-nia");
        fs::create_dir_all(&pet_dir).unwrap();
        fs::write(pet_dir.join("spritesheet.webp"), b"placeholder").unwrap();
        fs::write(
            pet_dir.join("pet.json"),
            r#"{
  "id": "imported-nia",
  "displayName": "Imported Nia",
  "description": "Imported pet",
  "spritesheetPath": "spritesheet.webp",
  "imported": true
}"#,
        )
        .unwrap();

        let state = AppState::new(RuntimeApiConfig::default());
        state
            .configure_app_paths(root.join("app-data"), None)
            .unwrap();
        let mut settings = PetSettings::default();
        settings.pet_storage_preset = PetStoragePreset::Custom;
        settings.custom_pet_storage_dir = Some(imported_root.to_string_lossy().to_string());
        settings.active_pet_id = "imported-nia".to_string();

        state.configure_settings(settings).unwrap();
        state.refresh_imported_pets().unwrap();

        assert_eq!(state.settings().active_pet_id, "imported-nia");
        assert_eq!(state.snapshot().active_pet.id, "imported-nia");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalizes_renderer_and_appearance_settings() {
        let defaults = PetSettings::default();
        assert_eq!(defaults.renderer, PetRendererId::Sprite);
        assert_eq!(defaults.live2d_appearance, "hiyori");

        // 外观名只做安全字符串归一化：合法性由 renderer 依据自己的目录判定。
        let mut settings = PetSettings::default();
        settings.live2d_appearance = "  HiYoRi!!  ".to_string();
        assert_eq!(normalize_pet_settings(settings).live2d_appearance, "hiyori");

        let mut settings = PetSettings::default();
        settings.live2d_appearance = String::new();
        assert!(!normalize_pet_settings(settings).live2d_appearance.is_empty());

        // 表现出口是封闭枚举：未知取值在反序列化阶段就被拒，不会静默退化成 sprite。
        assert_eq!(
            serde_json::from_str::<PetRendererId>("\"sprite\"").unwrap(),
            PetRendererId::Sprite
        );
        assert_eq!(
            serde_json::from_str::<PetRendererId>("\"live2d\"").unwrap(),
            PetRendererId::Live2d
        );
        assert!(serde_json::from_str::<PetRendererId>("\"three\"").is_err());
    }

    #[test]
    fn normalizes_runtime_api_config() {
        let config = normalize_api_config(RuntimeApiConfig {
            listen_address: " 0.0.0.0 ".to_string(),
            port: 17322,
        })
        .unwrap();

        assert_eq!(config.listen_address, "0.0.0.0");
        assert_eq!(config.port, 17322);
        assert!(normalize_api_config(RuntimeApiConfig {
            listen_address: "192.168.1.10".to_string(),
            port: 17321,
        })
        .is_err());
        assert!(normalize_api_config(RuntimeApiConfig {
            listen_address: "127.0.0.1".to_string(),
            port: 0,
        })
        .is_err());
    }

    #[test]
    fn compares_exit_tokens_in_constant_time_shape() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abcdef", b"abcde"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn rejects_short_or_missing_exit_tokens_and_keeps_the_exit_path_closed() {
        let state = AppState::new(RuntimeApiConfig::default());
        state.configure_identity(true, Some("too-short".to_string()));
        let capability = state.shutdown_capability();
        assert!(!capability.available);
        assert!(capability.reason.is_some());
        assert!(matches!(
            state.begin_shutdown(Some("too-short")),
            ShutdownDecision::NotAvailable(_)
        ));

        let state = AppState::new(RuntimeApiConfig::default());
        state.configure_identity(true, None);
        assert!(!state.shutdown_capability().available);
        assert!(matches!(
            state.begin_shutdown(Some("0123456789abcdef")),
            ShutdownDecision::NotAvailable(_)
        ));
    }

    #[test]
    fn authorizes_protocol_exit_only_with_the_matching_token() {
        let state = AppState::new(RuntimeApiConfig::default());
        state.configure_identity(true, Some("0123456789abcdef".to_string()));
        assert!(state.shutdown_capability().available);

        // Missing and wrong credentials are distinguishable, and neither exits.
        assert_eq!(state.begin_shutdown(None), ShutdownDecision::TokenRequired);
        assert_eq!(
            state.begin_shutdown(Some("0123456789abcde")),
            ShutdownDecision::TokenInvalid
        );
        assert_eq!(
            state.begin_shutdown(Some("0123456789abcdef")),
            ShutdownDecision::Accepted
        );
        // A repeat request has a defined result instead of exiting twice.
        assert_eq!(
            state.begin_shutdown(Some("0123456789abcdef")),
            ShutdownDecision::AlreadyInProgress
        );
    }

    #[test]
    fn reports_real_identity_without_impersonating_upstream() {
        let state = AppState::new(RuntimeApiConfig::default());
        let snapshot = state.snapshot();

        assert_eq!(snapshot.product.name, PRODUCT_NAME);
        assert_eq!(snapshot.product.version, PRODUCT_VERSION);
        // Attribution, not a claim to be OpenPet.
        assert!(snapshot.product.upstream.contains("OpenPet"));
        assert_ne!(snapshot.product.name, "OpenPet");

        assert!(snapshot.capabilities.single_instance);
        assert!(snapshot.capabilities.instance_owner);
        assert_eq!(snapshot.capabilities.shutdown.endpoint, SHUTDOWN_ENDPOINT);
        assert_eq!(
            snapshot.capabilities.shutdown.version,
            SHUTDOWN_CONTRACT_VERSION
        );
        assert_eq!(snapshot.capabilities.shutdown.auth, SHUTDOWN_AUTH_SCHEME);
    }

    #[test]
    fn serves_spritesheets_for_imported_pets_whose_directory_name_differs_from_the_id() {
        // Codex 约定：目录名任意、身份写在 pet.json 里。扫描按目录枚举，若查询时改用
        // 清单 id 当目录名拼路径，快照广告的 spritesheetUrl 就会 404（MVP-13 DEF-3）。
        let root = std::env::temp_dir().join(format!(
            "petshell-imported-dir-mismatch-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let imported_root = root.join("pets");
        let pet_dir = imported_root.join("phoebe");
        fs::create_dir_all(&pet_dir).unwrap();
        fs::write(pet_dir.join("spritesheet.webp"), b"placeholder").unwrap();
        fs::write(
            pet_dir.join("pet.json"),
            r#"{
  "id": "phoebe-jiubi",
  "displayName": "Phoebe",
  "description": "directory name differs from the manifest id",
  "spritesheetPath": "spritesheet.webp",
  "imported": true
}"#,
        )
        .unwrap();

        let state = AppState::new(RuntimeApiConfig::default());
        state
            .configure_app_paths(root.join("app-data"), None)
            .unwrap();
        let mut settings = PetSettings::default();
        settings.pet_storage_preset = PetStoragePreset::Custom;
        settings.custom_pet_storage_dir = Some(imported_root.to_string_lossy().to_string());
        state.configure_settings(settings).unwrap();
        state.refresh_imported_pets().unwrap();

        // 目录被扫描接受，清单 id 也进了 catalog。
        assert!(state
            .snapshot()
            .pet_catalog
            .iter()
            .any(|pet| pet.id == "phoebe-jiubi" && pet.imported));

        // 广告出去的 URL 必须真的取得到。
        assert_eq!(
            state.imported_pet_spritesheet_path("phoebe-jiubi"),
            Some(pet_dir.join("spritesheet.webp"))
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_model_asset_paths_that_escape_the_models_directory() {
        let root = Path::new("/models");

        // 真实模型里的形态：外观目录 + 文件，可再带一层子目录。
        for accepted in [
            "hiyori/Hiyori.model3.json",
            "hiyori/Hiyori.moc3",
            "hiyori/motions/Hiyori_m01.motion3.json",
            "hiyori/Hiyori.2048/texture_00.png",
            "mao/expressions/exp_01.exp3.json",
        ] {
            let resolved = resolve_live2d_asset(root, accepted).expect(accepted);
            assert!(resolved.starts_with(root));
            assert!(resolved.ends_with(accepted));
        }

        // 逃逸尝试与非资源形态一律拒绝（不做纠正、不做规范化后再判断）。
        for rejected in [
            "",
            "hiyori",
            "hiyori/",
            "hiyori//texture.png",
            "../secrets",
            "hiyori/../../secrets",
            "hiyori/..",
            "/etc/passwd",
            "hiyori\\..\\..\\secrets",
            "hiyori/%2e%2e/secrets",
            "hiyori/texture.png?x=1",
            "hiyori/te:xture.png",
        ] {
            assert!(
                resolve_live2d_asset(root, rejected).is_none(),
                "accepted {rejected}"
            );
        }

        // 超长输入直接拒绝，不截断后使用。
        let long = format!("hiyori/{}", "a".repeat(600));
        assert!(resolve_live2d_asset(root, &long).is_none());
    }
}
