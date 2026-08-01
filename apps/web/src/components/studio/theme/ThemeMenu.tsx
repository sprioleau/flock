"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import { resolveGlobalStyles, ROOT_BLOCK_ID } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { findMatchingVariation, type ThemeVariation } from "@/lib/brand-kit";
import { useEditorStore } from "@/lib/editor-store";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";
import { DraftBrandPill } from "../brand-kit/DraftBrandPill";
import { useActiveBrandKit } from "../brand-kit/useActiveBrandKit";
import { ThemeSwatch } from "./ThemeSwatch";

/**
 * The toolbar's theme selector (Phase 7.1): one dropdown listing the brand
 * kit's theme variations, each row showing its ThemeSwatch cue. Selecting a
 * variation dispatches EXACTLY ONE `applyTheme` op — a wholesale replace of
 * `root.properties.globals` — through the store's dispatch: instant local
 * apply on the canvas, one Convex op, one undo step, normal "You"-authored
 * history entry.
 *
 * The checkmark tracks live: a variation is checked only while the document's
 * raw globals exactly equal its payload; any manual global edit flips the
 * trigger label to "Custom" with nothing checked.
 *
 * The kit itself comes from useActiveBrandKit — the session's SAVED kit via a
 * reactive Convex query, mock fallback when none — so saving a kit in the
 * brand kit panel restyles this dropdown in every open tab live.
 */
export function ThemeMenu() {
  const { brandKit, isBoundToCanvas } = useActiveBrandKit();
  const dispatch = useEditorStore((state) => state.dispatch);
  const isDocumentReady = useEditorStore((state) => state.isDocumentReady);
  const documentId = useEditorStore((state) => state.documentId);
  const recordDocumentBrandPointer = useMutation(api.brandKits.recordDocumentBrandPointer);
  // Controlled ONLY so the agent's openPanel("theme") command can open it —
  // human interaction flows through onOpenChange exactly as before.
  const [isOpen, setIsOpen] = useState(false);
  useUiSurfaceOpenRequest("theme", () => setIsOpen(true));
  const rawGlobals = useEditorStore((state) => {
    const root = state.doc[ROOT_BLOCK_ID];
    return root !== undefined && root.type === "root" ? root.properties.globals : undefined;
  });
  // applyTheme also strips per-section background overrides, so re-selecting
  // the checked variation is still meaningful while any section carries one.
  const hasSectionThemeOverrides = useEditorStore((state) =>
    Object.values(state.doc).some(
      (block) =>
        block.type === "section" &&
        (block.properties.innerBackgroundColor !== undefined ||
          block.properties.outerBackgroundColor !== undefined),
    ),
  );

  const activeVariation = findMatchingVariation({
    brandKit,
    globals: rawGlobals,
  });
  const currentGlobals = resolveGlobalStyles(rawGlobals);

  const applyVariation = (variation: ThemeVariation) => {
    if (activeVariation?.id === variation.id && !hasSectionThemeOverrides) {
      return; // Already applied verbatim — don't append a no-op history entry.
    }
    dispatch({ name: "applyTheme", globals: variation.globals });
    // Stage M (§4.3): applying one of the CANVAS-BOUND kit's variations also
    // records the advisory brand pointer — it's what preserve-variation
    // propagation maps into the next kit revision ("midnight stays
    // midnight"). Fire-and-forget UX metadata; never rendering truth.
    if (isBoundToCanvas && documentId !== null) {
      void recordDocumentBrandPointer({ documentId, variationId: variation.id }).catch(
        () => undefined,
      );
    }
  };

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      {/* Tooltip + menu trigger on ONE element (base-ui render composition):
          below xl the trigger is swatch-only, so the hover label carries the
          control's name (item 32 — every header control shows what it does). */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Email theme"
                    disabled={!isDocumentReady}
                  />
                }
                data-testid="theme-menu-trigger"
              >
                <ThemeSwatch globals={currentGlobals} />
                {/* Narrow-width degradation: the swatch alone identifies the
                    control below xl — the name label is the first thing to go. */}
                <span className="hidden max-w-28 truncate xl:inline">
                  {activeVariation?.name ?? "Custom"}
                </span>
                <ChevronDownIcon className="text-muted-foreground" />
              </DropdownMenuTrigger>
            }
          />
          <TooltipContent side="bottom">Email theme</TooltipContent>
        </Tooltip>
      </TooltipProvider>
        {/* Roomier than the menu defaults on purpose (owner feedback: "let
            the themes breathe") — same spacing/typography treatment as the
            Brand kit modal's theme rows so the two surfaces read as one
            system: a real heading, then generous py-2.5 rows. */}
        <DropdownMenuContent align="start" sideOffset={6} className="w-64 p-1.5">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 pt-1.5 pb-2 text-sm font-semibold text-foreground">
              Theme
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {brandKit.name}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="mx-0 mb-1.5" />
            {brandKit.variations.map((variation) => (
              <DropdownMenuCheckboxItem
                key={variation.id}
                checked={activeVariation?.id === variation.id}
                onCheckedChange={() => applyVariation(variation)}
                className="gap-3 px-2 py-2.5"
                data-testid={`theme-option-${variation.id}`}
              >
                <ThemeSwatch globals={variation.globals} />
                <span className="truncate">{variation.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Stage M: the ACTIVE draft's non-blocking "Updated brand available"
          pill lives beside the theme control (the sibling-frame pills mount
          in the frame headers). Renders null while the draft is current. */}
      {documentId !== null && <DraftBrandPill documentId={documentId} />}
    </>
  );
}
