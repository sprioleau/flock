"use client";

import { Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DashboardLinkFallback } from "@/lib/auth/DashboardLinkFallback";
import { UserButton } from "@/lib/auth/UserButton";
import { selectCanRedo, selectCanUndo, useEditorStore } from "@/lib/editor-store";
import { BrandKitPanel } from "./brand-kit/BrandKitPanel";
import { CommentsControl } from "./comments/CommentsControl";
import { useAppSettings } from "./demo/app-settings";
import { OpInspector } from "./inspector/OpInspector";
import { LibraryPanel } from "./library/LibraryPanel";
import { AgentCollaboratorsButton } from "./personas/AgentCollaboratorsButton";
import { PresenceFacepile } from "./presence/PresenceFacepile";
import { ReplayPanel } from "./replay/ReplayPanel";
import { ShortcutKbd } from "./shortcuts/ShortcutKbd";
import { ThemeMenu } from "./theme/ThemeMenu";

/*
  Slim canvas toolbar: the `leading` slot (the drafts selector, mounted by
  StudioShell), theme selector, the brand kit panel trigger (right next to
  the theme menu it feeds), and the right-hand action cluster. The
  desktop/mobile viewport toggle, the HTML export, and the test-send dialog
  live on the floating per-frame toolbar (§10.2 frames UX — they are
  per-draft surfaces).

  STANDING PRINCIPLE (owner, item 32 — the header keeps growing): the right
  cluster groups like-with-like, separated by vertical dividers, left to
  right: presence avatars | AGENT surfaces (AI collaborators +
  recommendation history + the comments combo, whose review panel dispatches
  AI fixes) | HISTORY (undo/redo, the History drawer, and the settings-gated
  time-travel replay) | remaining settings-gated debug lenses (op
  inspector).
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
  /*
    The op inspector gates itself off this same flag (returns null) — read
    it here too so its group divider never strands when the lens is hidden.
  */
  const { isOpInspectorEnabled } = useAppSettings();

  return (
    /*
      Narrow-width containment (owner report: header content spilled across
      the property panel): BOTH groups carry min-w-0 so their truncatable
      children (the draft-name trigger, the facepile wrapper below) actually
      shrink instead of forcing the row wider than the canvas column, and
      overflow-hidden is the backstop — nothing in this header may ever
      paint over the sidebar.
    */
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 overflow-hidden border-b bg-background px-3">
      {/*
        overflow-hidden on the group too: if space runs out below every
        child's minimum, the group CLIPS at its own edge instead of painting
        underneath the action cluster to its right. Natural flex basis (no
        flex-1) on purpose: the group keeps its content size and only gives
        way under real pressure — a zero basis let an oversized right
        cluster starve it to nothing.
      */}
      <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
        {leading}
        <ThemeMenu />
        {/*
          ONE brand entry point (owner: the modal button and the "Open the
          brand page" link used to sit side by side here). The immersive
          /brand workspace is still reachable — from a link inside this
          modal — it just no longer gets its own header icon.
        */}
        <BrandKitPanel />
        {/*
          The session's asset library — user-level like the brand kit
          beside it (Content Studio Stage S, owner placement decision).
        */}
        <LibraryPanel />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        {/*
          ACCOUNT. First in the right cluster, immediately before the human
          avatars it belongs with — both answer "who is here". Renders null
          when auth is disabled, so the divider below never strands.

          The two lines below are ONE slot: DashboardLinkFallback renders
          precisely when UserButton does not (auth off, or identity still
          resolving), so exactly one of them ever paints here. It is the
          studio's only way back to /dashboard in those states — the account
          menu that normally carries that link is not on screen. Same skin,
          same index in this flex row, so the swap on load moves nothing to
          its right. See lib/auth/user-menu-visibility.ts.
        */}
        <DashboardLinkFallback />
        <UserButton />

        {/*
          PRESENCE. Constrained from the OUTSIDE (facepile internals belong
          to the presence workstream): the avatar stack lives in a
          HARD-CAPPED slot (max-w-40) that also shrinks first when the row
          tightens — so even a misbehaving facepile can never starve the
          rest of the header or cross into the property panel.
        */}
        <div className="max-w-40 min-w-0 shrink overflow-hidden">
          <PresenceFacepile />
        </div>

        <ToolbarGroupDivider />

        {/*
          AGENT surfaces — their own space, separate from the human avatars
          (owner decision): the AI collaborators sheet + recommendation
          history, and the comments combo (its review panel dispatches
          AI fixes).
        */}
        <AgentCollaboratorsButton />
        <CommentsControl />

        <ToolbarGroupDivider />

        {/*
          HISTORY — everything on the one history spine sits adjacent:
          undo/redo, the History drawer (children slot), and time-travel
          replay when the settings toggle enables it.
        */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Undo"
                  disabled={!canUndo}
                  onClick={() => void undo()}
                />
              }
            >
              <Undo2Icon />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-1.5">
              Undo <ShortcutKbd shortcutId="undo" />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Redo"
                  disabled={!canRedo}
                  onClick={() => void redo()}
                />
              }
            >
              <Redo2Icon />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-1.5">
              Redo <ShortcutKbd shortcutId="redo" />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {children}
        <ReplayPanel />

        {/*
          Settings-gated debug lenses (divider gated on the same flag so it
          never strands alone).
        */}
        {isOpInspectorEnabled && <ToolbarGroupDivider />}
        <OpInspector />
      </div>
    </header>
  );
}

/*
  The like-with-like group separator (item 32 standing principle).
*/
function ToolbarGroupDivider() {
  return <div className="h-4 w-px shrink-0 bg-border" aria-hidden />;
}
