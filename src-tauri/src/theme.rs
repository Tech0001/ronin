use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePalette {
    pub source: String,
    pub mode: String,
    pub background: String,
    pub dark_bg: String,
    pub surface: String,
    pub elevated: String,
    pub border: String,
    pub foreground: String,
    pub soft_fg: String,
    pub muted: String,
    pub bright_fg: String,
    pub accent: String,
    pub cursor: String,
    pub selection_background: String,
    pub selection_foreground: String,
    pub ansi: Vec<String>,
}

impl ThemePalette {
    pub fn fallback() -> Self {
        Self {
            source: "built-in".into(),
            mode: "dark".into(),
            background: "#0d1015".into(),
            dark_bg: "#090b0f".into(),
            surface: "#141821".into(),
            elevated: "#1b212d".into(),
            border: "#2a3242".into(),
            foreground: "#e4e8f0".into(),
            soft_fg: "#c3cad8".into(),
            muted: "#7e889b".into(),
            bright_fg: "#ffffff".into(),
            accent: "#f23888".into(),
            cursor: "#f23888".into(),
            selection_background: "#f23888".into(),
            selection_foreground: "#0d1015".into(),
            ansi: vec![
                "#0d1015".into(),
                "#f23888".into(),
                "#5aa15d".into(),
                "#d7be96".into(),
                "#67dd82".into(),
                "#f0b7ca".into(),
                "#6f9485".into(),
                "#e4e8f0".into(),
                "#678270".into(),
                "#ff6aa7".into(),
                "#86bf86".into(),
                "#e6d3b4".into(),
                "#8bf0a1".into(),
                "#ffd0dc".into(),
                "#8bb0a4".into(),
                "#ffffff".into(),
            ],
        }
    }
}

pub fn omarchy_colors_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".local/state/omarchy/current/theme/colors.toml"),
        home.join(".config/omarchy/current/theme/colors.toml"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn parse_simple_toml(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        let val = v.trim();
        let cleaned = if let Some(rest) = val.strip_prefix('"') {
            rest.split('"').next().unwrap_or("")
        } else if let Some(rest) = val.strip_prefix('\'') {
            rest.split('\'').next().unwrap_or("")
        } else {
            val.split('#').next().unwrap_or("").trim()
        };
        if !key.is_empty() && !cleaned.is_empty() {
            map.insert(key.to_string(), cleaned.to_string());
        }
    }
    map
}

fn pick(map: &HashMap<String, String>, keys: &[&str], fallback: &str) -> String {
    for key in keys {
        if let Some(val) = map.get(*key) {
            if !val.trim().is_empty() {
                return val.trim().to_string();
            }
        }
    }
    fallback.to_string()
}

pub fn load_theme() -> ThemePalette {
    let fallback = ThemePalette::fallback();
    let Some(path) = omarchy_colors_path() else {
        return fallback;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return fallback;
    };
    let map = parse_simple_toml(&text);
    if map.is_empty() {
        return fallback;
    }

    let background = pick(&map, &["background", "bg"], &fallback.background);
    let dark_bg = pick(&map, &["dark_bg", "darker_bg", "background"], &background);
    let surface = pick(&map, &["lighter_bg", "background"], &fallback.surface);
    let foreground = pick(&map, &["foreground", "fg"], &fallback.foreground);
    let soft_fg = pick(&map, &["soft_fg", "light_fg", "foreground"], &foreground);
    let muted = pick(&map, &["muted", "color8", "dark_fg"], &fallback.muted);
    let bright_fg = pick(&map, &["bright_fg", "color15", "foreground"], &foreground);
    let accent = pick(&map, &["accent", "active_border_color", "color1"], &fallback.accent);
    let cursor = pick(&map, &["cursor", "accent", "foreground"], &accent);
    let selection_background = pick(
        &map,
        &["selection_background", "selection", "accent"],
        &accent,
    );
    let selection_foreground = pick(
        &map,
        &["selection_foreground", "background", "bg"],
        &background,
    );
    let border = pick(&map, &["dark_fg", "muted", "color8"], &fallback.border);
    let mode = pick(&map, &["mode"], "dark");

    let mut ansi = Vec::with_capacity(16);
    for i in 0..16 {
        let key = format!("color{i}");
        let default_color = fallback.ansi.get(i).map(String::as_str).unwrap_or("#ffffff");
        ansi.push(pick(&map, &[&key], default_color));
    }

    ThemePalette {
        source: path.display().to_string(),
        mode,
        background,
        dark_bg,
        surface: surface.clone(),
        elevated: surface,
        border,
        foreground,
        soft_fg,
        muted,
        bright_fg,
        accent,
        cursor,
        selection_background,
        selection_foreground,
        ansi,
    }
}

pub fn watch_omarchy_theme(app: AppHandle) -> Option<RecommendedWatcher> {
    let home = dirs::home_dir()?;
    let watch_dirs: Vec<PathBuf> = [
        home.join(".local/state/omarchy/current/theme"),
        home.join(".local/state/omarchy/current"),
        home.join(".config/omarchy/current/theme"),
        home.join(".config/omarchy/current"),
    ]
    .into_iter()
    .filter(|p| p.exists())
    .collect();

    if watch_dirs.is_empty() {
        return None;
    }

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let palette = load_theme();
            let _ = app.emit("theme:changed", &palette);
        }
    })
    .ok()?;

    for dir in watch_dirs {
        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
    }
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_omarchy_colors_toml() {
        let sample = r##"
# comment
accent = "#f23888"
background = "#0b0d11"
foreground = "#f0b7ca"
selection_background = "#f23888"
selection_foreground = "#0b0d11"
mode = "dark"
"##;
        let parsed = parse_simple_toml(sample);
        assert_eq!(parsed.get("accent").map(String::as_str), Some("#f23888"));
        assert_eq!(parsed.get("mode").map(String::as_str), Some("dark"));
    }
}
