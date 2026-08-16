//! Embedded terminal — spawns an interactive shell in a real PTY for the
//! active session's cwd.
//!
//! Uses `portable-pty` (same PTY engine as VS Code's terminal) so the shell
//! behaves like a real terminal: prompt, echo, line editing, job control and
//! full-screen apps (vim, htop). Output is streamed to the frontend via
//! `terminal-output` Tauri events; input arrives through `terminal_write`.
//! One terminal session at a time.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::Store;

/// A running terminal session (PTY master + child process).
pub struct TerminalSession {
    pub id: String,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    /// PTY master writer, shared so `terminal_write` can write from a
    /// spawn_blocking task without holding the store's terminal lock.
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Store {
    /// Start (or restart) an interactive shell in `cwd`. Returns the terminal
    /// session id.
    pub async fn terminal_start(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
    ) -> Result<String, String> {
        // Kill any previous terminal first.
        self.terminal_stop().await;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;
        // The slave side is no longer needed in the parent.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to open pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to open pty writer: {e}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        let sid = id.clone();
        let a = app.clone();

        // Stream PTY output → events (blocking read on a worker thread).
        tokio::task::spawn_blocking(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
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

        *self.terminal.lock().await = Some(TerminalSession {
            id: id.clone(),
            master: pair.master,
            child,
            writer: Arc::new(Mutex::new(writer)),
        });
        Ok(id)
    }

    /// Write raw bytes to the terminal's stdin (the PTY master).
    pub async fn terminal_write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let term = self.terminal.lock().await;
            let session = term.as_ref().ok_or("no terminal running")?;
            if session.id != session_id {
                return Err("terminal session id mismatch".to_string());
            }
            session.writer.clone()
        };
        let bytes = data.as_bytes().to_vec();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::task::spawn_blocking(move || {
                let mut w = writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                w.write_all(&bytes)
            }),
        )
        .await
        .map_err(|_| "terminal write timed out".to_string())?
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("failed to write to terminal: {e}"))
    }

    /// Resize the PTY to match the frontend xterm viewport.
    pub async fn terminal_resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let term = self.terminal.lock().await;
        let session = term.as_ref().ok_or("no terminal running")?;
        if session.id != session_id {
            return Err("terminal session id mismatch".to_string());
        }
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to resize terminal: {e}"))
    }

    /// Kill the running terminal (if any) and clear the session.
    pub async fn terminal_stop(&self) {
        let mut term = self.terminal.lock().await;
        if let Some(mut session) = term.take() {
            let _ = session.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::time::Duration;

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    /// Verify the PTY gives an interactive shell (echo + output) — the old
    /// piped-stdio implementation showed no prompt and no echo.
    #[test]
    fn pty_shell_is_interactive() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn shell");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        // Send a command and read until we see its output.
        writer
            .write_all(b"echo pty-interactive-check\n")
            .expect("write");
        writer.flush().expect("flush");

        let mut out = Vec::new();
        let mut buf = [0u8; 256];
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&out).contains("pty-interactive-check") {
            assert!(std::time::Instant::now() < deadline, "timed out; output so far: {:?}", String::from_utf8_lossy(&out));
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("pty-interactive-check"), "command output missing: {text:?}");
        let _ = child.kill();
    }
}
