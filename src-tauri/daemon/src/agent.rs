use std::fs;
use std::path::{Path, PathBuf};

fn basename_lower(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or("");
    let lower = base.to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

fn known_agent(name: &str) -> Option<&'static str> {
    match name {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
        "pi" => Some("Pi"),
        "gemini" => Some("Gemini"),
        "aider" => Some("Aider"),
        "opencode" => Some("OpenCode"),
        "goose" => Some("Goose"),
        "cursor-agent" => Some("Cursor"),
        _ => None,
    }
}

pub fn agent_from_argv(argv: &[String]) -> Option<String> {
    let first = argv.first().map(|s| s.as_str()).unwrap_or("");
    let executable = basename_lower(first);
    if let Some(agent) = known_agent(&executable) {
        return Some(agent.to_string());
    }
    if !matches!(
        executable.as_str(),
        "node" | "nodejs" | "bun" | "python" | "python3"
    ) {
        return None;
    }
    let script = argv
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(|s| s.as_str())
        .unwrap_or("");
    if script.contains("/@anthropic-ai/claude-code/") {
        return Some("Claude".to_string());
    }
    if script.contains("/@openai/codex/") {
        return Some("Codex".to_string());
    }
    if script.contains("/@google/gemini-cli/") {
        return Some("Gemini".to_string());
    }
    let base = basename_lower(script);
    let stem = base
        .strip_suffix(".js")
        .or_else(|| base.strip_suffix(".mjs"))
        .or_else(|| base.strip_suffix(".cjs"))
        .or_else(|| base.strip_suffix(".py"))
        .unwrap_or(&base);
    known_agent(stem).map(str::to_string)
}

/// Inspect only the terminal's foreground process group on Linux (/proc).
pub fn foreground_agent(shell_pid: u32) -> Option<String> {
    if shell_pid == 0 {
        return None;
    }
    let stat_text = fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?;
    let rparen = stat_text.rfind(')')?;
    let after = stat_text.get(rparen + 2..)?;
    let fields: Vec<&str> = after.split_whitespace().collect();
    // In /proc/<pid>/stat after "(comm) ", field[0]=state, [1]=ppid, [2]=pgrp, [3]=session, [4]=tty_nr, [5]=tpgid
    let tpgid: u32 = fields.get(5)?.parse().ok()?;
    if tpgid == 0 || tpgid == shell_pid {
        return None;
    }
    let cmdline_bytes = fs::read(format!("/proc/{tpgid}/cmdline")).ok()?;
    let argv: Vec<String> = cmdline_bytes
        .split(|&b| b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    agent_from_argv(&argv)
}

pub fn pi_copies_selection_on_select(cwd: Option<&str>) -> bool {
    let agent_dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".pi").join("agent")));

    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(dir) = agent_dir {
        files.push(dir.join("settings.json"));
    }
    if let Some(dir) = cwd {
        files.push(Path::new(dir).join(".pi").join("settings.json"));
    }

    let mut enabled = true; // Pi's default in fullscreen mode.
    for file in files {
        if let Ok(text) = fs::read_to_string(&file) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(flag) = val.get("fullscreenCopyOnSelect").and_then(|v| v.as_bool()) {
                    enabled = flag;
                }
            }
        }
    }
    enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_direct_and_wrapped_agents() {
        assert_eq!(
            agent_from_argv(&["/usr/local/bin/codex".into(), "resume".into()]).as_deref(),
            Some("Codex")
        );
        assert_eq!(
            agent_from_argv(&[
                "node".into(),
                "/home/pc/.local/share/mise/installs/pi/latest/pi".into()
            ])
            .as_deref(),
            Some("Pi")
        );
        assert_eq!(
            agent_from_argv(&[
                "node".into(),
                "--no-warnings".into(),
                "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js".into()
            ])
            .as_deref(),
            Some("Claude")
        );
        assert_eq!(agent_from_argv(&["bash".into(), "-il".into()]), None);
    }
}
