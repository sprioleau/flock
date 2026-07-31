/**
 * The studio's keyboard shortcut catalog — ONE source of truth shared by the
 * bindings (StudioShortcuts, react-hotkeys-hook syntax) and every
 * discoverability surface (tooltips, menu hints), so a rebinding can never
 * leave a stale label behind.
 *
 * `combo` uses react-hotkeys-hook syntax: `mod` is ⌘ on macOS and Ctrl
 * elsewhere (the library normalizes at match time; `formatShortcut`
 * normalizes the same way at display time).
 */

export const STUDIO_SHORTCUTS = {
  toggleChatPanel: { combo: "mod+b", label: "Toggle chat panel" },
  toggleRightRail: { combo: "mod+backslash", label: "Toggle blocks & properties" },
  focusChatComposer: { combo: "mod+k", label: "Write in chat" },
  quickPrompt: { combo: "slash", label: "Quick prompt" },
  undo: { combo: "mod+z", label: "Undo" },
  redo: { combo: "mod+shift+z", label: "Redo" },
  cycleTheme: { combo: "mod+shift+l", label: "Switch theme" },
  quickAddBlock: { combo: "a", label: "Quick-add a block (hold + hover the draft)" },
} as const satisfies Record<string, { combo: string; label: string }>;

export type StudioShortcutId = keyof typeof STUDIO_SHORTCUTS;

/**
 * Apple-keyboard detection for DISPLAY only (bindings use the library's own
 * `mod` normalization). `userAgentData.platform` where available, UA sniff as
 * the fallback; iPad reports MacIntel. Safe under SSR — returns false, and
 * every caller renders inside popups that only mount post-hydration.
 */
export function getIsApplePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  // Some Chromium contexts report an EMPTY userAgentData.platform — treat
  // empty as missing and fall through to the classic platform string.
  const uaDataPlatform = (navigator as { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  const platform =
    uaDataPlatform !== undefined && uaDataPlatform.length > 0
      ? uaDataPlatform
      : (navigator.platform ?? "");
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const APPLE_KEY_GLYPHS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  backslash: "\\",
  slash: "/",
  enter: "↵",
  escape: "esc",
};

const NON_APPLE_KEY_NAMES: Record<string, string> = {
  mod: "Ctrl",
  meta: "Win",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  backslash: "\\",
  slash: "/",
  enter: "Enter",
  escape: "Esc",
};

/** Apple modifier display order: ⌃ ⌥ ⇧ ⌘ (the macOS HIG convention). */
const APPLE_MODIFIER_ORDER = ["ctrl", "control", "alt", "option", "shift", "mod", "meta"];

/**
 * A `combo` in the user's platform notation: `mod+shift+z` → "⇧⌘Z" on Apple
 * keyboards (glyphs, HIG modifier order, no separators) or "Ctrl+Shift+Z"
 * elsewhere.
 */
export function formatShortcut(args: { combo: string; isApplePlatform: boolean }): string {
  const { combo, isApplePlatform } = args;
  const parts = combo.toLowerCase().split("+");
  if (isApplePlatform) {
    const ordered = [...parts].sort((a, b) => {
      const aOrder = APPLE_MODIFIER_ORDER.indexOf(a);
      const bOrder = APPLE_MODIFIER_ORDER.indexOf(b);
      // Non-modifiers (order -1) sort last; modifiers keep HIG order.
      return (aOrder === -1 ? APPLE_MODIFIER_ORDER.length : aOrder) -
        (bOrder === -1 ? APPLE_MODIFIER_ORDER.length : bOrder);
    });
    return ordered.map((part) => APPLE_KEY_GLYPHS[part] ?? part.toUpperCase()).join("");
  }
  return parts.map((part) => NON_APPLE_KEY_NAMES[part] ?? part.toUpperCase()).join("+");
}
