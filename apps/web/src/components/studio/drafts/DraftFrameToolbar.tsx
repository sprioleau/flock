"use client";

import { MonitorIcon, SmartphoneIcon } from "lucide-react";
import type { PreviewMode } from "@tandem/email-sdk";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEditorStore } from "@/lib/editor-store";
import { HtmlPreviewDialog } from "../HtmlPreviewDialog";
import { SendTestEmailDialog } from "../SendTestEmailDialog";

/**
 * §10.2 frames UX — the small floating vertical toolbar attached alongside
 * the ACTIVE frame (rendered only there, so it follows activation). Holds
 * the per-draft surfaces that used to live in the studio header: the
 * desktop/mobile preview toggle, the HTML export dialog, and the test-send
 * dialog (a test sends ONE draft — the active one — so it belongs on the
 * frame). All read the editor store — the store is bound to the active
 * draft, so activating draft B makes these B's controls by construction.
 * History stays in the header (its drawer already follows the active
 * document).
 */
export function DraftFrameToolbar() {
  const viewport = useEditorStore((state) => state.viewport);
  const setViewport = useEditorStore((state) => state.setViewport);

  return (
    <div
      className="flex flex-col items-center gap-1 rounded-lg border bg-background p-1 shadow-sm"
      data-testid="draft-frame-toolbar"
    >
      <ToggleGroup
        value={[viewport]}
        onValueChange={(groupValue) => {
          const next = groupValue[0] as PreviewMode | undefined;
          if (next !== undefined) {
            setViewport(next);
          }
        }}
        orientation="vertical"
        size="sm"
        spacing={1}
        aria-label="Canvas viewport"
      >
        <ToggleGroupItem value="desktop" aria-label="Desktop viewport">
          <MonitorIcon />
        </ToggleGroupItem>
        <ToggleGroupItem value="mobile" aria-label="Mobile viewport">
          <SmartphoneIcon />
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="h-px w-5 bg-border" aria-hidden />
      <HtmlPreviewDialog isIconTrigger />
      <div className="h-px w-5 bg-border" aria-hidden />
      <SendTestEmailDialog isIconTrigger />
    </div>
  );
}
