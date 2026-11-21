import { describe, expect, test } from "bun:test";
import {
  attachmentFromFile,
  baseName,
  filesFromTransfer,
  isImageFile,
  isImagePath,
} from "./attachments";

const file = (name: string, type: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type });

describe("isImageFile", () => {
  test("trusts an image MIME type", () => {
    expect(isImageFile(file("shot.png", "image/png"))).toBe(true);
    expect(isImageFile(file("paste", "image/jpeg"))).toBe(true);
  });

  test("falls back to the extension when the type is missing", () => {
    // Drag & drop and native clipboard sources often report no type at all.
    expect(isImageFile(file("shot.PNG", ""))).toBe(true);
    expect(isImageFile(file("photo.heic", "application/octet-stream"))).toBe(
      true,
    );
  });

  test("does not treat text or unknown files as images", () => {
    expect(isImageFile(file("main.rs", "text/plain"))).toBe(false);
    expect(isImageFile(file("notes", ""))).toBe(false);
    expect(isImageFile(file("diagram.svg", "image/svg+xml"))).toBe(false);
  });
});

describe("isImagePath", () => {
  test("classifies by extension only", () => {
    expect(isImagePath("/tmp/a/b.PNG")).toBe(true);
    expect(isImagePath("/tmp/a/b.webp")).toBe(true);
    expect(isImagePath("/tmp/a/b.pdf")).toBe(false);
    expect(isImagePath("/tmp/a/b")).toBe(false);
  });
});

describe("baseName", () => {
  test("keeps only the file name of either separator style", () => {
    expect(baseName("/Users/me/report.pdf")).toBe("report.pdf");
    expect(baseName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(baseName("report.pdf")).toBe("report.pdf");
  });
});

describe("attachmentFromFile", () => {
  test("tags images with a preview URL and files without one", () => {
    const image = attachmentFromFile(file("shot.png", "image/png"), "a1");
    expect(image.kind).toBe("image");
    expect(image.previewUrl).toStartWith("blob:");

    const doc = attachmentFromFile(file("q3.pdf", "application/pdf"), "a2");
    expect(doc.kind).toBe("file");
    expect(doc.previewUrl).toBeUndefined();
    expect(doc.size).toBe(3);
  });
});

/** Minimal stand-in for a DataTransferItemList. */
function transfer(
  items: { kind: string; type: string; file?: File }[],
  files?: File[],
) {
  return {
    items: items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null,
    })) as unknown as DataTransferItemList,
    files: (files ?? []) as unknown as FileList,
  };
}

describe("filesFromTransfer", () => {
  test("collects clipboard files of any type, not just images", () => {
    const png = file("shot.png", "image/png");
    const source = file("main.rs", "");
    expect(
      filesFromTransfer(
        transfer([
          { kind: "file", type: "image/png", file: png },
          { kind: "file", type: "", file: source },
        ]),
      ),
    ).toEqual([png, source]);
  });

  test("ignores plain-text clipboard entries", () => {
    expect(
      filesFromTransfer(transfer([{ kind: "string", type: "text/plain" }])),
    ).toEqual([]);
  });

  test("falls back to the flat files list", () => {
    const png = file("shot.png", "image/png");
    expect(filesFromTransfer(transfer([], [png]))).toEqual([png]);
  });

  test("tolerates an empty or missing payload", () => {
    expect(filesFromTransfer(null)).toEqual([]);
    expect(filesFromTransfer(transfer([]))).toEqual([]);
  });
});
