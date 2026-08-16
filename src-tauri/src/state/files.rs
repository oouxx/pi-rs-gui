//! Workspace file search for the composer `@` mention.
//!
//! Delegates to pi-rs's `find` tool (gitignore-aware walk, same behavior the
//! agent uses), so the GUI never reimplements file discovery.

use pi_ai::types::ContentBlock;
use serde_json::json;

const RESULT_LIMIT: usize = 50;

/// Escape glob metacharacters so user input is treated as a literal substring.
fn escape_glob(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('*', "\\*")
        .replace('?', "\\?")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

/// Search files under `cwd` whose path contains `query` (case-sensitive,
/// gitignore-aware). Returns relative paths (without `./`), sorted, capped.
pub async fn search_files(cwd: &str, query: &str) -> Result<Vec<String>, String> {
    let tool = pi_coding_agent::core::tools::find::create_find_tool(cwd, None);
    let q = query.trim();
    let pattern = if q.is_empty() {
        "**/*".to_string()
    } else {
        format!("**/*{}*", escape_glob(q))
    };
    let params = json!({ "pattern": pattern, "limit": RESULT_LIMIT });

    let result = (tool.execute)("gui-file-search".to_string(), params, None, None)
        .await
        .map_err(|e| e.to_string())?;

    let mut paths: Vec<String> = Vec::new();
    for block in &result.content {
        let ContentBlock::Text { text, .. } = block else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with("No files found")
                || line.starts_with("Error")
                || line.starts_with("Path not found")
            {
                continue;
            }
            paths.push(line.trim_start_matches("./").to_string());
        }
    }

    paths.sort();
    paths.dedup();
    paths.truncate(RESULT_LIMIT);
    Ok(paths)
}





