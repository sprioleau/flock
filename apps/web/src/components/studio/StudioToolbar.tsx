"use client";

import { MonitorIcon, Redo2Icon, SmartphoneIcon, Undo2Icon } from "lucide-react";
import type { PreviewMode } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { selectCanRedo, selectCanUndo, useEditorStore } from "@/lib/editor-store";
import { BrandKitPanel } from "./brand-kit/BrandKitPanel";
import { OpInspector } from "./inspector/OpInspector";
import { PresenceFacepile } from "./presence/PresenceFacepile";
import { ReplayPanel } from "./replay/ReplayPanel";
import { ThemeMenu } from "./theme/ThemeMenu";

/**
 * Slim canvas toolbar: desktop/mobile viewport toggle, theme selector, the
 * brand kit panel trigger (right next to the theme menu it feeds),
 * undo/redo (disabled states from stack depth), the read-only power lenses
 * over the op-log spine (time-travel replay, op inspector), and the HTML
 * preview dialog trigger (mounted by StudioShell next to this component's
 * slot).
 */
export function StudioToolbar({ children }: { children?: React.ReactNode }) {
  const viewport = useEditorStore((state) => state.viewport);
  const setViewport = useEditorStore((state) => state.setViewport);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore(selectCanUndo);
  const canRedo = useEditorStore(selectCanRedo);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-background px-3">
      <div className="flex items-center gap-2">
        <ToggleGroup
          value={[viewport]}
          onValueChange={(groupValue) => {
            const next = groupValue[0] as PreviewMode | undefined;
            if (next !== undefined) {
              setViewport(next);
            }
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Canvas viewport"
        >
          <ToggleGroupItem value="desktop" aria-label="Desktop viewport">
            <MonitorIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="mobile" aria-label="Mobile viewport">
            <SmartphoneIcon />
          </ToggleGroupItem>
        </ToggleGroup>
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
