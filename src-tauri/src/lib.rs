pub mod daemon_client;
pub mod files;
pub mod state;
pub mod theme;

use crate::daemon_client::DaemonClient;
use crate::files::{
    clipboard_read, clipboard_write, list_directory, open_external, quick_open_files,
    read_file_preview, search_workspace, DirEntryItem, FilePreviewResult, QuickFileItem,
    SearchResponse,
};
use crate::state::{load_state, save_state, WindowGeometry, WorkspaceState};
use crate::theme::{load_theme, watch_omarchy_theme, ThemePalette};
use notify::RecommendedWatcher;
use ronin_daemon::agent::{foreground_agent, pi_copies_selection_on_select};
use ronin_daemon::protocol::{RemoteTerminal, StartTerminal, TerminalSnapshot};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

struct AppState {
    daemon: DaemonClient,
    workspace: Mutex<WorkspaceState>,
    _theme_watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    version: String,
    home_dir: String,
    default_shell: String,
    workspace: WorkspaceState,
    theme: ThemePalette,
    connected: bool,
    daemon_pid: Option<u32>,
    runtime_dir: String,
    terminals: Vec<RemoteTerminal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    connected: bool,
    pid: Option<u32>,
    runtime_dir: String,
}

#[tauri::command]
async fn app_bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let workspace = state.workspace.lock().unwrap().clone();
    let theme = load_theme();
    let terminals = match state.daemon.list().await {
        Ok(list) => list,
        Err(_) => Vec::new(),
    };
    let home_dir = dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".into());
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());

    Ok(BootstrapPayload {
        version: env!("CARGO_PKG_VERSION").to_string(),
        home_dir,
        default_shell,
        workspace,
        theme,
        connected: state.daemon.is_connected(),
        daemon_pid: state.daemon.daemon_pid(),
        runtime_dir: state.daemon.runtime_dir_string(),
        terminals,
    })
}

#[tauri::command]
fn workspace_save(mut workspace: WorkspaceState, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.workspace.lock().unwrap();
    if workspace.window.is_none() {
        workspace.window = guard.window.clone();
    }
    save_state(&workspace)?;
    *guard = workspace;
    Ok(())
}

#[tauri::command]
fn theme_get() -> ThemePalette {
    load_theme()
}

#[tauri::command]
async fn daemon_status(state: State<'_, AppState>) -> Result<DaemonStatus, String> {
    Ok(DaemonStatus {
        connected: state.daemon.is_connected(),
        pid: state.daemon.daemon_pid(),
        runtime_dir: state.daemon.runtime_dir_string(),
    })
}

#[tauri::command]
async fn daemon_list(state: State<'_, AppState>) -> Result<Vec<RemoteTerminal>, String> {
    state.daemon.list().await
}

#[tauri::command]
async fn terminal_start(
    id: u32,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    state: State<'_, AppState>,
) -> Result<RemoteTerminal, String> {
    let shell_setting = state.workspace.lock().unwrap().settings.shell.trim().to_string();
    let shell = if !shell_setting.is_empty() {
        shell_setting
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    };
    let env: HashMap<String, String> = std::env::vars().collect();
    state
        .daemon
        .start(StartTerminal {
            id,
            cwd,
            shell,
            env,
            cols,
            rows,
        })
        .await
}

#[tauri::command]
async fn terminal_attach(id: u32, state: State<'_, AppState>) -> Result<TerminalSnapshot, String> {
    state.daemon.attach(id).await
}

#[tauri::command]
async fn terminal_detach(id: u32, state: State<'_, AppState>) -> Result<(), String> {
    state.daemon.detach(id).await
}

#[tauri::command]
async fn terminal_write(id: u32, data: String, state: State<'_, AppState>) -> Result<(), String> {
    state.daemon.write(id, data).await
}

#[tauri::command]
async fn terminal_resize(
    id: u32,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.daemon.resize(id, cols, rows).await
}

#[tauri::command]
async fn terminal_kill(id: u32, state: State<'_, AppState>) -> Result<(), String> {
    state.daemon.kill(id).await
}

#[tauri::command]
async fn terminal_refresh_display(id: u32, state: State<'_, AppState>) -> Result<(), String> {
    let terminals = state.daemon.list().await?;
    if let Some(t) = terminals.into_iter().find(|t| t.id == id && t.running) {
        let nudged = if t.cols < 1000 { t.cols + 1 } else { t.cols - 1 };
        let _ = state.daemon.resize(id, nudged, t.rows).await;
        tokio::time::sleep(Duration::from_millis(140)).await;
        let _ = state.daemon.resize(id, t.cols, t.rows).await;
    }
    Ok(())
}

/// Pi-aware terminal copy:
/// 1) Non-empty xterm selection -> write directly to system clipboard.
/// 2) Empty selection + live foreground process is Pi + Pi's fullscreenCopyOnSelect is false -> send Ctrl+X (`\x18`).
/// 3) Otherwise do nothing so existing clipboard contents stay intact.
#[tauri::command]
async fn terminal_copy(
    id: u32,
    selection: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !selection.is_empty() {
        clipboard_write(&selection)?;
        return Ok("clipboard".into());
    }
    let shell_pid = state.daemon.known_pid(id);
    if let Some(pid) = shell_pid {
        let is_pi = tokio::task::spawn_blocking(move || foreground_agent(pid))
            .await
            .ok()
            .flatten()
            .as_deref()
            == Some("Pi");
        if is_pi {
            let cwd_clone = cwd.clone();
            let auto_copy = tokio::task::spawn_blocking(move || {
                pi_copies_selection_on_select(cwd_clone.as_deref())
            })
            .await
            .unwrap_or(true);
            if !auto_copy {
                state.daemon.write(id, "\x18".into()).await?;
                return Ok("pi".into());
            }
        }
    }
    Ok("none".into())
}

#[tauri::command]
async fn daemon_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    state.daemon.stop_all().await
}

#[tauri::command]
async fn daemon_restart(state: State<'_, AppState>) -> Result<DaemonStatus, String> {
    state.daemon.restart().await?;
    Ok(DaemonStatus {
        connected: state.daemon.is_connected(),
        pid: state.daemon.daemon_pid(),
        runtime_dir: state.daemon.runtime_dir_string(),
    })
}

#[tauri::command]
async fn fs_list_dir(path: String, show_hidden: bool) -> Result<Vec<DirEntryItem>, String> {
    tokio::task::spawn_blocking(move || list_directory(&path, show_hidden))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn fs_search(
    roots: Vec<String>,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    include_glob: String,
) -> Result<SearchResponse, String> {
    tokio::task::spawn_blocking(move || {
        search_workspace(&roots, &query, case_sensitive, use_regex, &include_glob)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn fs_quick_open(roots: Vec<String>, query: String) -> Result<Vec<QuickFileItem>, String> {
    tokio::task::spawn_blocking(move || quick_open_files(&roots, &query))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn fs_preview_file(
    path: String,
    cwd: Option<String>,
    line: Option<usize>,
    column: Option<usize>,
) -> Result<FilePreviewResult, String> {
    tokio::task::spawn_blocking(move || read_file_preview(&path, cwd.as_deref(), line, column))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[tauri::command]
fn fs_open_external(target: String, cwd: Option<String>) -> Result<(), String> {
    open_external(&target, cwd.as_deref())
}

#[tauri::command]
fn fs_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[tauri::command]
fn sys_clipboard_read() -> Result<String, String> {
    clipboard_read()
}

#[tauri::command]
fn sys_clipboard_write(text: String) -> Result<(), String> {
    clipboard_write(&text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let daemon = DaemonClient::new(handle.clone());
            let watcher = watch_omarchy_theme(handle.clone());
            let workspace = load_state();
            let saved_window = workspace.window.clone();
            app.manage(AppState {
                daemon,
                workspace: Mutex::new(workspace),
                _theme_watcher: Mutex::new(watcher),
            });

            if let Some(main_win) = app.get_webview_window("main") {
                if let Some(geom) = saved_window {
                    if geom.maximized {
                        let _ = main_win.maximize();
                    } else if geom.width >= 760 && geom.height >= 500 {
                        let _ = main_win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                            f64::from(geom.width),
                            f64::from(geom.height),
                        )));
                    }
                }
                let win_handle = main_win.clone();
                let app_handle = handle.clone();
                main_win.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::CloseRequested { .. }
                    ) {
                        let maximized = win_handle.is_maximized().unwrap_or(false);
                        let state = app_handle.state::<AppState>();
                        let mut guard = state.workspace.lock().unwrap();
                        let next_geom = if maximized {
                            let prev = guard.window.clone().unwrap_or(WindowGeometry {
                                width: 1360,
                                height: 860,
                                maximized: true,
                            });
                            WindowGeometry {
                                width: prev.width,
                                height: prev.height,
                                maximized: true,
                            }
                        } else if let (Ok(phys), Ok(scale)) =
                            (win_handle.inner_size(), win_handle.scale_factor())
                        {
                            let log = phys.to_logical::<u32>(scale);
                            if log.width >= 760 && log.height >= 500 {
                                WindowGeometry {
                                    width: log.width,
                                    height: log.height,
                                    maximized: false,
                                }
                            } else {
                                return;
                            }
                        } else {
                            return;
                        };
                        guard.window = Some(next_geom);
                        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                            let _ = save_state(&guard);
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            workspace_save,
            theme_get,
            daemon_status,
            daemon_list,
            daemon_stop_all,
            daemon_restart,
            terminal_start,
            terminal_attach,
            terminal_detach,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_refresh_display,
            terminal_copy,
            fs_list_dir,
            fs_search,
            fs_quick_open,
            fs_preview_file,
            fs_open_external,
            fs_is_dir,
            sys_clipboard_read,
            sys_clipboard_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ronin");
}
