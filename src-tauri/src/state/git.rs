//! Git and filesystem operations — replaces the original
//! `app-store-files.ts` and `app-store-diff.ts` electron modules.
//!
//! `list_workspace_files` — `git ls-files --cached --others --exclude-standard`
//! `read_workspace_file`   — `fs::read` with binary detection
//! `get_changed_files`     — `git status --porcelain`
//! `get_file_diff`         — `git diff` / `git diff --cached` / `git diff --no-index`
//! `stage_file`            — `git add`

use std::path::Path;
use std::process::Command as PCommand;

use serde_json::json;

/// Max bytes to read for a file preview.
const MAX_PREVIEW_BYTES: u64 = 200 * 1024;

/// Run `git ls-files --cached --others --exclude-standard` in the given dir.
pub fn list_workspace_files(workspace_path: &str) -> Result<Vec<String>, String> {
    let output = PCommand::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("git ls-files failed: {e}"))?;

    if !output.status.success() {
        return Ok(vec![]); // non-git dir → empty, matches original
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    files.sort();
    Ok(files)
}

/// Read a file from disk, returning a preview with binary detection.
pub fn read_workspace_file(workspace_path: &str, file_path: &str) -> Result<serde_json::Value, String> {
    let full_path = Path::new(workspace_path).join(file_path);

    let metadata = match std::fs::metadata(&full_path) {
        Ok(m) => m,
        Err(e) => return Err(format!("Cannot read {file_path}: {e}")),
    };

    if !metadata.is_file() {
        return Ok(json!({
            "path": file_path,
            "content": "",
            "truncated": false,
            "binary": true,
            "sizeBytes": metadata.len(),
        }));
    }

    let read_len = std::cmp::min(metadata.len(), MAX_PREVIEW_BYTES + 1);
    let mut buf = vec![0u8; read_len as usize];
    let mut file = std::fs::File::open(&full_path).map_err(|e| format!("Cannot open {file_path}: {e}"))?;
    use std::io::Read;
    let bytes_read = file.read(&mut buf).map_err(|e| format!("Read error {file_path}: {e}"))?;
    buf.truncate(bytes_read);

    let preview_len = std::cmp::min(bytes_read, MAX_PREVIEW_BYTES as usize);
    let preview = &buf[..preview_len];
    let is_binary = preview.contains(&0u8);

    let content = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(preview).to_string()
    };

    Ok(json!({
        "path": file_path,
        "content": content,
        "truncated": bytes_read > MAX_PREVIEW_BYTES as usize || metadata.len() > MAX_PREVIEW_BYTES,
        "binary": is_binary,
        "sizeBytes": metadata.len(),
    }))
}

/// Run `git status --porcelain` and parse the output.
pub fn get_changed_files(workspace_path: &str) -> Result<Vec<serde_json::Value>, String> {
    let output = PCommand::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("git status failed: {e}"))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let xy: Vec<char> = line.chars().take(2).collect();
            let (x, y) = (xy.first().copied().unwrap_or(' '), xy.get(1).copied().unwrap_or(' '));
            let mut file_path = line[3..].trim().to_string();

            // Renames show as "old -> new"
            if let Some(arrow) = file_path.find(" -> ") {
                file_path = file_path[arrow + 4..].to_string();
            }

            let status = match (x, y) {
                ('?', '?') => "untracked",
                ('A', _) | (_, 'A') => "added",
                ('D', _) | (_, 'D') => "deleted",
                _ => "modified",
            };

            let staged = x != '?' && x != ' ' && y == ' ';

            json!({
                "path": file_path,
                "status": status,
                "staged": staged,
            })
        })
        .collect();

    Ok(entries)
}

/// Run `git diff` for a file; fall back to `--cached` and `--no-index`.
pub fn get_file_diff(workspace_path: &str, file_path: &str) -> Result<String, String> {
    // Try working tree diff first
    let result = run_git_diff(workspace_path, &["diff", "--", file_path]);
    if let Ok(d) = &result {
        if !d.trim().is_empty() {
            return result;
        }
    }

    // Try staged diff
    let result = run_git_diff(workspace_path, &["diff", "--cached", "--", file_path]);
    if let Ok(d) = &result {
        if !d.trim().is_empty() {
            return result;
        }
    }

    // Untracked file → diff against /dev/null
    run_git_diff(workspace_path, &["diff", "--no-index", "--", "/dev/null", file_path])
}

fn run_git_diff(workspace_path: &str, args: &[&str]) -> Result<String, String> {
    let output = PCommand::new("git")
        .args(args)
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("git diff failed: {e}"))?;

    // git diff --no-index exits with 1 when files differ (expected)
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout)
}

/// Run `git add` for a file.
pub fn stage_file(workspace_path: &str, file_path: &str) -> Result<(), String> {
    let output = PCommand::new("git")
        .args(["add", "--", file_path])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }
    Ok(())
}
