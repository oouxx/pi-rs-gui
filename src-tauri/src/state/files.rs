//! Workspace file completion for the composer `@` mention / Tab completion.
//!
//! Mirrors the TS original `packages/tui/src/autocomplete.ts`
//! (`CombinedAutocompleteProvider`): fd-style walk (gitignore-aware, hidden
//! files included, .git excluded), path scoping (`~/`, absolute, or relative
//! to cwd), scoring (`scoreEntry`), and directory continuation.
//!
//! The walk uses the same `ignore` crate as pi-rs's find tool; the agent's
//! own file search still lives in pi-rs — this is UI-support discovery.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const MAX_WALK_ENTRIES: usize = 5000;
const MAX_RESULTS: usize = 20;

/// Expand a leading `~` to the home directory.
fn expand_home(path: &str) -> String {
    if path == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        return format!("{home}/{rest}");
    }
    path.to_string()
}

/// Resolve (base_dir, fuzzy_query) from a raw query, mirroring
/// `resolveScopedFuzzyQuery`: the part before the last `/` scopes the search,
/// and only the last segment is fuzzy-matched.
fn resolve_scope(cwd: &str, raw_query: &str) -> (String, String) {
    let normalized = raw_query.replace('\\', "/");
    match normalized.rfind('/') {
        Some(idx) => {
            let display_base = &normalized[..=idx];
            let query = normalized[idx + 1..].to_string();
            let base = if display_base.starts_with("~/") {
                expand_home(display_base)
            } else if display_base.starts_with('/') {
                display_base.to_string()
            } else {
                Path::new(cwd).join(display_base).to_string_lossy().to_string()
            };
            (base, query)
        }
        None => (cwd.to_string(), normalized),
    }
}

/// True when the path is inside a git repo (used to match fd's
/// `--no-require-git` semantics: outside a repo, .gitignore still applies).
fn is_inside_git_repo(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return true;
        }
        current = dir.parent();
    }
    false
}

/// Score an entry like TS `scoreEntry` (higher = better).
fn score_entry(file_path: &str, query: &str, is_dir: bool) -> i32 {
    let file_name = Path::new(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let lower_file = file_name.to_lowercase();
    let lower_path = file_path.to_lowercase();
    let lower_query = query.to_lowercase();

    let mut score = 0;
    if lower_file == lower_query {
        score = 100;
    } else if lower_file.starts_with(&lower_query) {
        score = 80;
    } else if lower_file.contains(&lower_query) {
        score = 50;
    } else if lower_path.contains(&lower_query) {
        score = 30;
    }
    if is_dir && score > 0 {
        score += 10;
    }
    score
}

/// Build a display path for an entry found under `base_dir`, scoped like the
/// TS `scopedPathForDisplay` (keeps the user's `~/` or absolute/relative base).
fn scoped_display_path(display_base: &str, relative: &str) -> String {
    let normalized = relative.replace('\\', "/");
    if display_base == "/" {
        return format!("/{normalized}");
    }
    format!("{display_base}{normalized}")
}

/// fd-style walk: files + directories, hidden included, .git excluded,
/// gitignore respected. Returns paths relative to `base_dir`.
fn walk(base_dir: &str) -> Vec<(String, bool)> {
    let base = PathBuf::from(base_dir);
    let inside_git = is_inside_git_repo(&base);
    let walker = ignore::WalkBuilder::new(&base)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(inside_git)
        .filter_entry(|e| e.file_name() != ".git")
        .build();

    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in walker {
        if entries.len() >= MAX_WALK_ENTRIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir && !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&base)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        if rel.is_empty() {
            continue;
        }
        entries.push((rel, is_dir));
    }
    entries
}

/// File completion suggestions for the composer `@` mention / Tab trigger.
/// Returns `{ name, path, isDir }[]`, sorted by score (dirs boosted).
pub fn file_completions(cwd: &str, raw_query: &str) -> Vec<Value> {
    let (base_dir, query) = resolve_scope(cwd, raw_query);
    let normalized_base = base_dir.replace('\\', "/");
    let display_base = match raw_query.rfind('/') {
        Some(idx) => raw_query[..=idx].replace('\\', "/"),
        None => String::new(),
    };

    let entries = walk(&base_dir);

    // Score + filter.
    let mut scored: Vec<(i32, String, bool)> = Vec::new();
    for (rel, is_dir) in entries {
        let rel_display = rel.replace('\\', "/");
        if rel_display == ".git" || rel_display.starts_with(".git/") || rel_display.contains("/.git/") {
            continue;
        }
        let full = format!("{normalized_base}/{rel_display}");
        let score = if query.is_empty() {
            1
        } else {
            let s = score_entry(&full, &query, is_dir);
            if s <= 0 {
                continue;
            }
            s
        };
        scored.push((score, rel_display, is_dir));
    }

    scored.sort_by(|a, b| {
        b.0.cmp(&a.0).then_with(|| {
            let ad = a.2 as u8;
            let bd = b.2 as u8;
            bd.cmp(&ad).then_with(|| a.1.cmp(&b.1))
        })
    });

    scored.truncate(MAX_RESULTS);

    scored
        .into_iter()
        .map(|(_, rel, is_dir)| {
            let path = scoped_display_path(&display_base, &rel);
            json!({
                "name": rel.rsplit('/').next().unwrap_or(&rel),
                "path": path,
                "isDir": is_dir,
            })
        })
        .collect()
}

