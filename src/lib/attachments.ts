import type { ComposerFile, ComposerImage } from "../api/commands";

/**
 * Composer attachment limits.
 *
 * No byte limits: non-image files are never inlined into the prompt — they are
 * handed to pi-rs's `read` tool by absolute path (small text files aside, see
 * `state/attachments.rs`), and images are downscaled to the model's inline
 * limits by pi-rs. A local byte cap would only reject files the backend
 * handles fine.
 */
export const MAX_ATTACHMENTS = 8;
export const MAX_TEXT_ATTACHMENTS = 8;

/**
 * One attachment in the composer.
 *
 * `path` is set when the OS gave us one (native file dialog / native drag):
 * the bytes then never enter the webview. `file` is set when only bytes are
 * available (paste), and is turned into base64 at send time.
 */
export interface ComposerAttachment {
  /** Local rendering id. */
  id: string;
  kind: "image" | "file";
  name: string;
  size?: number;
  mimeType?: string;
  path?: string;
  file?: File;
  /** Blob URL preview for images we hold bytes for. */
  previewUrl?: string;
}

/** Extensions we treat as images when the browser reports no MIME type. */
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff",
]);

export function isImageFile(file: File): boolean {
  // SVG is markup, not a bitmap pi-rs can inline: it goes through the file
  // channel (text, referenced or inlined by the backend).
  if (isSvg(file.name, file.type)) return false;
  if (file.type.startsWith("image/")) return true;
  if (file.type && file.type !== "application/octet-stream") return false;
  return hasImageExtension(file.name);
}

/** Same classification as {@link isImageFile}, for a bare path. */
export function isImagePath(path: string): boolean {
  if (isSvg(path, "")) return false;
  return hasImageExtension(path);
}

function isSvg(name: string, type: string): boolean {
  return type === "image/svg+xml" || /\.svg$/i.test(name);
}

function hasImageExtension(name: string): boolean {
  const dot = name.toLowerCase().lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export const isImageAttachment = (a: ComposerAttachment) => a.kind === "image";

/**
 * Files carried by a clipboard or drag payload.
 *
 * `items` is the rich view (it separates text from files, so pasting a copied
 * *file* — a screenshot, or a file copied in Finder/an editor — is detected),
 * `files` is the flat fallback some platforms populate instead.
 */
export function filesFromTransfer(
  data: {
    items?: DataTransferItemList | null;
    files?: FileList | null;
  } | null,
): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0 && data.files) {
    for (const file of data.files) files.push(file);
  }
  return files;
}

/** Human-readable byte size for chips (`1.4 MB`). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Base file name of an absolute path (handles both separators). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function attachmentFromFile(file: File, id: string): ComposerAttachment {
  const image = isImageFile(file);
  return {
    id,
    kind: image ? "image" : "file",
    name: file.name || (image ? "image" : "file"),
    size: file.size,
    mimeType: file.type || undefined,
    file,
    previewUrl: image ? URL.createObjectURL(file) : undefined,
  };
}

/** Image path whose bytes stay out of the webview (native dialog / drag). */
export function attachmentFromPath(path: string, id: string): ComposerAttachment {
  return {
    id,
    kind: isImagePath(path) ? "image" : "file",
    name: baseName(path),
    path,
  };
}

export function releaseAttachment(attachment: ComposerAttachment): void {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

/** Read a File into base64 (no `data:` prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Build the wire payload for one attachment (base64 only when no path). */
export async function toComposerImage(
  attachment: ComposerAttachment,
): Promise<ComposerImage> {
  if (attachment.path) {
    return { name: attachment.name, path: attachment.path, mimeType: "image/png" };
  }
  if (!attachment.file) throw new Error("Attachment has no bytes");
  return {
    name: attachment.name,
    data: await fileToBase64(attachment.file),
    mimeType: attachment.mimeType ?? "image/png",
  };
}

export async function toComposerFile(
  attachment: ComposerAttachment,
): Promise<ComposerFile> {
  if (attachment.path) return { name: attachment.name, path: attachment.path };
  if (!attachment.file) throw new Error("Attachment has no bytes");
  return { name: attachment.name, data: await fileToBase64(attachment.file) };
}
