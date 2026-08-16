//! Embedded terminal dock — spawns interactive shells in real PTYs (one per
//! dock tab, Chrome-tab style). Output is streamed to the frontend via
//! `terminal-output` events; input arrives through `terminal_write`.
//!
//! Uses `portable-pty` (same PTY engine as VS Code's terminal) so each shell
//! behaves like a real terminal: prompt, echo, line editing, job control and
//! full-screen apps (vim, htop).

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::task::spawn_blocking;

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
    /// Start a new interactive shell in `cwd` as an additional dock tab.
    /// Returns the terminal session id.
    pub async fn terminal_start(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
    ) -> Result<String, String> {
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
        // A large buffer keeps the IPC event rate low for fast producers
        // (e.g. `cat` of a big file) while keeping per-event latency small.
        spawn_blocking(move || {
            let mut buf = vec![0u8; 65536];
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

        self.terminals.lock().await.push(TerminalSession {
            id: id.clone(),
            master: pair.master,
            child,
            writer: Arc::new(Mutex::new(writer)),
        });
        Ok(id)
    }

    /// Write raw bytes to a terminal's stdin (its PTY master).
    pub async fn terminal_write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let list = self.terminals.lock().await;
            let session = list
                .iter()
                .find(|s| s.id == session_id)
                .ok_or("terminal not found")?;
            session.writer.clone()
        };
        let bytes = data.as_bytes().to_vec();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            spawn_blocking(move || {
                let mut w = writer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                w.write_all(&bytes)
            }),
        )
        .await
        .map_err(|_| "terminal write timed out".to_string())?
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("failed to write to terminal: {e}"))
    }

    /// Resize a terminal's PTY to match its frontend xterm viewport.
    pub async fn terminal_resize(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let list = self.terminals.lock().await;
        let session = list
            .iter()
            .find(|s| s.id == session_id)
            .ok_or("terminal not found")?;
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

    /// Kill one terminal (closing its dock tab).
    pub async fn terminal_stop(&self, session_id: &str) {
        let mut list = self.terminals.lock().await;
        if let Some(pos) = list.iter().position(|s| s.id == session_id) {
            let mut session = list.remove(pos);
            let _ = session.child.kill();
        }
    }

    /// Kill every terminal (dock teardown).
    pub async fn terminal_stop_all(&self) {
        let mut list = self.terminals.lock().await;
        for mut session in list.drain(..) {
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
