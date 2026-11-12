import type { ComposerImage } from "../api/commands";

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Text/code attachments are inlined into the prompt text. */
export const MAX_TEXT_ATTACHMENTS = 4;
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;

export interface TextAttachment {
  name: string;
  content: string;
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "rst", "log",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "swift", "scala",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "css", "scss", "less", "html", "htm", "xml", "svg", "vue", "svelte",
  "sql", "graphql", "gql", "proto", "tf", "dockerfile", "makefile",
  "csv", "tsv", "diff", "patch",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
]);

/** Whether a dropped/picked file can be inlined as text. */
export function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (TEXT_MIME_TYPES.has(file.type)) return true;
  const name = file.name.toLowerCase();
  if (name === "dockerfile" || name === "makefile") return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1));
}

/** Read a File into a ComposerImage (raw base64 + mimeType). */
export function fileToComposerImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // result is `data:<mime>;base64,<data>` — strip the prefix.
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      const mimeMatch = result.match(/^data:([^;,]+)/);
      resolve({
        data,
        mimeType: file.type || mimeMatch?.[1] || "image/png",
      });
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Read a text/code file for inlining into the prompt. */
export function fileToTextAttachment(file: File): Promise<TextAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: file.name,
        content: typeof reader.result === "string" ? reader.result : "",
      });
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
