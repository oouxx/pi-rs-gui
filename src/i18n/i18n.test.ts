import { describe, expect, test } from "bun:test";
import { resolveLanguage, translate } from "./index";

describe("i18n", () => {
  test("translates dictionary keys", () => {
    expect(translate("en", "nav.settings")).toBe("Settings");
    expect(translate("zh", "nav.settings")).toBe("设置");
    expect(translate("zh", "composer.enterSend")).toBe("Enter 发送");
  });

  test("resolves explicit language preferences", () => {
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("zh")).toBe("zh");
  });

  test("system preference resolves to a supported language", () => {
    expect(["en", "zh"]).toContain(resolveLanguage("system"));
  });
});
