import { describe, expect, test } from "bun:test";
import { imagesFromContent, toolResultPayload } from "./tool-result";

describe("toolResultPayload", () => {
  test("passes plain string results through", () => {
    expect(toolResultPayload("ok")).toEqual({ text: "ok", images: [] });
  });

  test("joins text blocks and keeps details", () => {
    const payload = toolResultPayload({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "\nline 2" },
      ],
      details: { diff: " 1 a" },
    });
    expect(payload.text).toBe("line 1\nline 2");
    expect(payload.details).toEqual({ diff: " 1 a" });
    expect(payload.images).toEqual([]);
  });

  test("keeps inline images a tool returned (read on an image file)", () => {
    const payload = toolResultPayload({
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
      details: {},
    });
    expect(payload.text).toBe("Read image file [image/png]");
    expect(payload.images).toEqual([
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
  });

  test("image-only results do not dump base64 into the text", () => {
    const payload = toolResultPayload({
      content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }],
    });
    expect(payload.text).toBe("");
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].mimeType).toBe("image/jpeg");
  });

  test("falls back to pretty JSON for exotic result shapes", () => {
    const payload = toolResultPayload({ output: 42 });
    expect(payload.images).toEqual([]);
    expect(JSON.parse(payload.text)).toEqual({ output: 42 });
  });

  test("handles null and undefined", () => {
    expect(toolResultPayload(null)).toEqual({ text: "", images: [] });
    expect(toolResultPayload(undefined)).toEqual({ text: "", images: [] });
  });
});

describe("imagesFromContent", () => {
  test("tolerates snake_case mime types and skips empty blocks", () => {
    expect(
      imagesFromContent([
        { type: "image", data: "QUJD", mime_type: "image/gif" },
        { type: "image" },
        { type: "text", text: "hi" },
      ]),
    ).toEqual([{ type: "image", data: "QUJD", mimeType: "image/gif" }]);
  });

  test("returns nothing for non-arrays", () => {
    expect(imagesFromContent(undefined)).toEqual([]);
    expect(imagesFromContent("nope")).toEqual([]);
  });
});
