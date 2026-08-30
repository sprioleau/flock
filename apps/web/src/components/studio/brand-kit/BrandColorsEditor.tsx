"use client";

import { useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BRAND_COLOR_CATEGORIES,
  BRAND_COLOR_CATEGORY_LABELS,
  MAX_BRAND_COLORS,
  MAX_BRAND_COLOR_NAME_LENGTH,
  describeHexColor,
  sortBrandColorsForDisplay,
  type BrandColor,
  type BrandColorCategory,
} from "@/lib/brand-kit";
import { buildBrandColorId } from "@/lib/brand-kit-reconcile";

/*
  The kit's editable palette (brand-kit-user-control §3) — the answer to "if
  the human disagrees with the color the agent selected, they must be able to
  change it". Three labeled groups (primary / secondary / accent), each row a
  swatch, a hex, a name and a remove; "Add color" per group.

  WHAT EDITING A COLOR DOES, honestly (§3.5): the palette is a curated source
  for the color picker and for the agent — it is NOT a token layer. Blocks
  store literal hex values, so changing a color here repaints nothing already
  placed. The hint under the section says exactly that, because "edit the
  brand color" otherwise sounds like it should repaint drafts and it will not.

  Interaction: local draft state gives instant feedback (dragging the color
  well repaints the swatch immediately, never debounced), and the write
  happens on commit — blur, Enter, select change, add, remove — as ONE
  updateBrandColors mutation carrying the whole array.
*/
export function BrandColorsEditor({
  colors,
  isBusy,
  onCommit,
}: {
  colors: BrandColor[];
  isBusy: boolean;
  onCommit: (colors: BrandColor[]) => void;
}) {
  const [draftColors, setDraftColors] = useState<BrandColor[]>(() =>
    sortBrandColorsForDisplay(colors),
  );
  /*
    Reactive resync: a save, a re-scrape, or another tab's edit re-seeds the
    draft. Serialized comparison keeps this from fighting local typing —
    `colors` is a fresh array identity on every render, so comparing the value
    is what makes "did it actually change?" answerable.
  */
  //
  /*
    Adjusted DURING RENDER rather than in an effect. React re-runs this
    component immediately with the new state before touching the DOM, so the
    user never sees the stale draft; an effect would paint the old colors
    first and then overwrite them, which is the cascading render the
    react-hooks/set-state-in-effect rule is pointing at.
  */
  const serializedColors = JSON.stringify(colors);
  const [seededFrom, setSeededFrom] = useState(serializedColors);
  if (seededFrom !== serializedColors) {
    setSeededFrom(serializedColors);
    setDraftColors(sortBrandColorsForDisplay(colors));
  }

  const commit = (nextColors: BrandColor[]): void => {
    setDraftColors(nextColors);
    onCommit(nextColors);
  };

  const patchColor = ({ id, patch }: { id: string; patch: Partial<BrandColor> }): BrandColor[] =>
    draftColors.map((color) => (color.id === id ? { ...color, ...patch } : color));

  const addColor = (category: BrandColorCategory): void => {
    const hex = "#888888";
    /*
      Ids must stay unique even when two slots start from the same swatch.
    */
    const baseId = buildBrandColorId(hex);
    const takenIds = new Set(draftColors.map((color) => color.id));
    let id = baseId;
    let suffix = 2;
    while (takenIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    commit([
      ...draftColors,
      {
        id,
        hex,
        name: describeHexColor(hex),
        category,
        orderIndex: draftColors.filter((color) => color.category === category).length,
        origin: "user",
      },
    ]);
  };

  const isAtCap = draftColors.length >= MAX_BRAND_COLORS;

  return (
    <div className="flex flex-col gap-3" data-testid="brand-kit-colors-editor">
      {BRAND_COLOR_CATEGORIES.map((category) => {
        const groupColors = draftColors.filter((color) => color.category === category);
        return (
          <div key={category} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium tracking-wide text-muted-foreground">
                {BRAND_COLOR_CATEGORY_LABELS[category]}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                onClick={() => addColor(category)}
                disabled={isBusy || isAtCap}
                data-testid={`brand-kit-color-add-${category}`}
              >
                <PlusIcon className="size-3" />
                Add
              </Button>
            </div>
            {groupColors.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No {BRAND_COLOR_CATEGORY_LABELS[category].toLowerCase()} colors yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {groupColors.map((color) => (
                  <li
                    key={color.id}
                    className="flex items-center gap-2"
                    data-testid={`brand-kit-color-row-${color.id}`}
                  >
                    {/*
                      Native color well: the OS picker is the least friction
                      possible, and it repaints the swatch as you drag.
                    */}
                    <input
                      type="color"
                      value={color.hex}
                      aria-label={`${color.name} color value`}
                      className="size-8 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5"
                      onChange={(event) =>
                        setDraftColors(patchColor({ id: color.id, patch: { hex: event.target.value } }))
                      }
                      onBlur={() => commit(draftColors)}
                      disabled={isBusy}
                      data-testid={`brand-kit-color-swatch-${color.id}`}
                    />
                    <Input
                      type="text"
                      value={color.name}
                      maxLength={MAX_BRAND_COLOR_NAME_LENGTH}
                      aria-label={`Name for ${color.hex}`}
                      placeholder="Name this color"
                      className="h-8 min-w-0 flex-1 text-sm"
                      onChange={(event) =>
                        setDraftColors(
                          patchColor({ id: color.id, patch: { name: event.target.value } }),
                        )
                      }
                      onBlur={() => commit(draftColors)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                      disabled={isBusy}
                      data-testid={`brand-kit-color-name-${color.id}`}
                    />
                    <Input
                      type="text"
                      value={color.hex}
                      aria-label={`Hex value for ${color.name}`}
                      className="h-8 w-24 shrink-0 font-mono text-xs"
                      onChange={(event) =>
                        setDraftColors(patchColor({ id: color.id, patch: { hex: event.target.value } }))
                      }
                      onBlur={() => commit(draftColors)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                      disabled={isBusy}
                      data-testid={`brand-kit-color-hex-${color.id}`}
                    />
                    {/*
                      Native select: a category change is a one-tap action and
                      deserves no popover ceremony.
                    */}
                    <select
                      value={color.category}
                      aria-label={`Category for ${color.name}`}
                      className="h-8 shrink-0 rounded-lg border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring"
                      onChange={(event) =>
                        commit(
                          patchColor({
                            id: color.id,
                            patch: { category: event.target.value as BrandColorCategory },
                          }),
                        )
                      }
                      disabled={isBusy}
                      data-testid={`brand-kit-color-category-${color.id}`}
                    >
                      {BRAND_COLOR_CATEGORIES.map((option) => (
                        <option key={option} value={option}>
                          {BRAND_COLOR_CATEGORY_LABELS[option]}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-8 shrink-0 p-0 text-muted-foreground"
                      aria-label={`Remove ${color.name}`}
                      onClick={() =>
                        commit(draftColors.filter((candidate) => candidate.id !== color.id))
                      }
                      disabled={isBusy}
                      data-testid={`brand-kit-color-remove-${color.id}`}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        These colors show up in every color picker. Changing one updates your palette — drafts
        already using the old color keep it until you restyle them.
      </p>
      {isAtCap && (
        <p className="text-xs text-muted-foreground">
          That&apos;s the most colors a kit can hold ({MAX_BRAND_COLORS}). Remove one to add another.
        </p>
      )}
    </div>
  );
}
