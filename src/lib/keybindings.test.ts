import { describe, expect, test } from "bun:test";
import {
  bindingFromEvent,
  findKeybindingConflict,
  formatBinding,
  matchesBinding,
} from "./keybindings";

function key(
  value: string,
  options: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key: value,
    metaKey: options.meta ?? false,
    ctrlKey: options.ctrl ?? false,
    shiftKey: options.shift ?? false,
    altKey: options.alt ?? false,
  } as KeyboardEvent;
}

describe("keybindings", () => {
  test("matches Mod bindings on meta or ctrl", () => {
    expect(matchesBinding(key("n", { meta: true }), "Mod+N")).toBe(true);
    expect(matchesBinding(key("n", { ctrl: true }), "Mod+N")).toBe(true);
    expect(matchesBinding(key("n"), "Mod+N")).toBe(false);
  });

  test("requires exact shift state", () => {
    expect(matchesBinding(key("p", { meta: true }), "Mod+P")).toBe(true);
    expect(matchesBinding(key("p", { meta: true }), "Mod+Shift+P")).toBe(false);
    expect(
      matchesBinding(key("p", { meta: true, shift: true }), "Mod+Shift+P"),
    ).toBe(true);
  });

  test("formats Mod for display", () => {
    expect(formatBinding("Mod+Shift+P")).toEqual(["Cmd/Ctrl", "Shift", "P"]);
    expect(formatBinding(undefined)).toEqual(["—"]);
  });

  test("captures a binding from a keyboard event", () => {
    expect(bindingFromEvent(key("p", { meta: true }))).toBe("Mod+P");
    expect(bindingFromEvent(key("p", { ctrl: true, shift: true }))).toBe(
      "Mod+Shift+P",
    );
    expect(bindingFromEvent(key("p"))).toBeNull();
    expect(bindingFromEvent(key("Meta", { meta: true }))).toBeNull();
  });

  test("detects conflicts with other actions", () => {
    expect(findKeybindingConflict("newThread", "Mod+F")?.id).toBe("findInChat");
    expect(findKeybindingConflict("newThread", "Mod+Shift+X")).toBeNull();
  });
});
