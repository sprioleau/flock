import { describe, expect, it } from "vitest";
import { formatShortcut, STUDIO_SHORTCUTS } from "./shortcut-keys";

describe("formatShortcut", () => {
  it("renders Apple glyphs with no separators", () => {
    expect(formatShortcut({ combo: "mod+b", isApplePlatform: true })).toBe("⌘B");
    expect(formatShortcut({ combo: "mod+k", isApplePlatform: true })).toBe("⌘K");
  });

  it("orders Apple modifiers per the HIG (shift before command)", () => {
    expect(formatShortcut({ combo: "mod+shift+z", isApplePlatform: true })).toBe("⇧⌘Z");
    expect(formatShortcut({ combo: "mod+shift+l", isApplePlatform: true })).toBe("⇧⌘L");
  });

  it("renders punctuation key names as their characters", () => {
    expect(formatShortcut({ combo: "mod+backslash", isApplePlatform: true })).toBe("⌘\\");
    expect(formatShortcut({ combo: "slash", isApplePlatform: true })).toBe("/");
    expect(formatShortcut({ combo: "slash", isApplePlatform: false })).toBe("/");
  });

  it("renders non-Apple platforms with named modifiers and + separators", () => {
    expect(formatShortcut({ combo: "mod+b", isApplePlatform: false })).toBe("Ctrl+B");
    expect(formatShortcut({ combo: "mod+shift+z", isApplePlatform: false })).toBe("Ctrl+Shift+Z");
    expect(formatShortcut({ combo: "mod+backslash", isApplePlatform: false })).toBe("Ctrl+\\");
  });

  it("uppercases bare letter keys", () => {
    expect(formatShortcut({ combo: "a", isApplePlatform: true })).toBe("A");
    expect(formatShortcut({ combo: "a", isApplePlatform: false })).toBe("A");
  });

  it("formats every cataloged shortcut without throwing", () => {
    for (const { combo } of Object.values(STUDIO_SHORTCUTS)) {
      expect(formatShortcut({ combo, isApplePlatform: true }).length).toBeGreaterThan(0);
      expect(formatShortcut({ combo, isApplePlatform: false }).length).toBeGreaterThan(0);
    }
  });
});
