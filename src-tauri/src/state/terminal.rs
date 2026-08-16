//! Embedded terminal — spawns a local shell for the active session's cwd.
//!
//! One terminal session at a time. Output is streamed to the frontend via
//! `terminal-output` Tauri events; input arrives through `terminal_write`.

use std::process::Stdio;
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

use super::Store;

/// A running terminal session (shell process + stdin pipe).
pub struct TerminalSession {
    pub id: String,
    pub child: Child,
    pub stdin: ChildStdin,
}

impl Store {
    /// Start (or restart) a shell in `cwd`. Returns the terminal session id.
    pub async fn terminal_start(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
    ) -> Result<String, String> {
        // Kill any previous terminal first.
        self.terminal_stop().await;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut child = Command::new(&shell)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn shell: {e}"))?;

        let stdin = child.stdin.take().ok_or("failed to open shell stdin")?;
        let mut stdout = child.stdout.take().ok_or("failed to open shell stdout")?;
        let mut stderr = child.stderr.take().ok_or("failed to open shell stderr")?;

        let id = uuid::Uuid::new_v4().to_string();
        let sid = id.clone();
        let a = app.clone();

        // Stream stdout → events.
        {
            let sid = sid.clone();
            let a = a.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = a.emit(
                                "terminal-output",
                                json!({ "sessionId": sid, "data": String::from_utf8_lossy(&buf[..n]) }),
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        // Stream stderr → events.
        {
            let a = a.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = a.emit(
                                "terminal-output",
                                json!({ "sessionId": sid, "data": String::from_utf8_lossy(&buf[..n]) }),
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        *self.terminal.lock().await = Some(TerminalSession { id: id.clone(), child, stdin });
        Ok(id)
    }

    /// Write raw bytes to the terminal's stdin.
    pub async fn terminal_write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut term = self.terminal.lock().await;
        let session = term.as_mut().ok_or("no terminal running")?;
        if session.id != session_id {
            return Err("terminal session id mismatch".to_string());
        }
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            session.stdin.write_all(data.as_bytes()),
        )
        .await
        .map_err(|_| "terminal write timed out".to_string())?
        .map_err(|e| format!("failed to write to terminal: {e}"))
    }

    /// Kill the running terminal (if any) and clear the session.
    pub async fn terminal_stop(&self) {
        let mut term = self.terminal.lock().await;
        if let Some(mut session) = term.take() {
            let _ = session.child.kill().await;
            let _ = session.child.wait().await;
        }
    }
}

