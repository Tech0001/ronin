use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn default_tab_id() -> String {
    "main".into()
}

fn default_tabs() -> Vec<CanvasTab> {
    vec![CanvasTab {
        id: default_tab_id(),
        name: "Main".into(),
    }]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTab {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub process_id: u32,
    pub name: String,
    pub kind: String,
    pub command: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(default = "default_tab_id")]
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default = "default_selection_style")]
    pub selection_style: String,
    #[serde(default = "default_true")]
    pub auto_start_lanes: bool,
    #[serde(default)]
    pub show_hidden_files: bool,
}

fn default_font_size() -> u16 {
    13
}

fn default_font_family() -> String {
    "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'CaskaydiaMono Nerd Font', 'Fira Code', ui-monospace, monospace".into()
}

fn default_selection_style() -> String {
    "solid".into()
}

fn default_true() -> bool {
    true
}

fn default_sidebar_tab() -> String {
    "explorer".into()
}

fn default_sidebar_width() -> u32 {
    272
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: default_font_size(),
            font_family: default_font_family(),
            shell: String::new(),
            selection_style: default_selection_style(),
            auto_start_lanes: true,
            show_hidden_files: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default = "default_tabs")]
    pub tabs: Vec<CanvasTab>,
    #[serde(default = "default_tab_id")]
    pub active_tab_id: String,
    #[serde(default)]
    pub lanes: Vec<Lane>,
    #[serde(default)]
    pub columns: u16,
    #[serde(default = "default_true")]
    pub auto_fit: bool,
    #[serde(default = "default_true")]
    pub sidebar_open: bool,
    #[serde(default = "default_sidebar_tab")]
    pub sidebar_tab: String,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tasks: Vec<TaskItem>,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowGeometry>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            folders: Vec::new(),
            tabs: default_tabs(),
            active_tab_id: default_tab_id(),
            lanes: Vec::new(),
            columns: 0,
            auto_fit: true,
            sidebar_open: true,
            sidebar_tab: default_sidebar_tab(),
            sidebar_width: default_sidebar_width(),
            notes: String::new(),
            tasks: Vec::new(),
            settings: AppSettings::default(),
            window: None,
        }
    }
}

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("ronin")
        .join("state.json")
}

pub fn load_state() -> WorkspaceState {
    let path = config_path();
    let Ok(bytes) = fs::read(&path) else {
        return WorkspaceState::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save_state(state: &WorkspaceState) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let json = serde_json::to_vec_pretty(state).map_err(|e| format!("Failed to serialize state: {e}"))?;
    fs::write(&tmp, &json).map_err(|e| format!("Failed to write temp state: {e}"))?;
    if fs::rename(&tmp, &path).is_err() {
        fs::write(&path, &json).map_err(|e| format!("Failed to save state: {e}"))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}
