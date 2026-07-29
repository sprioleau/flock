"use client";

import { useEffect } from "react";
import { useEditorStore } from "@/lib/editor-store";
import { ChatPanel } from "./chat/ChatPanel";
import { EditorCanvas } from "./EditorCanvas";
import { HtmlPreviewDialog } from "./HtmlPreviewDialog";
import { PropertyPanelSlot } from "./PropertyPanelSlot";
import { StudioToolbar } from "./StudioToolbar";

/**
 * The /studio product surface: AI chat panel (Phase 3) | toolbar + canvas |
 * property panel slot (wave-2 seam).
 */
export function StudioShell() {
  // Dev-only escape hatch so browser automation / debugging can inspect and
  // assert on store state (window.__tandemEditorStore.getState()).
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as Record<string, unknown>).__tandemEditorStore = useEditorStore;
    }
  }, []);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <ChatPanel />
      <main className="flex min-w-0 flex-1 flex-col">
        <StudioToolbar>
          <HtmlPreviewDialog />
        </StudioToolbar>
        <EditorCanvas />
      </main>
      <PropertyPanelSlot />
    </div>
  );
}
