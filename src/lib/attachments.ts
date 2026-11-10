import type { ComposerImage } from "../api/commands";

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
