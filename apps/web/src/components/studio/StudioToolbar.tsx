"use client";

import { Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { selectCanRedo, selectCanUndo, useEditorStore } from "@/lib/editor-store";
import { BrandKitPanel } from "./brand-kit/BrandKitPanel";
import { OpInspector } from "./inspector/OpInspector";
import { PresenceFacepile } from "./presence/PresenceFacepile";
import { ReplayPanel } from "./replay/ReplayPanel";
import { ThemeMenu } from "./theme/ThemeMenu";

/**
 * Slim canvas toolbar: the `leading` slot (the drafts selector, mounted by
 * StudioShell), theme selector, the brand kit panel trigger (right next to
 * the theme menu it feeds), undo/redo (disabled states from stack depth),
 * the read-only power lenses over the op-log spine (time-travel replay, op
 * inspector), and the History drawer trigger (children slot). The
 * desktop/mobile viewport toggle and the HTML export moved to the floating
 * per-frame toolbar (§10.2 frames UX — they are per-draft surfaces); History
 * stays here because its drawer already follows the active document.
 */
export function StudioToolbar({
  leading,
  children,
}: {
  leading?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore(selectCanUndo);
  const canRedo = useEditorStore(selectCanRedo);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-background px-3">
      <div className="flex items-center gap-2">
        {leading}
        <ThemeMenu />
        <BrandKitPanel />
      </div>

      <div className="flex items-center gap-1.5">
        <PresenceFacepile />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={undo}
        >
          <Undo2Icon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={redo}
        >
          <Redo2Icon />
        </Button>
        <ReplayPanel />
        <OpInspector />
        {children}
      </div>
    </header>
  );
}
