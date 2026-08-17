"use client";

import { useMemo, useState } from "react";
import { Loader2Icon, PlusIcon, ShuffleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BrandColor, BrandKitFonts, ThemeVariation } from "@/lib/brand-kit";
import {
  buildCustomThemeName,
  buildCustomThemeVariation,
  buildThemeCandidates,
  findPaletteColorName,
  getEligibleThemeBackgrounds,
  getPaletteHexes,
  pickNextThemeCandidate,
  type ThemeColorRoles,
} from "@/lib/brand-theme-builder";
import type { ButtonShape } from "@/lib/brand-kit-extraction/expand-variations";
import { ThemeSwatch } from "../theme/ThemeSwatch";
import { ThemeRolePicker } from "./ThemeRolePicker";

/*
  "Add a theme" — the user-authored half of brand-kit-v2 §2.1.

  FILTER-BEFORE-OFFERING, not reject-after-choosing. Every select below is
  populated from the eligible set for the current background, so the user is
  never shown a combination the contrast gate would refuse; and Shuffle draws
  from that same pre-filtered set, which is what makes "shuffle through the
  colors" a safe affordance instead of a slot machine that sometimes lands on
  an unsaveable theme. All of that decision logic is in
  lib/brand-theme-builder.ts with unit tests — this component only renders it
  and hands the result up.

  ~~Deliberately APPEND-ONLY: there is no control here that edits an existing
  theme.~~ There is now, and it is `BrandThemeList` beside this form
  (brand-kit-user-control §14.5b). The blocker was that editing a variation's
  globals detached every draft rendering it; §14.5a resolved that, and the two
  forms share their selects (ThemeRolePicker) so the same contrast filter
  governs an edit and an add. This component is still add-only in the literal
  sense: what it composes is always a NEW variation with a fresh id.
*/
export function BrandThemeBuilder({
  colors,
  fonts,
  buttonShape,
  existingVariationIds,
  isBusy,
  onAdd,
}: {
  colors: BrandColor[];
  fonts: BrandKitFonts;
  /* Inherited from the kit's existing themes — never a choice we ask for. */
  buttonShape: ButtonShape;
  /*
    Every id already spoken for, INCLUDING soft-deleted themes' (§14.5b): a
    deleted row keeps its id so restoring it re-links the drafts pointing
    there, so reusing that id would fuse two themes into one for every pointer
    — and the server refuses it. Counting it as taken here means
    `buildUniqueVariationId` suffixes around it and the user never meets that.
  */
  existingVariationIds: string[];
  isBusy: boolean;
  onAdd: (variation: ThemeVariation) => void;
}) {
  const paletteHexes = useMemo(() => getPaletteHexes(colors), [colors]);
  const eligibleBackgrounds = useMemo(
    () => getEligibleThemeBackgrounds(paletteHexes),
    [paletteHexes],
  );
  const candidates = useMemo(() => buildThemeCandidates(paletteHexes), [paletteHexes]);

  /*
    The picked roles, seeded from the first candidate so the panel opens on a
    real, legible theme rather than an empty form. Null when the palette
    cannot produce one at all — the honest empty state below.
  */
  const [roles, setRoles] = useState<ThemeColorRoles | null>(() => candidates[0]?.roles ?? null);
  const [currentKey, setCurrentKey] = useState<string | null>(() => candidates[0]?.key ?? null);
  /* Undefined = "follow the picked colors"; a string = the user typed a name. */
  const [typedName, setTypedName] = useState<string | undefined>(undefined);

  /* Reactive resync (the BrandColorsEditor idiom): editing the palette can */
  /* invalidate the current pick, so re-seed DURING render rather than in an */
  /* effect, which would paint an impossible theme first and correct it after. */
  const paletteKey = paletteHexes.join(",");
  const [seededFrom, setSeededFrom] = useState(paletteKey);
  if (seededFrom !== paletteKey) {
    setSeededFrom(paletteKey);
    setRoles(candidates[0]?.roles ?? null);
    setCurrentKey(candidates[0]?.key ?? null);
    setTypedName(undefined);
  }

  const nameForColors = buildCustomThemeName({
    backgroundName:
      roles === null ? undefined : findPaletteColorName({ hex: roles.contentBackground, colors }),
    accentName: roles === null ? undefined : findPaletteColorName({ hex: roles.accent, colors }),
  });
  const name = typedName ?? nameForColors;

  const previewVariation =
    roles === null
      ? null
      : buildCustomThemeVariation({
          name,
          roles,
          fonts,
          buttonShape,
          takenIds: existingVariationIds,
        });

  const shuffle = (): void => {
    const next = pickNextThemeCandidate({ candidates, currentKey, randomValue: Math.random() });
    if (next === null) {
      return;
    }
    setRoles(next.roles);
    setCurrentKey(next.key);
    /* A shuffled theme gets the shuffled name — a name the user typed for a */
    /* theme they have since shuffled away from would be a lie on the swatch. */
    setTypedName(undefined);
  };

  if (eligibleBackgrounds.length === 0 || roles === null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="brand-theme-builder-empty">
        No two colors in your palette are readable together, so a theme built from them would be
        hard to read. Add a light or dark color to your palette above and this will fill in.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="brand-theme-builder">
      <ThemeRolePicker
        roles={roles}
        paletteHexes={paletteHexes}
        colors={colors}
        isBusy={isBusy}
        idPrefix="brand-theme"
        onRolesChange={(nextRoles) => {
          setRoles(nextRoles);
          setCurrentKey(`${nextRoles.contentBackground}|${nextRoles.accent}`);
        }}
      />
      <p className="text-xs text-muted-foreground">
        Only colors that stay readable on your background are offered, so any theme you build here
        will save.
      </p>
      <div className="flex items-center gap-2">
        {previewVariation !== null && <ThemeSwatch globals={previewVariation.globals} />}
        <Input
          type="text"
          value={name}
          aria-label="Theme name"
          placeholder="Name this theme"
          className="h-8 min-w-0 flex-1 text-sm"
          onChange={(event) => setTypedName(event.target.value)}
          disabled={isBusy}
          data-testid="brand-theme-name"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={shuffle}
          disabled={isBusy || candidates.length < 2}
          data-testid="brand-theme-shuffle"
        >
          <ShuffleIcon />
          Shuffle
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (previewVariation !== null) {
              onAdd(previewVariation);
            }
          }}
          disabled={isBusy || previewVariation === null}
          data-testid="brand-theme-add"
        >
          {isBusy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
          Add theme
        </Button>
      </div>
    </div>
  );
}
