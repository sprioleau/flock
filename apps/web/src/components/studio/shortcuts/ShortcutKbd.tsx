"use client";

import { Kbd } from "@/components/ui/kbd";
import {
  formatShortcut,
  getIsApplePlatform,
  STUDIO_SHORTCUTS,
  type StudioShortcutId,
} from "./shortcut-keys";

/*
  A shortcut's keys in the user's platform notation ("⌘B" / "Ctrl+B").
*/
export function getShortcutDisplay(shortcutId: StudioShortcutId): string {
  return formatShortcut({
    combo: STUDIO_SHORTCUTS[shortcutId].combo,
    isApplePlatform: getIsApplePlatform(),
  });
}

/*
  A shortcut's keycap chip for tooltips and labels. Only ever rendered inside
  post-hydration popups (tooltip/menu content), so reading the platform at
  render time cannot cause a hydration mismatch.
*/
export function ShortcutKbd({
  shortcutId,
  className,
}: {
  shortcutId: StudioShortcutId;
  className?: string;
}) {
  return <Kbd className={className}>{getShortcutDisplay(shortcutId)}</Kbd>;
}
