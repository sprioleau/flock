"use client";

import { ChevronDownIcon } from "lucide-react";
import { resolveGlobalStyles, ROOT_BLOCK_ID } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { findMatchingVariation, MOCK_BRAND_KIT, type ThemeVariation } from "@/lib/brand-kit";
import { useEditorStore } from "@/lib/editor-store";
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
 */
export function ThemeMenu() {
  const dispatch = useEditorStore((state) => state.dispatch);
  const isDocumentReady = useEditorStore((state) => state.isDocumentReady);
  const rawGlobals = useEditorStore((state) => {
    const root = state.doc[ROOT_BLOCK_ID];
    return root !== undefined && root.type === "root" ? root.properties.globals : undefined;
  });

  const activeVariation = findMatchingVariation({
    brandKit: MOCK_BRAND_KIT,
    globals: rawGlobals,
  });
  const currentGlobals = resolveGlobalStyles(rawGlobals);

  const applyVariation = (variation: ThemeVariation) => {
    if (activeVariation?.id === variation.id) {
      return; // Already applied verbatim — don't append a no-op history entry.
    }
    dispatch({ name: "applyTheme", globals: variation.globals });
  };

  return (
    <DropdownMenu>
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
        <span className="max-w-28 truncate">{activeVariation?.name ?? "Custom"}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            Theme
            <span className="block text-xs font-normal text-muted-foreground">
              {MOCK_BRAND_KIT.name}
            </span>
          </DropdownMenuLabel>
          {MOCK_BRAND_KIT.variations.map((variation) => (
            <DropdownMenuCheckboxItem
              key={variation.id}
              checked={activeVariation?.id === variation.id}
              onCheckedChange={() => applyVariation(variation)}
              data-testid={`theme-option-${variation.id}`}
            >
              <ThemeSwatch globals={variation.globals} />
              <span className="truncate">{variation.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
