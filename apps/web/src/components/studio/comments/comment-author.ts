"use client";

import { deriveIdentity, DISPLAY_NAME_STORAGE_KEY } from "@/lib/presence";

/*
  The local user's display name for comment thread entries — the SAME
  identity presence broadcasts: the localStorage nickname override when one
  is set, else the session-derived adjective-animal name. Resolved at write
  time (a rename applies to the next entry, matching presence semantics).
*/
export function getLocalCommentAuthorName(sessionId: string): string {
  if (typeof window !== "undefined") {
    const nickname = window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY)?.trim();
    if (nickname !== undefined && nickname !== null && nickname.length > 0) {
      return nickname;
    }
  }
  return deriveIdentity(sessionId).name;
}
