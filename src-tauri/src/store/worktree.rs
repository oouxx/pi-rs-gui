//! Git worktree management — mirrors original `worktree-manager.ts` + `app-store-worktree.ts`.

use std::process::Command;
use serde_json::json;

pub fn create_worktree(workspace_path: &str, target_path: &str, branch_name: Option<&str>) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("git");
    cmd.arg("worktree").arg("add").arg(target_path);
    if let Some(branch) = branch_name {
        cmd.arg(branch);
    }
    cmd.current_dir(workspace_path);
    let output = cmd.output().map_err(|e| format!("git worktree add failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add: {stderr}"));
    }
    Ok(json!({"path": target_path, "success": true}))
}

pub fn remove_worktree(workspace_path: &str, target_path: &str) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .args(["worktree", "remove", target_path])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("git worktree remove failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove: {stderr}"));
    }
    Ok(json!({"path": target_path, "success": true}))
}

pub fn list_worktrees(workspace_path: &str) -> Result<Vec<serde_json::Value>, String> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(workspace_path)
        .output()
        .map_err(|e| format!("git worktree list failed: {e}"))?;
    if !output.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut current = serde_json::Map::new();
    for line in text.lines() {
        if line.is_empty() {
            if !current.is_empty() {
                entries.push(serde_json::Value::Object(std::mem::take(&mut current)));
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            current.insert("path".into(), json!(path));
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            current.insert("head".into(), json!(head));
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            current.insert("branch".into(), json!(branch));
        } else if line == "bare" {
            current.insert("bare".into(), json!(true));
        } else if line == "detached" {
            current.insert("detached".into(), json!(true));
        }
    }
    if !current.is_empty() {
        entries.push(serde_json::Value::Object(current));
    }
    Ok(entries)
}
