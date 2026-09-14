mod desktop_pet_http;
mod desktop_pet_process;
mod foreground;
mod gateway;
// SPEC 声明的文件名 petWindow.rs；Rust 命名规范告警在此豁免。
#[allow(non_snake_case)]
mod petWindow;
mod remote;
mod screen;
mod secret_store;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(remote::RemoteState::default())
        // 桌宠 Sidecar 的进程句柄表（PET-05）：只存在于内存，不持久化 PID。
        .manage(desktop_pet_process::DesktopPetProcessState::default())
        .manage(foreground::ForegroundState::default())
        // 缺 manage 时 `tauri::State<ScreenState>` 在真实进程里取不到（FE-21 只跑了
        // 逻辑轨，这条装配断点没被覆盖）。FE-32 的窗口抓取同样依赖它。
        .manage(screen::ScreenState::default())
        .invoke_handler(tauri::generate_handler![
            foreground::environment_foreground_supported,
            foreground::environment_foreground_enable,
            foreground::environment_foreground_current,
            foreground::environment_busy_query,
            petWindow::pet_window_show,
            petWindow::pet_window_hide,
            petWindow::pet_window_set_click_through,
            petWindow::pet_window_reset_position,
            petWindow::pet_window_broadcast,
            petWindow::pet_window_request_snapshot,
            petWindow::pet_window_focus_main,
            petWindow::pet_intent_submit,
            desktop_pet_http::desktop_pet_http_request,
            desktop_pet_process::desktop_pet_process_validate,
            desktop_pet_process::desktop_pet_process_spawn,
            desktop_pet_process::desktop_pet_process_alive,
            desktop_pet_process::desktop_pet_process_exit_status,
            desktop_pet_process::desktop_pet_process_stop,
            screen::environment_screen_supported,
            screen::environment_screen_enable,
            screen::environment_capture_region,
            screen::environment_capture_window,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::remote_respond,
            remote::outbound_publish,
            remote::outbound_heartbeat,
            remote::outbound_offline,
            remote::outbound_revoke,
            remote::outbound_sessions,
            secret_store::secret_available,
            secret_store::secret_set,
            secret_store::secret_get,
            secret_store::secret_delete,
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "显示愛花", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "完全退出 Aika", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let mut tray = TrayIconBuilder::with_id("aika-tray")
                .tooltip("愛花 Aika")
                .menu(&menu)
                // Windows 隐藏图标区的右键菜单在部分壳层/触控板组合下不会稳定弹出。
                // 同时允许左键弹出，确保用户始终有可发现的退出入口。
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗只收进托盘：主动消息要靠常驻进程，直接退出会让 M2 失效。
            // 真正的退出走托盘菜单里的「退出」。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
