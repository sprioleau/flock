"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { describeThemeOverrides, getThemeOverrideIndicator } from "@/lib/brand-theme-link";
import { useEditorStore } from "@/lib/editor-store";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/*
  THE OVERRIDE INDICATOR (brand-kit-user-control.md §14.5a) — the owner's
  "small circle next to the theme dropdown", modelled on how Webflow marks an
  instance that overrides its class.

  It says one thing: this draft is still connected to a theme, AND some of its
  properties are locally its own. That is a status, not a problem, so the
  treatment is deliberately quiet — a 6px dot with a hover explanation. No
  modal, no banner, no colored warning, nothing that blocks. The owner was
  explicit: "not super in their face". The dot is the entire UI.

  It composes TWO layers, which is why it lives here rather than in the query:

  - GLOBALS come from getCanvasBrandStatus, which resolves the draft's parent
    theme and per-property diff server-side (shared with the pill, so a draft
    is never labelled two ways).
  - SECTION BACKGROUNDS are block properties, and teaching that reactive query
    about them would make it depend on every block row of every draft on the
    canvas — any text edit anywhere would invalidate it for everyone. The
    editor store already knows the answer for the ACTIVE draft for free, and
    the dot only ever describes the active draft.

  Self-contained (drafts-v2 pattern): mount it with one line and it renders
  null whenever there is nothing to say — no parent theme, or no overrides.
*/
export function ThemeOverrideDot({ documentId }: { documentId: Id<"documents"> }) {
  const canvasId = useEditorStore((state) => state.canvasId);
  const status = useQuery(
    api.brandKits.getCanvasBrandStatus,
    canvasId !== null ? { canvasId } : "skip",
  );
  /*
    The block-layer signal, read locally. Same selector the menu uses to decide
    whether re-picking the checked theme is meaningful — applyTheme strips these,
    so a section carrying one really is a local override of the theme.
  */
  const hasSectionThemeOverrides = useEditorStore((state) =>
    Object.values(state.doc).some(
      (block) =>
        block.type === "section" &&
        (block.properties.innerBackgroundColor !== undefined ||
          block.properties.outerBackgroundColor !== undefined),
    ),
  );

  const draft = status?.drafts.find((entry) => entry.documentId === documentId) ?? null;
  const parentVariation = draft?.parentVariation ?? null;
  const { isVisible, overrideCount } = getThemeOverrideIndicator({
    parentVariationId: parentVariation?.id ?? null,
    overriddenGlobalKeys: draft?.overriddenGlobalKeys ?? [],
    hasSectionThemeOverrides,
  });
  if (!isVisible || parentVariation === null) {
    return null;
  }

  const explanation = describeThemeOverrides({
    themeName: parentVariation.name,
    overrideCount,
  });
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              /* Not a button: there is no action here, only a status. Announced
                 to screen readers by its label, since the dot itself is color. */
              role="status"
              aria-label={explanation}
              title={explanation}
              className="-ml-1 size-1.5 shrink-0 rounded-full bg-primary"
              data-testid={`theme-override-dot-${documentId}`}
            />
          }
        />
        <TooltipContent side="bottom">{explanation}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
