"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { useHotkeys } from "react-hotkeys-hook";
import { selectCanRedo, selectCanUndo, useEditorStore } from "@/lib/editor-store";
import { focusChatComposer } from "../chat/composer-handoff";
import { getPanelPreferences, updatePanelPreferences } from "../panel-preferences";
import { QuickAddLayer } from "./QuickAddLayer";
import { QuickPromptOverlay } from "./QuickPromptOverlay";
import { STUDIO_SHORTCUTS } from "./shortcut-keys";
import { useHoldToQuickAdd } from "./use-hold-to-quick-add";

/**
 * The studio's keyboard layer, mounted once by StudioShell (only when the
 * document is ready — shortcuts never fire on gate screens). Bindings live in
 * ONE place, on the catalog in shortcut-keys.ts, next to the two gesture
 * surfaces they summon (the slash quick-prompt overlay and the hold-A
 * quick-add layer).
 *
 * Guard policy (react-hotkeys-hook built-ins):
 * - PANEL/CHROME shortcuts (⌘B, ⌘\, ⌘K, ⇧⌘L) also fire while typing in form
 *   fields — they carry a modifier, collide with nothing native there, and
 *   "⌘K from the composer" must work — but NEVER in contenteditable, where
 *   the inline text editor owns ⌘-combos (⌘B = bold).
 * - UNDO/REDO fire only outside all text-editing contexts: form fields keep
 *   native text undo, the inline editor keeps its collab undo.
 * - SINGLE-KEY gestures ("/", hold-A) fire only outside all typing contexts.
 */
export function StudioShortcuts() {
  const [isQuickPromptOpen, setIsQuickPromptOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const quickAdd = useHoldToQuickAdd();

  useHotkeys(
    STUDIO_SHORTCUTS.toggleChatPanel.combo,
    () => {
      updatePanelPreferences({
        isChatPanelExpanded: !getPanelPreferences().isChatPanelExpanded,
      });
    },
    { preventDefault: true, enableOnFormTags: true },
  );

  useHotkeys(
    STUDIO_SHORTCUTS.toggleRightRail.combo,
    () => {
      updatePanelPreferences({
        isRightRailExpanded: !getPanelPreferences().isRightRailExpanded,
      });
    },
    { preventDefault: true, enableOnFormTags: true },
  );

  useHotkeys(
    STUDIO_SHORTCUTS.focusChatComposer.combo,
    () => {
      focusChatComposer();
    },
    { preventDefault: true, enableOnFormTags: true },
  );

  useHotkeys(
    STUDIO_SHORTCUTS.undo.combo,
    () => {
      const state = useEditorStore.getState();
      if (selectCanUndo(state)) {
        state.undo();
      }
    },
    { preventDefault: true },
  );

  useHotkeys(
    STUDIO_SHORTCUTS.redo.combo,
    () => {
      const state = useEditorStore.getState();
      if (selectCanRedo(state)) {
        state.redo();
      }
    },
    { preventDefault: true },
  );

  useHotkeys(
    STUDIO_SHORTCUTS.cycleTheme.combo,
    () => {
      setTheme(getNextTheme(theme));
    },
    { preventDefault: true, enableOnFormTags: true },
    [theme],
  );

  useHotkeys(
    STUDIO_SHORTCUTS.quickPrompt.combo,
    () => {
      setIsQuickPromptOpen(true);
    },
    { preventDefault: true },
  );

  return (
    <>
      <QuickPromptOverlay
        isOpen={isQuickPromptOpen}
        onClose={() => setIsQuickPromptOpen(false)}
      />
      <QuickAddLayer quickAdd={quickAdd} />
    </>
  );
}

/** ⇧⌘L walks light → dark → system (system last: it's the "hands-off" state). */
const THEME_CYCLE = ["light", "dark", "system"] as const;

function getNextTheme(currentTheme: string | undefined): string {
  const currentIndex = THEME_CYCLE.indexOf(currentTheme as (typeof THEME_CYCLE)[number]);
  // Unknown/undefined behaves like "system", so the next stop is "light".
  return THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length] ?? "light";
}
