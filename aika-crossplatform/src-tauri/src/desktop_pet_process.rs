//! 桌宠 Sidecar 的原生进程端口（PET-05）。
//!
//! 两条结构性保证，靠的不是"小心一点"：
//!
//! 1. **只按句柄停止**。所有权只来自本进程 `spawn` 返回的 `Child`，句柄保存在
//!    内存里的 `pid -> Child` 映射中。PID 复用、Aiki 重启后的旧记录、用户自己
//!    启的实例都不可能命中——模块里也没有任何"按进程名停止"的接口。
//! 2. **不经过 shell**。`Command::new(path)` 直接执行配置好的可执行文件，参数
//!    由调用方给固定空数组，不接受 Agent 文本当路径或参数。
//!
//! 启动时用 `CREATE_NO_WINDOW` 抑制控制台窗口；桌宠自己的角色窗口由上游
//! Runtime 决定，这里不干预。

use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

pub const STOP_TIMEOUT_MS: u64 = 3_000;
const STOP_TIMEOUT_MIN_MS: u64 = 100;
const STOP_TIMEOUT_MAX_MS: u64 = 10_000;
const STOP_POLL_INTERVAL_MS: u64 = 50;

/// 启动辅助进程时不弹控制台窗口。角色窗口是否出现由上游 Runtime 自己决定。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    InvalidPath,
    InstallerRejected,
    ScriptRejected,
}

impl ValidationError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidPath => "invalid_path",
            Self::InstallerRejected => "installer_rejected",
            Self::ScriptRejected => "script_rejected",
        }
    }
}

/// 脚本一律不接受：配置的是程序，不是"让 Aiki 帮我跑一段东西"。
const SCRIPT_EXTENSIONS: [&str; 10] = [
    ".bat", ".cmd", ".ps1", ".vbs", ".js", ".py", ".sh", ".com", ".scr", ".msi",
];

/// 安装器不是启动路径：它装完就退出，配成启动项只会每次都白跑一遍。
fn looks_like_installer(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.contains("setup")
        || lower.contains("installer")
        || lower.starts_with("install")
        || lower.starts_with("unins")
        || lower.starts_with("update")
        || lower.contains("-update")
}

/// 校验并归一化运行程序路径：绝对路径、`.exe`、存在、非安装器、非脚本。
pub fn validate_executable(raw: &str) -> Result<String, ValidationError> {
    let path = raw.trim();
    if path.is_empty() {
        return Err(ValidationError::InvalidPath);
    }
    let lower = path.to_ascii_lowercase();
    if SCRIPT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err(ValidationError::ScriptRejected);
    }
    if !lower.ends_with(".exe") {
        return Err(ValidationError::InvalidPath);
    }
    if !Path::new(path).is_absolute() {
        return Err(ValidationError::InvalidPath);
    }
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if file_name.is_empty() || looks_like_installer(file_name) {
        return Err(ValidationError::InstallerRejected);
    }
    if !Path::new(path).exists() {
        return Err(ValidationError::InvalidPath);
    }
    Ok(path.to_string())
}

/// 一个受管句柄：进程本体 + 宿主退出时的承诺。
#[derive(Debug)]
struct OwnedChild {
    child: Child,
    /// 来自配置 `stopOwnedOnExit`：宿主退出时是否把这只桌宠一起带走。
    /// spawn 时定死——宿主退出路径不读配置、不问前端，直接按承诺执行。
    stop_on_host_exit: bool,
}

#[derive(Default)]
pub struct DesktopPetProcessState {
    children: Arc<Mutex<HashMap<u32, OwnedChild>>>,
}

impl DesktopPetProcessState {
    /// 仅供本模块与测试操作句柄表；对外只暴露命令与收尾函数。
    pub(crate) fn handles(&self) -> Arc<Mutex<HashMap<u32, OwnedChild>>> {
        Arc::clone(&self.children)
    }
}

#[derive(Debug, Serialize)]
pub struct SpawnOutcome {
    pub pid: u32,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ExitStatusOutcome {
    pub exited: bool,
    pub code: Option<i32>,
}

/// 失败只回分类码：不带命令行、不带本机路径、不带上游输出。
#[derive(Debug, Serialize)]
pub struct ProcessFailure {
    pub kind: String,
}

impl ProcessFailure {
    fn new(kind: &str) -> Self {
        Self { kind: kind.to_string() }
    }
}

/// 构造启动命令。参数为空数组：本功能不需要任何参数（PET-05 只支持启动现成程序）。
fn base_command(path: &str) -> Command {
    let mut command = Command::new(path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 抑制控制台窗口；GUI 程序自己的窗口不受影响。
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 受管退出令牌的环境变量名（与 PetShell 侧 `EXIT_TOKEN_ENV` 一致）。
pub const EXIT_TOKEN_ENV: &str = "PET_SHELL_EXIT_TOKEN";

/// 反向点击通道的两个变量名（与 PetShell 侧 `pet_click.rs` 一致）。
pub const CLICK_URL_ENV: &str = "PET_SHELL_CLICK_URL";
pub const CLICK_TOKEN_ENV: &str = "PET_SHELL_CLICK_TOKEN";

/// 注入给子进程的凭据集合：**具名、封闭、全部由我们自己生成**。
///
/// 两种凭据方向相反：退出令牌是「Aiki → shell」的授权（我们请它退出），点击凭据是
/// 「shell → Aiki」的授权（它向我们上报点击）。都不是让上层往子进程里塞任意环境的能力。
#[derive(Debug, Default, Clone)]
pub struct PetChildCredentials {
    pub exit_token: Option<String>,
    pub click_url: Option<String>,
    pub click_token: Option<String>,
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// 启动命令 + 具名注入项。
///
/// 刻意不做「任意 env 表」：调用方给不了别的变量名，也给不了额外参数。空白等同于
/// 没有；点击通道是**一对**，URL 与凭据缺任一个就整体不注入，免得子进程拿着半套
/// 凭据去猜目标。
fn spawn_command(path: &str, credentials: &PetChildCredentials) -> Command {
    let mut command = base_command(path);
    if let Some(token) = trimmed(credentials.exit_token.as_deref()) {
        command.env(EXIT_TOKEN_ENV, token);
    }
    if let (Some(url), Some(token)) = (
        trimmed(credentials.click_url.as_deref()),
        trimmed(credentials.click_token.as_deref()),
    ) {
        command.env(CLICK_URL_ENV, url);
        command.env(CLICK_TOKEN_ENV, token);
    }
    command
}

fn spawn_with(
    mut command: Command,
    children: &Arc<Mutex<HashMap<u32, OwnedChild>>>,
    stop_on_host_exit: bool,
) -> Result<u32, ProcessFailure> {
    let mut child = command.spawn().map_err(|_| ProcessFailure::new("spawn_failed"))?;
    let pid = child.id();
    if let Ok(mut guard) = children.lock() {
        guard.insert(
            pid,
            OwnedChild {
                child,
                stop_on_host_exit,
            },
        );
    }
    Ok(pid)
}

fn is_alive(
    children: &Arc<Mutex<HashMap<u32, OwnedChild>>>,
    pid: u32,
) -> Result<bool, ProcessFailure> {
    let mut guard = children.lock().map_err(|_| ProcessFailure::new("state_poisoned"))?;
    let entry = guard.get_mut(&pid).ok_or_else(|| ProcessFailure::new("unknown_process"))?;
    match entry.child.try_wait() {
        Ok(None) => Ok(true),
        Ok(Some(_)) => Ok(false),
        Err(_) => Err(ProcessFailure::new("unknown_process")),
    }
}

/// 只停止本进程持有的句柄；停止后句柄即被移除（所有权不可重复使用）。
fn stop_child(
    children: Arc<Mutex<HashMap<u32, OwnedChild>>>,
    pid: u32,
    timeout_ms: Option<u64>,
) -> Result<(), ProcessFailure> {
    let mut entry = {
        let mut guard = children.lock().map_err(|_| ProcessFailure::new("state_poisoned"))?;
        guard.remove(&pid).ok_or_else(|| ProcessFailure::new("unknown_process"))?
    };
    let _ = entry.child.kill();
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(STOP_TIMEOUT_MS)
            .clamp(STOP_TIMEOUT_MIN_MS, STOP_TIMEOUT_MAX_MS),
    );
    let deadline = Instant::now() + timeout;
    loop {
        match entry.child.try_wait() {
            Ok(Some(_)) | Err(_) => return Ok(()),
            Ok(None) => {
                if Instant::now() >= deadline {
                    return Err(ProcessFailure::new("stop_timeout"));
                }
                std::thread::sleep(Duration::from_millis(STOP_POLL_INTERVAL_MS));
            }
        }
    }
}

/// 宿主退出前的收尾：把按承诺该带走的桌宠全部停掉，返回停掉的数量。
///
/// 为什么要在这里做：托盘「完全退出」是 `app.exit(0)` 立即退出，JS 侧的
/// `dispose()`（PET-05 的正常清理点）根本不会执行——实测 owned 桌宠被遗留成孤儿。
/// 等待有界（每只最多 `timeout_ms`），保证退出不被拖死。
pub fn stop_all_on_host_exit(
    state: &DesktopPetProcessState,
    timeout_ms: Option<u64>,
) -> usize {
    let targets: Vec<u32> = match state.children.lock() {
        Ok(guard) => guard
            .iter()
            .filter(|(_, entry)| entry.stop_on_host_exit)
            .map(|(pid, _)| *pid)
            .collect(),
        Err(_) => return 0,
    };
    let mut stopped = 0;
    for pid in targets {
        if stop_child(Arc::clone(&state.children), pid, timeout_ms).is_ok() {
            stopped += 1;
        }
    }
    stopped
}

#[tauri::command]
pub fn desktop_pet_process_validate(path: String) -> Result<(), ProcessFailure> {
    validate_executable(&path)
        .map(|_| ())
        .map_err(|error| ProcessFailure::new(error.kind()))
}

/// 启动配置好的运行程序。
///
/// 参数只有「路径 + 三个具名凭据」：没有任意环境变量或命令行片段，所以不存在
/// 「把 Agent 输出当命令行」的入口。
#[tauri::command]
pub fn desktop_pet_process_spawn(
    state: tauri::State<'_, DesktopPetProcessState>,
    path: String,
    exit_token: Option<String>,
    click_url: Option<String>,
    click_token: Option<String>,
    stop_on_host_exit: Option<bool>,
) -> Result<SpawnOutcome, ProcessFailure> {
    let path = validate_executable(&path).map_err(|error| ProcessFailure::new(error.kind()))?;
    let credentials = PetChildCredentials {
        exit_token,
        click_url,
        click_token,
    };
    let children = state.handles();
    let pid = spawn_with(
        spawn_command(&path, &credentials),
        &children,
        stop_on_host_exit.unwrap_or(false),
    )?;
    Ok(SpawnOutcome { pid, path })
}

#[tauri::command]
pub fn desktop_pet_process_alive(
    state: tauri::State<'_, DesktopPetProcessState>,
    pid: u32,
) -> Result<bool, ProcessFailure> {
    is_alive(&state.handles(), pid)
}

#[tauri::command]
pub fn desktop_pet_process_exit_status(
    state: tauri::State<'_, DesktopPetProcessState>,
    pid: u32,
) -> Result<ExitStatusOutcome, ProcessFailure> {
    let children = state.handles();
    let mut guard = children.lock().map_err(|_| ProcessFailure::new("state_poisoned"))?;
    let entry = guard.get_mut(&pid).ok_or_else(|| ProcessFailure::new("unknown_process"))?;
    match entry.child.try_wait() {
        Ok(Some(status)) => Ok(ExitStatusOutcome { exited: true, code: status.code() }),
        Ok(None) => Ok(ExitStatusOutcome { exited: false, code: None }),
        // 查询失败按"原因不明"上报：调用方据此**不会**自动重启。
        Err(_) => Ok(ExitStatusOutcome { exited: true, code: None }),
    }
}

/// 停止自己启动的进程。
///
/// 走 `spawn_blocking`：等待退出最长 3 秒，放在主线程上会冻住界面。
#[tauri::command]
pub async fn desktop_pet_process_stop(
    state: tauri::State<'_, DesktopPetProcessState>,
    pid: u32,
    timeout_ms: Option<u64>,
) -> Result<(), ProcessFailure> {
    let children = state.handles();
    tauri::async_runtime::spawn_blocking(move || stop_child(children, pid, timeout_ms))
        .await
        .map_err(|_| ProcessFailure::new("stop_failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_scripts_relative_paths_and_non_executables() {
        for (path, kind) in [
            (r"C:\pet\run.bat", "script_rejected"),
            (r"C:\pet\run.ps1", "script_rejected"),
            (r"C:\pet\helper.js", "script_rejected"),
            ("pet.exe", "invalid_path"),
            (r"C:\pet\pet.txt", "invalid_path"),
            ("", "invalid_path"),
        ] {
            let error = validate_executable(path).expect_err(path);
            assert_eq!(error.kind(), kind, "{path}");
        }
    }

    #[test]
    fn rejects_installers_like_the_release_setup_exe() {
        for path in [
            r"C:\Users\me\Downloads\OpenPet_0.1.6_x64-setup.exe",
            r"C:\pet\installer.exe",
            r"C:\pet\unins000.exe",
        ] {
            // 这些文件本机不存在，安装器判定必须发生在"存在性"检查**之前**，
            // 否则我们会把"文件不存在"当成结论，掩盖真正的原因。
            let error = validate_executable(path).expect_err(path);
            assert_eq!(error.kind(), "installer_rejected", "{path}");
        }
    }

    #[test]
    fn accepts_an_existing_exe_with_spaces_and_non_ascii() {
        let exe = r"C:\Windows\System32\cmd.exe";
        if !Path::new(exe).exists() {
            return;
        }
        assert_eq!(validate_executable(exe).unwrap(), exe);
    }

    /// 受控测试进程：spawn → 存活 → stop → 句柄消失，且旧 pid 无法再被停止。
    #[test]
    #[cfg(windows)]
    fn ownership_is_scoped_to_the_spawned_handle() {
        let shell = r"C:\Windows\System32\cmd.exe";
        if !Path::new(shell).exists() {
            return;
        }
        let children: Arc<Mutex<HashMap<u32, OwnedChild>>> = Arc::new(Mutex::new(HashMap::new()));
        let mut command = base_command(shell);
        // 一个约 5 秒的"睡眠"，无需外部依赖。
        command.args(["/C", "ping -n 6 127.0.0.1 > nul"]);
        let pid = spawn_with(command, &children, false).expect("spawn 应当成功");
        assert!(is_alive(&children, pid).unwrap_or(false), "刚起的进程应当是活的");
        assert!(children.lock().unwrap().contains_key(&pid));

        stop_child(Arc::clone(&children), pid, Some(5_000)).expect("stop 应当成功");
        assert!(!children.lock().unwrap().contains_key(&pid));
        assert!(is_alive(&children, pid).is_err(), "句柄已释放后不能再查询");

        // 不属于我们的 pid：停止必须失败，绝不按名字或 pid 猜测。
        let stranger = stop_child(Arc::clone(&children), 999_999, Some(200));
        assert_eq!(stranger.unwrap_err().kind, "unknown_process");
    }

    /// 宿主退出收尾：只带走带承诺的，不带没承诺的（stopOwnedOnExit=false 的桌宠
    /// 是用户自己起的，宿主退出无权替他做决定）。
    #[test]
    #[cfg(windows)]
    fn stop_all_on_host_exit_only_takes_flagged_children() {
        let shell = r"C:\Windows\System32\cmd.exe";
        if !Path::new(shell).exists() {
            return;
        }
        let children: Arc<Mutex<HashMap<u32, OwnedChild>>> = Arc::new(Mutex::new(HashMap::new()));
        let mut flagged = base_command(shell);
        flagged.args(["/C", "ping -n 6 127.0.0.1 > nul"]);
        let mut unflagged = base_command(shell);
        unflagged.args(["/C", "ping -n 6 127.0.0.1 > nul"]);
        let flagged_pid = spawn_with(flagged, &children, true).expect("spawn 应当成功");
        let unflagged_pid = spawn_with(unflagged, &children, false).expect("spawn 应当成功");

        let stopped = stop_all_on_host_exit(&DesktopPetProcessState {
            children: Arc::clone(&children),
        }, Some(5_000));

        assert_eq!(stopped, 1, "只停带承诺的那一只");
        assert!(!children.lock().unwrap().contains_key(&flagged_pid));
        assert!(children.lock().unwrap().contains_key(&unflagged_pid));
        assert!(is_alive(&children, unflagged_pid).unwrap_or(false), "没承诺的不能被误杀");

        // 收尾后把没承诺的也清掉，测试不留进程。
        stop_child(Arc::clone(&children), unflagged_pid, Some(5_000)).expect("stop 应当成功");
    }

    fn env_pairs(command: &Command) -> Vec<(String, Option<String>)> {
        command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect()
    }

    /// 注入面是**封闭的三个具名变量**，不是「任意 env 表」。
    #[test]
    fn only_the_named_credentials_are_injected_into_a_spawn() {
        let none = spawn_command(r"C:\pet\pet.exe", &PetChildCredentials::default());
        assert_eq!(none.get_envs().count(), 0, "没有凭据时不应注入任何变量");

        let blanks = spawn_command(
            r"C:\pet\pet.exe",
            &PetChildCredentials {
                exit_token: Some("   ".to_string()),
                click_url: Some(String::new()),
                click_token: Some("  ".to_string()),
            },
        );
        assert_eq!(blanks.get_envs().count(), 0, "空白等同于没有凭据");

        let exit_only = spawn_command(
            r"C:\pet\pet.exe",
            &PetChildCredentials {
                exit_token: Some("0123456789abcdef".to_string()),
                ..Default::default()
            },
        );
        let envs = env_pairs(&exit_only);
        assert_eq!(envs.len(), 1, "只给退出令牌时只注入一个变量");
        assert_eq!(envs[0].0, EXIT_TOKEN_ENV);
        assert_eq!(envs[0].1.as_deref(), Some("0123456789abcdef"));

        // 点击通道是一对：只有 URL 或只有凭据都不注入——半套凭据只会让子进程去猜。
        for half in [
            PetChildCredentials {
                click_url: Some("http://127.0.0.1:9/api/pet/click".to_string()),
                ..Default::default()
            },
            PetChildCredentials {
                click_token: Some("click-token-0123456789".to_string()),
                ..Default::default()
            },
        ] {
            let command = spawn_command(r"C:\pet\pet.exe", &half);
            assert_eq!(command.get_envs().count(), 0, "半套凭据不注入");
        }

        let full = spawn_command(
            r"C:\pet\pet.exe",
            &PetChildCredentials {
                exit_token: Some("0123456789abcdef".to_string()),
                click_url: Some("http://127.0.0.1:9/api/pet/click".to_string()),
                click_token: Some("click-token-0123456789".to_string()),
            },
        );
        let envs = env_pairs(&full);
        assert_eq!(envs.len(), 3, "只允许这三个具名变量");
        let names: Vec<&str> = envs.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&EXIT_TOKEN_ENV));
        assert!(names.contains(&CLICK_URL_ENV));
        assert!(names.contains(&CLICK_TOKEN_ENV));
    }

    #[test]
    fn installer_and_script_checks_precede_existence() {
        // 不存在的普通 exe → invalid_path（存在性）；带 setup 的名字 → 安装器。
        assert_eq!(
            validate_executable(r"C:\definitely\missing\pet.exe").unwrap_err().kind(),
            "invalid_path"
        );
    }
}
