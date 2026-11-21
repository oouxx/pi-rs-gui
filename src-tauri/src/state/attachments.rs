//! Composer attachment pipeline.
//!
//! File *contents* do not go into the prompt: every file is handed to pi-rs's
//! `read` tool by absolute path, which returns 2000 lines / 50KB per call with
//! `offset` continuation. That is what makes "any file size" work without
//! burning the context window. Only small text files are inlined, to save the
//! agent one tool round-trip.
//!
//! - images → `ContentBlock::Image` (pi-rs `process_image` sniffs the format,
//!   converts to PNG when needed and downscales to the model's inline limits),
//!   with the resize/conversion hints added to the prompt
//! - files  → `<file name="/abs/path" size="N"/>`; small UTF-8 text files are
//!   inlined as `<file name="/abs/path" size="N">…</file>`
//!
//! Pasted bytes have no path inside the webview, so they are spooled to
//! `<agent dir>/attachments/<session>/` first. Everything referenced in the
//! prompt therefore exists on disk and is readable by `read`.

use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use pi_agent_core::pi_ai_types::ContentBlock;
use pi_coding_agent::utils::image_process::{process_image, ProcessedImage};
use pi_coding_agent::utils::mime::detect_supported_image_mime_type;

/// Text files up to this size are inlined; larger ones are only referenced so
/// `read` can page through them (64KB ≈ one `read` call worth of text).
pub const INLINE_MAX_BYTES: u64 = 64 * 1024;
/// Sanity cap for images: they must be decoded to be useful, so an arbitrarily
/// large one cannot be handled lazily the way text can.
pub const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 20;

const ATTACHMENT_OPEN: &str = "<pi_gui_attachments marker=\"v1\">";
const ATTACHMENT_CLOSE: &str = "</pi_gui_attachments>";
const ENTRY_OPEN: &str = "\n  <file name=\"";
const READ_NOTE: &str = "Files listed without inline content are on disk. Read them with the \
read tool; use offset/limit to continue a long file.";

/// One image as the composer sends it: base64 payload (paste) or an absolute
/// path (file picker / native drag), where the bytes never enter the webview.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerImageInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
}

/// One non-image attachment: base64 payload (paste) or an absolute path.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerFileInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

/// A file that a prompt references — enough for the UI to render a chip
/// without re-reading the prompt text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachedFile {
    pub name: String,
    pub size: u64,
    /// Text was inlined into the prompt (small UTF-8 files).
    pub inlined: bool,
}

/// What pi-rs receives for one prompt.
#[derive(Debug)]
pub struct Prepared {
    pub images: Vec<ContentBlock>,
    pub prompt_text: String,
}

/// Validate one prompt's attachments and build the text + image blocks.
pub fn prepare(
    text: &str,
    images: &[ComposerImageInput],
    files: &[ComposerFileInput],
    session_id: &str,
) -> Result<Prepared, String> {
    if images.len().saturating_add(files.len()) > MAX_ATTACHMENTS {
        return Err(format!(
            "At most {MAX_ATTACHMENTS} attachments per message."
        ));
    }

    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut hints: Vec<(String, u64, Vec<String>)> = Vec::new();
    let mut inlined: Vec<(String, u64, String)> = Vec::new();
    let mut referenced: Vec<(String, u64)> = Vec::new();

    for (index, image) in images.iter().enumerate() {
        let name = image
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("image {}", index + 1));
        let bytes = image_bytes(image, &name)?;
        let (block, image_hints) = image_block(&name, &bytes, image.mime_type.as_deref())?;
        blocks.push(block);
        if !image_hints.is_empty() {
            hints.push((name, bytes.len() as u64, image_hints));
        }
    }

    for (index, file) in files.iter().enumerate() {
        let fallback = format!("attachment {}", index + 1);
        let name = file
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(fallback);
        let path = file_path(file, &name, session_id)?;
        let size = std::fs::metadata(&path)
            .map_err(|error| format!("Cannot read {name}: {error}"))?
            .len();
        let shown = absolute(&path);

        // The generic file channel accepts images too: a browser hands over an
        // image with no MIME type (dragged from the file manager), and the
        // model must get an image block rather than unreadable text.
        if let Ok(Some(_)) =
            pi_coding_agent::utils::mime::detect_supported_image_mime_type_from_file(&shown)
        {
            let bytes = read_image(&path, &shown, size)?;
            let (block, image_hints) = image_block(&name, &bytes, None)?;
            blocks.push(block);
            if !image_hints.is_empty() {
                hints.push((name, size, image_hints));
            }
            continue;
        }

        match inline_text(&path, size) {
            Some(content) => inlined.push((shown, size, content)),
            None => referenced.push((shown, size)),
        }
    }

    let wrapper = attachment_wrapper(&inlined, &referenced, &hints);
    let prompt_text = match (text.is_empty(), wrapper.is_empty()) {
        (true, true) => String::new(),
        (false, true) => text.to_string(),
        (true, false) => wrapper,
        (false, false) => format!("{text}\n\n{wrapper}"),
    };
    Ok(Prepared {
        images: blocks,
        prompt_text,
    })
}

fn attachment_wrapper(
    inlined: &[(String, u64, String)],
    referenced: &[(String, u64)],
    hints: &[(String, u64, Vec<String>)],
) -> String {
    if inlined.is_empty() && referenced.is_empty() && hints.is_empty() {
        return String::new();
    }
    let mut out = String::from(ATTACHMENT_OPEN);
    for (name, size, content) in inlined {
        out.push_str(&format!(
            "\n  <file name=\"{}\" size=\"{size}\">\n{content}\n  </file>",
            escape_attr(name)
        ));
    }
    for (name, size) in referenced {
        out.push_str(&format!(
            "\n  <file name=\"{}\" size=\"{size}\"/>",
            escape_attr(name)
        ));
    }
    for (name, size, notes) in hints {
        for note in notes {
            out.push_str(&format!(
                "\n  <image_hint name=\"{}\" size=\"{size}\">{note}</image_hint>",
                escape_attr(name)
            ));
        }
    }
    if !referenced.is_empty() {
        out.push_str(&format!("\n  <note>{READ_NOTE}</note>"));
    }
    out.push('\n');
    out.push_str(ATTACHMENT_CLOSE);
    out
}

// ── Payload resolution ──────────────────────────────────────

fn absolute(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn decode_base64(data: &str) -> Option<Vec<u8>> {
    let payload = match data.find(',') {
        Some(comma) if data.starts_with("data:") => &data[comma + 1..],
        _ => data,
    };
    let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD.decode(compact.trim_end_matches('='))
        })
        .ok()
}

fn image_bytes(image: &ComposerImageInput, name: &str) -> Result<Vec<u8>, String> {
    if let Some(data) = image.data.as_deref().filter(|d| !d.trim().is_empty()) {
        return decode_base64(data).ok_or_else(|| format!("Image {name} is not valid base64."));
    }
    let Some(path) = image.path.as_deref().filter(|p| !p.trim().is_empty()) else {
        return Err(format!("Image {name} has neither data nor a path."));
    };
    let path = Path::new(path);
    let size = std::fs::metadata(path)
        .map_err(|error| format!("Cannot read {name}: {error}"))?
        .len();
    read_image(path, &absolute(path), size)
}

fn read_image(path: &Path, shown: &str, size: u64) -> Result<Vec<u8>, String> {
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "{shown} is {} (images must be under {} to be decoded).",
            human_size(size),
            human_size(MAX_IMAGE_BYTES)
        ));
    }
    std::fs::read(path).map_err(|error| format!("Cannot read {shown}: {error}"))
}

/// Resolve a non-image attachment to a path on disk, spooling pasted bytes.
fn file_path(file: &ComposerFileInput, name: &str, session_id: &str) -> Result<PathBuf, String> {
    if let Some(path) = file.path.as_deref().filter(|p| !p.trim().is_empty()) {
        let path = PathBuf::from(path);
        if !path.exists() {
            return Err(format!("{name} no longer exists."));
        }
        return Ok(path);
    }
    let Some(data) = file.data.as_deref().filter(|d| !d.trim().is_empty()) else {
        return Err(format!("{name} has neither data nor a path."));
    };
    let bytes = decode_base64(data).ok_or_else(|| format!("{name} is not valid base64."))?;
    spool(&bytes, name, session_id)
}

/// Write pasted bytes to the session's attachment directory so `read` can open
/// them later.
fn spool(bytes: &[u8], name: &str, session_id: &str) -> Result<PathBuf, String> {
    let dir = attachments_dir().join(safe_component(session_id, "_session"));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
    let file_name = format!("{}-{}", uuid::Uuid::new_v4(), safe_file_name(name));
    let path = dir.join(file_name);
    std::fs::write(&path, bytes).map_err(|error| format!("Cannot save {name}: {error}"))?;
    Ok(path)
}

fn attachments_dir() -> PathBuf {
    pi_coding_agent::config::get_agent_dir().join("attachments")
}

/// Drop a session's spooled attachments (called when the session is deleted).
pub fn remove_session_dir(session_id: &str) {
    let dir = attachments_dir().join(safe_component(session_id, "_session"));
    if dir.is_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Whitelist a value used as a single path component (no separators, no `.`).
fn safe_component(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(128)
        .collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn safe_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .take(96)
        .collect();
    let trimmed = cleaned.trim_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    }
}

// ── Text inlining ───────────────────────────────────────────

/// Read a small text file for inlining, or `None` when it is too large, not
/// UTF-8, or carries control characters — those are left to `read`.
fn inline_text(path: &Path, size: u64) -> Option<String> {
    if size > INLINE_MAX_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(path)
        .and_then(|file| file.take(INLINE_MAX_BYTES).read_to_end(&mut bytes))
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    if has_dangerous_controls(&text) {
        return None;
    }
    Some(normalize_newlines(text.trim_start_matches('\u{feff}')))
}

fn normalize_newlines(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    }
}

/// Control characters (other than tab/newline) and bidi overrides: a file
/// carrying them stays on disk instead of being spliced into the prompt.
fn has_dangerous_controls(text: &str) -> bool {
    text.chars().any(|c| {
        !matches!(c, '\n' | '\r' | '\t')
            && (c.is_control()
                || matches!(
                    c,
                    '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                ))
    })
}

// ── Images ──────────────────────────────────────────────────

/// Normalize one image through pi-rs (format sniffing, PNG conversion, resize
/// to the model's inline limits) and keep its human-readable hints.
///
/// `reported` is the browser's MIME type: it never decides the format (the
/// bytes do), it only explains a failure.
fn image_block(
    name: &str,
    bytes: &[u8],
    reported: Option<&str>,
) -> Result<(ContentBlock, Vec<String>), String> {
    let mime = detect_supported_image_mime_type(bytes).unwrap_or("");
    let processed: ProcessedImage = process_image(bytes, mime, true, None).map_err(|_| {
        let hint = match reported.filter(|m| !m.is_empty()) {
            Some(mime) => format!(" (reported as {mime})"),
            None => String::new(),
        };
        format!("{name} could not be converted to PNG, JPEG, GIF or WebP{hint}.")
    })?;
    Ok((
        ContentBlock::Image {
            data: processed.data,
            mime_type: processed.mime_type,
        },
        processed.hints,
    ))
}

// ── Display helpers ─────────────────────────────────────────

/// Split this pipeline's attachment wrapper off the end of a prompt.
///
/// Returns the user-visible text and the referenced files. A prompt without
/// the wrapper (plain prompts, sessions from older versions) is unchanged.
pub fn split_attachment_wrapper(text: &str) -> (String, Vec<AttachedFile>) {
    let trimmed = text.trim_end();
    let Some(close) = trimmed.rfind(ATTACHMENT_CLOSE) else {
        return (text.to_string(), Vec::new());
    };
    if close + ATTACHMENT_CLOSE.len() != trimmed.len() {
        return (text.to_string(), Vec::new());
    }
    let Some(open) = trimmed[..close].rfind(ATTACHMENT_OPEN) else {
        return (text.to_string(), Vec::new());
    };
    let body = &trimmed[open + ATTACHMENT_OPEN.len()..close];
    let visible = trimmed[..open].trim_end();
    (visible.to_string(), parse_entries(body))
}

fn parse_entries(body: &str) -> Vec<AttachedFile> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find(ENTRY_OPEN) {
        let after = &rest[start + ENTRY_OPEN.len()..];
        let Some(name_end) = after.find('"') else {
            break;
        };
        let name = unescape_attr(&after[..name_end]);
        let tail = &after[name_end + 1..];
        let Some(after_size_attr) = tail.strip_prefix(" size=\"") else {
            rest = tail;
            continue;
        };
        let Some((digits, after_size)) = after_size_attr.split_once('"') else {
            break;
        };
        out.push(AttachedFile {
            name,
            size: digits.parse().unwrap_or(0),
            // `<file …/>` has no inline content; `<file …>` was inlined.
            inlined: !after_size.starts_with("/>"),
        });
        rest = after_size;
    }
    out
}

fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn unescape_attr(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    /// 4x4 red PNG (73 bytes), base64.
    const TINY_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==";

    fn image(data: &str, name: &str) -> ComposerImageInput {
        ComposerImageInput {
            name: Some(name.to_string()),
            data: Some(data.to_string()),
            path: None,
            mime_type: Some("image/png".to_string()),
        }
    }

    fn file(path: &Path) -> ComposerFileInput {
        ComposerFileInput {
            name: path.file_name().map(|n| n.to_string_lossy().to_string()),
            data: None,
            path: Some(path.to_string_lossy().to_string()),
        }
    }

    #[test]
    fn images_become_content_blocks() {
        let prepared = prepare("look", &[image(TINY_PNG_B64, "shot.png")], &[], "s1").unwrap();
        assert_eq!(prepared.images.len(), 1);
        assert_eq!(prepared.prompt_text, "look");
        match &prepared.images[0] {
            ContentBlock::Image { mime_type, .. } => assert_eq!(mime_type, "image/png"),
            other => panic!("expected an image block, got {other:?}"),
        }
    }

    #[test]
    fn small_text_files_are_inlined_with_an_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, "# hi\n").unwrap();

        let prepared = prepare("read this", &[], &[file(&path)], "s1").unwrap();
        assert!(prepared.images.is_empty());
        let expected = std::fs::canonicalize(&path).unwrap();
        assert!(
            prepared
                .prompt_text
                .contains(&format!("name=\"{}\"", expected.to_string_lossy())),
            "{}",
            prepared.prompt_text
        );
        assert!(prepared.prompt_text.contains("# hi"));
        assert!(prepared.prompt_text.contains("size=\"5\""));
    }

    #[test]
    fn large_files_are_referenced_but_not_inlined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.log");
        let body = "x".repeat((INLINE_MAX_BYTES + 1) as usize);
        std::fs::write(&path, &body).unwrap();

        let prepared = prepare("", &[], &[file(&path)], "s1").unwrap();
        assert!(!prepared.prompt_text.contains("xxxxx"));
        assert!(
            prepared.prompt_text.contains("/>"),
            "{}",
            prepared.prompt_text
        );
        assert!(prepared.prompt_text.contains("<note>"));
    }

    #[test]
    fn binary_files_are_never_inlined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.zip");
        std::fs::write(&path, [0x50u8, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x00]).unwrap();

        let prepared = prepare("", &[], &[file(&path)], "s1").unwrap();
        assert!(prepared.prompt_text.contains("/>"));
    }

    #[test]
    fn pasted_files_are_spooled_so_read_can_open_them() {
        let data = base64::engine::general_purpose::STANDARD.encode(b"pasted body");
        let input = ComposerFileInput {
            name: Some("paste.txt".to_string()),
            data: Some(data),
            path: None,
        };
        let prepared = prepare("", &[], &[input], "test-session-spool").unwrap();
        let path = prepared
            .prompt_text
            .split("name=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("a referenced path");
        assert!(path.contains("attachments"), "{path}");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "pasted body");
        remove_session_dir("test-session-spool");
        assert!(!Path::new(path).exists());
    }

    #[test]
    fn image_files_in_the_file_channel_become_image_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chart.png");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(TINY_PNG_B64)
            .unwrap();
        std::fs::write(&path, bytes).unwrap();

        let prepared = prepare("", &[], &[file(&path)], "s1").unwrap();
        assert_eq!(prepared.images.len(), 1);
        assert_eq!(prepared.prompt_text, "");
    }

    #[test]
    fn wrapper_round_trips_for_display() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("a.md");
        std::fs::write(&small, "aaa").unwrap();
        let big = dir.path().join("b.pdf");
        std::fs::write(&big, vec![b'%'; (INLINE_MAX_BYTES + 1) as usize]).unwrap();

        let prepared = prepare("question", &[], &[file(&small), file(&big)], "s1").unwrap();
        let (visible, files) = split_attachment_wrapper(&prepared.prompt_text);
        assert_eq!(visible, "question");
        assert_eq!(files.len(), 2);
        assert_eq!(
            files[0].name,
            std::fs::canonicalize(&small).unwrap().to_string_lossy()
        );
        assert!(files[0].inlined);
        assert_eq!(files[0].size, 3);
        assert!(!files[1].inlined);
    }

    #[test]
    fn plain_prompts_are_untouched() {
        assert_eq!(
            split_attachment_wrapper("just text"),
            ("just text".to_string(), Vec::new())
        );
    }

    #[test]
    fn rejects_invalid_payloads() {
        let bad = ComposerFileInput {
            name: Some("x.bin".into()),
            data: Some("not base64!!".into()),
            path: None,
        };
        let error = prepare("", &[], &[bad], "s1").expect_err("must reject");
        assert!(error.contains("base64"), "{error}");

        let missing = ComposerFileInput {
            name: Some("gone.txt".into()),
            data: None,
            path: Some("/definitely/not/here.txt".into()),
        };
        let error = prepare("", &[], &[missing], "s1").expect_err("must reject");
        assert!(error.contains("no longer exists"), "{error}");
    }

    #[test]
    fn session_ids_stay_inside_the_attachments_dir() {
        assert_eq!(safe_component("../../etc", "_session"), "etc");
        assert_eq!(safe_component("", "_session"), "_session");
        assert_eq!(safe_component("sess-1_ok", "_session"), "sess-1_ok");
    }
}
