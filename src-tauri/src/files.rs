use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchLine {
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    pub path: String,
    pub rel_path: String,
    pub root: String,
    pub matches: Vec<SearchMatchLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub files: Vec<SearchFileResult>,
    pub total_matches: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickFileItem {
    pub name: String,
    pub path: String,
    pub rel_path: String,
    pub root: String,
    pub root_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewResult {
    pub path: String,
    pub kind: String, // "text" | "html" | "markdown" | "image" | "binary" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
    #[serde(default)]
    pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneGitInfo {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_cwd: Option<String>,
}

/// Read the active git branch by reading `.git/HEAD` directly (handles worktrees and submodules;
/// zero `git` subprocess overhead).
pub fn read_git_branch(path: &str) -> Option<(String, String)> {
    let mut dir = PathBuf::from(path);
    if dir.is_file() {
        dir = dir.parent()?.to_path_buf();
    }
    loop {
        let dot_git = dir.join(".git");
        if dot_git.exists() {
            let git_dir = if dot_git.is_dir() {
                dot_git
            } else {
                let text = fs::read_to_string(&dot_git).ok()?;
                let raw = text.trim().strip_prefix("gitdir:")?.trim();
                let candidate = PathBuf::from(raw);
                if candidate.is_absolute() {
                    candidate
                } else {
                    dir.join(candidate)
                }
            };
            let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
            let trimmed = head.trim();
            let branch = if let Some(rest) = trimmed.strip_prefix("ref: refs/heads/") {
                rest.to_string()
            } else if let Some(rest) = trimmed.strip_prefix("ref: ") {
                rest.rsplit('/').next().unwrap_or(rest).to_string()
            } else if trimmed.len() >= 7 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                trimmed[..7].to_string()
            } else {
                return None;
            };
            let repo_name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| dir.to_string_lossy().into_owned());
            return Some((branch, repo_name));
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Read the live working directory of a shell (or its foreground process group) from `/proc`.
#[cfg(target_os = "linux")]
pub fn live_process_cwd(shell_pid: u32) -> Option<String> {
    if shell_pid == 0 {
        return None;
    }
    if let Ok(stat_text) = fs::read_to_string(format!("/proc/{shell_pid}/stat")) {
        if let Some(rparen) = stat_text.rfind(')') {
            if let Some(after) = stat_text.get(rparen + 2..) {
                let fields: Vec<&str> = after.split_whitespace().collect();
                if let Some(tpgid) = fields.get(5).and_then(|f| f.parse::<u32>().ok()) {
                    if tpgid > 0 && tpgid != shell_pid {
                        if let Ok(link) = fs::read_link(format!("/proc/{tpgid}/cwd")) {
                            return Some(link.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    fs::read_link(format!("/proc/{shell_pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
pub fn live_process_cwd(_shell_pid: u32) -> Option<String> {
    None
}

/// Atomically save edited text content to an existing text file.
pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err("File path must be absolute.".into());
    }
    if target.is_dir() {
        return Err("Cannot overwrite a directory.".into());
    }
    if content.len() > 2_500_000 {
        return Err("File exceeds 2.5 MB quick-edit limit.".into());
    }
    let parent = target.parent().ok_or("Invalid file path.")?;
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = parent.join(format!(".{file_name}.ronin-tmp.{}", std::process::id()));
    let existing_perms = fs::metadata(target).ok().map(|m| m.permissions());
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Failed writing file: {e}"))?;
    if let Some(perms) = existing_perms {
        let _ = fs::set_permissions(&tmp, perms);
    }
    if fs::rename(&tmp, target).is_err() {
        let res = fs::write(target, content.as_bytes())
            .map_err(|e| format!("Failed saving file: {e}"));
        let _ = fs::remove_file(&tmp);
        return res;
    }
    Ok(())
}

const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", ".next", "__pycache__"];

pub fn list_directory(path: &str, show_hidden: bool) -> Result<Vec<DirEntryItem>, String> {
    let entries = fs::read_dir(path).map_err(|e| format!("Failed reading folder: {e}"))?;
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let full = entry.path();
        let sym_meta = fs::symlink_metadata(&full).ok();
        let is_symlink = sym_meta
            .as_ref()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let meta = fs::metadata(&full).ok().or(sym_meta);
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        items.push(DirEntryItem {
            name,
            path: full.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            size,
        });
    }
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

pub fn search_workspace(
    roots: &[String],
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    include_glob: &str,
) -> Result<SearchResponse, String> {
    let query = query.trim();
    if query.is_empty() || roots.is_empty() {
        return Ok(SearchResponse {
            files: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }

    let valid_roots: Vec<String> = roots
        .iter()
        .filter(|r| Path::new(r).is_dir())
        .cloned()
        .collect();
    if valid_roots.is_empty() {
        return Ok(SearchResponse {
            files: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }

    let mut cmd = Command::new("rg");
    cmd.args([
        "--json",
        "--max-count",
        "40",
        "--max-filesize",
        "2M",
        "--max-columns",
        "320",
        "--max-columns-preview",
    ]);
    if case_sensitive {
        cmd.arg("--case-sensitive");
    } else {
        cmd.arg("--ignore-case");
    }
    if !use_regex {
        cmd.arg("--fixed-strings");
    }
    for glob in include_glob
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.arg("--glob").arg(glob);
    }
    cmd.arg("--").arg(query);
    for root in &valid_roots {
        cmd.arg(root);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Ripgrep (rg) failed to execute: {e}"))?;

    // rg exits 0 (matches), 1 (no matches), 2 (error)
    if output.status.code() == Some(2) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(stderr.trim().to_string());
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut order: Vec<String> = Vec::new();
    let mut by_file: HashMap<String, Vec<SearchMatchLine>> = HashMap::new();
    let mut total_matches = 0usize;
    let mut truncated = false;
    const MAX_MATCHES: usize = 300;

    for raw_line in stdout.lines() {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(raw_line) else {
            continue;
        };
        if val.get("type").and_then(|v| v.as_str()) != Some("match") {
            continue;
        }
        let Some(data) = val.get("data") else {
            continue;
        };
        let Some(path) = data
            .get("path")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
        else {
            continue;
        };
        let line_num = data
            .get("line_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(1) as usize;
        let line_text = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_end_matches(&['\r', '\n'][..])
            .to_string();

        let (start, end) = data
            .get("submatches")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .map(|first| {
                let s = first.get("start").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
                let e = first.get("end").and_then(|n| n.as_u64()).unwrap_or(s as u64) as usize;
                (s, e)
            })
            .unwrap_or((0, 0));

        if total_matches >= MAX_MATCHES {
            truncated = true;
            break;
        }
        total_matches += 1;

        if !by_file.contains_key(path) {
            order.push(path.to_string());
        }
        by_file
            .entry(path.to_string())
            .or_default()
            .push(SearchMatchLine {
                line: line_num,
                column: start + 1,
                text: line_text,
                start,
                end,
            });
    }

    let files = order
        .into_iter()
        .filter_map(|path| {
            let matches = by_file.remove(&path)?;
            let root = valid_roots
                .iter()
                .find(|r| path.starts_with(r.as_str()))
                .cloned()
                .unwrap_or_default();
            let rel_path = Path::new(&path)
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| path.clone());
            Some(SearchFileResult {
                path,
                rel_path,
                root,
                matches,
            })
        })
        .collect();

    Ok(SearchResponse {
        files,
        total_matches,
        truncated,
    })
}

fn fuzzy_score(needle: &str, haystack: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let h = haystack.to_lowercase();
    let n = needle.to_lowercase();
    let basename = h.rsplit('/').next().unwrap_or(&h);
    if basename == n {
        return Some(10000);
    }
    if basename.starts_with(&n) {
        return Some(8000 - basename.len() as i32);
    }
    if let Some(pos) = basename.find(&n) {
        return Some(6000 - pos as i32 * 10 - basename.len() as i32);
    }
    if let Some(pos) = h.find(&n) {
        return Some(4000 - pos as i32 - h.len() as i32);
    }
    // Subsequence match
    let mut hi = h.chars();
    let mut matched = 0i32;
    let mut skips = 0i32;
    for nc in n.chars() {
        let mut found = false;
        for hc in hi.by_ref() {
            if hc == nc {
                matched += 1;
                found = true;
                break;
            }
            skips += 1;
        }
        if !found {
            return None;
        }
    }
    Some(1000 + matched * 20 - skips * 2 - h.len() as i32)
}

pub fn quick_open_files(roots: &[String], query: &str) -> Result<Vec<QuickFileItem>, String> {
    let valid_roots: Vec<String> = roots
        .iter()
        .filter(|r| Path::new(r).is_dir())
        .cloned()
        .collect();
    if valid_roots.is_empty() {
        return Ok(Vec::new());
    }

    let mut scored: Vec<(i32, QuickFileItem)> = Vec::new();
    let query = query.trim();

    for root in &valid_roots {
        let root_name = Path::new(root)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.clone());

        let out = Command::new("rg")
            .args(["--files", "--color=never"])
            .arg(root)
            .output();

        let paths: Vec<String> = match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .take(8000)
                .map(|s| s.to_string())
                .collect(),
            Err(_) => fallback_walk(Path::new(root), 3000),
        };

        for full in paths {
            let rel = Path::new(&full)
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| full.clone());
            if let Some(score) = fuzzy_score(query, &rel) {
                let name = Path::new(&full)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| rel.clone());
                scored.push((
                    score,
                    QuickFileItem {
                        name,
                        path: full,
                        rel_path: rel,
                        root: root.clone(),
                        root_name: root_name.clone(),
                    },
                ));
            }
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.rel_path.cmp(&b.1.rel_path)));
    Ok(scored.into_iter().take(120).map(|(_, item)| item).collect())
}

fn fallback_walk(root: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if path.is_dir() {
                if !IGNORED_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else {
                out.push(path.to_string_lossy().into_owned());
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    out
}

pub fn resolve_file_target(
    raw: &str,
    cwd: Option<&str>,
) -> (PathBuf, Option<usize>, Option<usize>) {
    let mut target = raw.trim().to_string();
    let mut line: Option<usize> = None;
    let mut column: Option<usize> = None;

    // Extract #L123C45 or :123:45 suffix
    if let Some(idx) = target.rfind("#L") {
        let tail = &target[idx + 2..];
        let mut parts = tail.split('C');
        if let Some(l) = parts.next().and_then(|s| s.parse::<usize>().ok()) {
            if l > 0 {
                line = Some(l);
                column = parts.next().and_then(|s| s.parse::<usize>().ok());
                target.truncate(idx);
            }
        }
    } else {
        // Check trailing :line or :line:col
        let parts: Vec<&str> = target.rsplitn(3, ':').collect();
        if parts.len() >= 2 {
            if let Ok(last_num) = parts[0].parse::<usize>() {
                if parts.len() == 3 {
                    if let Ok(prev_num) = parts[1].parse::<usize>() {
                        if prev_num > 0 {
                            line = Some(prev_num);
                            column = (last_num > 0).then_some(last_num);
                            let keep = target.len() - parts[0].len() - parts[1].len() - 2;
                            target.truncate(keep);
                        }
                    } else if last_num > 0 {
                        line = Some(last_num);
                        let keep = target.len() - parts[0].len() - 1;
                        target.truncate(keep);
                    }
                } else if last_num > 0 {
                    line = Some(last_num);
                    let keep = target.len() - parts[0].len() - 1;
                    target.truncate(keep);
                }
            }
        }
    }

    if let Some(stripped) = target.strip_prefix("file://") {
        target = percent_decode(stripped);
    }
    if let Some(rest) = target.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            target = home.join(rest).to_string_lossy().into_owned();
        }
    }
    let path = PathBuf::from(&target);
    let resolved = if path.is_absolute() {
        path
    } else if let Some(base) = cwd {
        Path::new(base).join(target.trim_start_matches("./"))
    } else {
        path
    };
    (resolved, line, column)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

pub fn read_file_preview(
    raw_path: &str,
    cwd: Option<&str>,
    fallback_roots: &[String],
    explicit_line: Option<usize>,
    explicit_col: Option<usize>,
) -> FilePreviewResult {
    let (mut resolved, parsed_line, parsed_col) = resolve_file_target(raw_path, cwd);
    // If an agent launched from a separate agent folder prints a relative path from
    // a project repo, fall back cleanly to the linked project folder and loaded roots.
    if !resolved.exists() {
        let (bare, _, _) = resolve_file_target(raw_path, None);
        if !bare.is_absolute() {
            let trimmed = bare.to_string_lossy();
            let rel = trimmed.trim_start_matches("./");
            for root in fallback_roots {
                let candidate = Path::new(root).join(rel);
                if candidate.exists() {
                    resolved = candidate;
                    break;
                }
            }
        }
    }
    let line = explicit_line.or(parsed_line);
    let column = explicit_col.or(parsed_col);
    let display_path = resolved.to_string_lossy().into_owned();
    let ext = resolved
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase());

    let meta = match fs::metadata(&resolved) {
        Ok(m) => m,
        Err(e) => {
            return FilePreviewResult {
                path: display_path,
                kind: "error".into(),
                ext,
                line,
                column,
                content: None,
                image: None,
                start_line: None,
                total_lines: None,
                editable: false,
                note: None,
                error: Some(format!("Cannot open file: {e}")),
            }
        }
    };

    if meta.is_dir() {
        return FilePreviewResult {
            path: display_path,
            kind: "error".into(),
            ext,
            line,
            column,
            content: None,
            image: None,
            start_line: None,
            total_lines: None,
            editable: false,
            note: None,
            error: Some("This link points to a folder.".into()),
        };
    }

    if let Some(mime) = ext.as_deref().and_then(image_mime) {
        const IMAGE_LIMIT: u64 = 12_000_000;
        if meta.len() > IMAGE_LIMIT {
            return FilePreviewResult {
                path: display_path,
                kind: "binary".into(),
                ext,
                line: None,
                column: None,
                content: None,
                image: None,
                start_line: None,
                total_lines: None,
                editable: false,
                note: Some("This image is larger than 12 MB. Open it externally to inspect it.".into()),
                error: None,
            };
        }
        return match fs::read(&resolved) {
            Ok(bytes) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                FilePreviewResult {
                    path: display_path,
                    kind: "image".into(),
                    ext,
                    line: None,
                    column: None,
                    content: None,
                    image: Some(format!("data:{mime};base64,{encoded}")),
                    start_line: None,
                    total_lines: None,
                    editable: false,
                    note: None,
                    error: None,
                }
            }
            Err(e) => FilePreviewResult {
                path: display_path,
                kind: "error".into(),
                ext,
                line: None,
                column: None,
                content: None,
                image: None,
                start_line: None,
                total_lines: None,
                editable: false,
                note: None,
                error: Some(format!("Failed reading image: {e}")),
            },
        };
    }

    const TEXT_LIMIT: u64 = 2_500_000;
    if meta.len() > TEXT_LIMIT {
        return FilePreviewResult {
            path: display_path,
            kind: "binary".into(),
            ext,
            line,
            column,
            content: None,
            image: None,
            start_line: None,
            total_lines: None,
            editable: false,
            note: Some("This file is larger than 2.5 MB. Open it externally to view the full file.".into()),
            error: None,
        };
    }

    let bytes = match fs::read(&resolved) {
        Ok(b) => b,
        Err(e) => {
            return FilePreviewResult {
                path: display_path,
                kind: "error".into(),
                ext,
                line,
                column,
                content: None,
                image: None,
                start_line: None,
                total_lines: None,
                editable: false,
                note: None,
                error: Some(format!("Failed reading file: {e}")),
            }
        }
    };

    if bytes.iter().take(8192).any(|&b| b == 0) {
        return FilePreviewResult {
            path: display_path,
            kind: "binary".into(),
            ext,
            line: None,
            column: None,
            content: None,
            image: None,
            start_line: None,
            total_lines: None,
            editable: false,
            note: Some("Binary file — preview unavailable. Use Open externally to inspect it.".into()),
            error: None,
        };
    }

    let full_text = String::from_utf8_lossy(&bytes);
    let kind = match ext.as_deref() {
        Some("html" | "htm") => "html",
        Some("md" | "markdown") => "markdown",
        _ => "text",
    };

    let all_lines: Vec<&str> = full_text.lines().collect();
    let total_lines = all_lines.len().max(1);
    let clamped_line = line.map(|l| l.min(total_lines).max(1));

    let (start_idx, end_idx, truncated) = if full_text.len() <= 300_000 && all_lines.len() <= 2500 {
        (0, all_lines.len(), false)
    } else {
        let start = clamped_line.map(|l| l.saturating_sub(120)).unwrap_or(0);
        let end = (start + 1500).min(all_lines.len());
        (start, end, start > 0 || end < all_lines.len())
    };

    let mut excerpt = if !truncated {
        full_text.into_owned()
    } else if all_lines.is_empty() {
        String::new()
    } else {
        all_lines[start_idx..end_idx].join("\n")
    };
    let mut char_truncated = false;
    if excerpt.len() > 300_000 {
        let mut cutoff = 300_000;
        while !excerpt.is_char_boundary(cutoff) {
            cutoff -= 1;
        }
        excerpt.truncate(cutoff);
        char_truncated = true;
    }

    let is_truncated = truncated || char_truncated;
    let note = if is_truncated {
        Some(format!(
            "Showing lines {}–{} of {}. Open externally for the full file.",
            start_idx + 1,
            end_idx,
            total_lines
        ))
    } else {
        None
    };

    FilePreviewResult {
        path: display_path,
        kind: kind.into(),
        ext,
        line: clamped_line,
        column,
        content: Some(excerpt),
        image: None,
        start_line: Some(start_idx + 1),
        total_lines: Some(total_lines),
        editable: !is_truncated,
        note,
        error: None,
    }
}

pub fn open_external(target: &str, cwd: Option<&str>) -> Result<(), String> {
    let trimmed = target.trim();
    let arg = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        let (resolved, _, _) = resolve_file_target(trimmed, cwd);
        resolved.to_string_lossy().into_owned()
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&arg);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &arg]);
        c
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&arg);
        c
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to open externally: {e}"))?;
    Ok(())
}

pub fn clipboard_read() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("pbpaste").output() {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
        }
        return Ok(String::new());
    }
    #[cfg(windows)]
    {
        if let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Clipboard -Raw"])
            .output()
        {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
        }
        return Ok(String::new());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        if let Ok(output) = Command::new("wl-paste")
            .args(["--no-newline"])
            .output()
        {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
        }
        if let Ok(output) = Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
        {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
        }
        Ok(String::new())
    }
}

pub fn clipboard_write(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(mut child) = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return Ok(());
        }
        return Err("Failed running pbcopy.".into());
    }
    #[cfg(windows)]
    {
        if let Ok(mut child) = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "[Console]::In.ReadToEnd() | Set-Clipboard",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return Ok(());
        }
        return Err("Failed writing to Windows clipboard.".into());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        if let Ok(mut child) = Command::new("wl-copy")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return Ok(());
        }
        if let Ok(mut child) = Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return Ok(());
        }
        Err("No clipboard utility found (wl-copy or xclip).".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths_with_lines_and_columns() {
        let (p, l, c) = resolve_file_target("src/main.rs:42:9", Some("/repo"));
        assert_eq!(p, PathBuf::from("/repo/src/main.rs"));
        assert_eq!(l, Some(42));
        assert_eq!(c, Some(9));

        let (p2, l2, c2) = resolve_file_target("docs/RUNBOOK.md#L18C3", Some("/repo"));
        assert_eq!(p2, PathBuf::from("/repo/docs/RUNBOOK.md"));
        assert_eq!(l2, Some(18));
        assert_eq!(c2, Some(3));
    }

    #[test]
    fn fuzzy_ranks_basename_matches_highest() {
        let exact = fuzzy_score("main.rs", "src-tauri/src/main.rs").unwrap();
        let sub = fuzzy_score("main.rs", "src/components/MainPanel.tsx").unwrap_or(-9999);
        assert!(exact > sub);
    }

    #[test]
    fn reads_git_branch_from_dir_and_worktree_file() {
        let base = std::env::temp_dir().join(format!("ronin-git-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("my-repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feat/clean\n").unwrap();
        let nested = repo.join("src/nested");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            read_git_branch(&nested.to_string_lossy()),
            Some(("feat/clean".into(), "my-repo".into()))
        );

        let wt = base.join("my-wt");
        let real_git = base.join("wt-gitdir");
        fs::create_dir_all(&wt).unwrap();
        fs::create_dir_all(&real_git).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", real_git.display())).unwrap();
        fs::write(real_git.join("HEAD"), "abcdef1234567890\n").unwrap();
        assert_eq!(
            read_git_branch(&wt.to_string_lossy()),
            Some(("abcdef1".into(), "my-wt".into()))
        );
        let _ = fs::remove_dir_all(&base);
    }
}
