//! Append-only diagnostic log.
//!
//! A bundled GUI launched from Finder has its stdout/stderr wired to
//! `/dev/null`, so `eprintln!` diagnostics (turn failures, tool start/end,
//! panics) are gone the moment they are written. This module mirrors those
//! lines into `{agent_dir}/gui.log` while still writing to stderr for
//! terminal launches.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Rotate to `gui.log.1` once the log grows past this size.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

fn log_path() -> PathBuf {
    pi_coding_agent::config::get_agent_dir().join("gui.log")
}

/// Serializes appends so concurrent tasks never interleave lines or rotate
/// mid-write. Poisoning is ignored: a panic while holding it must not disable
/// logging (the panic hook itself logs through here).
fn write_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn rotate_if_needed(path: &Path) {
    let too_big = std::fs::metadata(path)
        .map(|meta| meta.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);
    if too_big {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

fn open_log(path: &Path) -> Option<File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Append one timestamped line. Best effort: logging must never take a turn
/// down, so every IO error is swallowed.
pub fn write_line(tag: &str, message: &str) {
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let line = format!("{timestamp} [{tag}] {message}\n");
    // Keep the old behavior for launches from a terminal.
    eprint!("{line}");

    let _guard = write_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = log_path();
    rotate_if_needed(&path);
    if let Some(mut file) = open_log(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}
