"use client";

import { Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { selectCanRedo, selectCanUndo, useEditorStore } from "@/lib/editor-store";
import { BrandKitPanel } from "./brand-kit/BrandKitPanel";
import { OpInspector } from "./inspector/OpInspector";
import { LibraryPanel } from "./library/LibraryPanel";
import { AgentCollaboratorsButton } from "./personas/AgentCollaboratorsButton";
import { PresenceFacepile } from "./presence/PresenceFacepile";
import { ReplayPanel } from "./replay/ReplayPanel";
import { SendTestEmailDialog } from "./SendTestEmailDialog";
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
    // Narrow-width containment (owner report: header content spilled across
    // the property panel): BOTH groups carry min-w-0 so their truncatable
    // children (the draft-name trigger, the facepile wrapper below) actually
    // shrink instead of forcing the row wider than the canvas column, and
    // overflow-hidden is the backstop — nothing in this header may ever
    // paint over the sidebar.
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 overflow-hidden border-b bg-background px-3">
      {/* overflow-hidden on the group too: if space runs out below every
          child's minimum, the group CLIPS at its own edge instead of painting
          underneath the action cluster to its right. Natural flex basis (no
          flex-1) on purpose: the group keeps its content size and only gives
          way under real pressure — a zero basis let an oversized right
          cluster starve it to nothing. */}
      <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
        {leading}
        <ThemeMenu />
        <BrandKitPanel />
        {/* The session's asset library — user-level like the brand kit
            beside it (Content Studio Stage S, owner placement decision). */}
        <LibraryPanel />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        {/* Constrained from the OUTSIDE (facepile internals belong to the
            presence workstream): the avatar stack lives in a HARD-CAPPED
            slot (max-w-40) that also shrinks first when the row tightens —
            so even a misbehaving facepile can never starve the rest of the
            header or cross into the property panel. */}
        <div className="max-w-40 min-w-0 shrink overflow-hidden">
          <PresenceFacepile />
        </div>
        {/* AI collaborators sit WITH the human avatars (owner decision) —
            the button opens the agent collaborators modal. */}
        <AgentCollaboratorsButton />
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
        {/* Test-send stays in the header (not the per-frame toolbar): it acts
            on the ACTIVE draft via the store, like History beside it. */}
        <SendTestEmailDialog />
        {children}
      </div>
    </header>
  );
}
