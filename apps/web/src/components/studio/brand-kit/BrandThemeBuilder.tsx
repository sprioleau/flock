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
  getEligibleTextColors,
  getEligibleThemeBackgrounds,
  getPaletteHexes,
  pickNextThemeCandidate,
  type ThemeColorRoles,
} from "@/lib/brand-theme-builder";
import type { ButtonShape } from "@/lib/brand-kit-extraction/expand-variations";
import { ThemeSwatch } from "../theme/ThemeSwatch";

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

  Deliberately APPEND-ONLY: there is no control here that edits an existing
  theme. Editing a variation's globals detaches every draft rendering it
  (brand-kit-user-control §14.5), which is unresolved; appending does not,
  because no existing payload changes.
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

  const eligibleTextColors =
    roles === null
      ? []
      : getEligibleTextColors({ background: roles.contentBackground, paletteHexes });

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

  /*
    Changing the background can strand the text colors that were legible on the
    OLD one, so both are re-derived from the new background's eligible set. The
    alternative — leaving a now-illegible text color selected and disabling
    Add — is the reject-after-choosing shape this whole feature exists to
    avoid.
  */
  const chooseBackground = (contentBackground: string): void => {
    const candidate = candidates.find(
      ({ roles: candidateRoles }) =>
        candidateRoles.contentBackground === contentBackground &&
        candidateRoles.accent === roles?.accent,
    );
    const fallback = candidates.find(
      ({ roles: candidateRoles }) => candidateRoles.contentBackground === contentBackground,
    );
    const next = candidate ?? fallback;
    if (next === undefined) {
      return;
    }
    setRoles(next.roles);
    setCurrentKey(next.key);
  };

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

  if (eligibleBackgrounds.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="brand-theme-builder-empty">
        No two colors in your palette are readable together, so a theme built from them would be
        hard to read. Add a light or dark color to your palette above and this will fill in.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="brand-theme-builder">
      <div className="grid grid-cols-2 gap-2">
        <ColorRoleSelect
          label="Background"
          value={roles?.contentBackground ?? ""}
          options={eligibleBackgrounds}
          colors={colors}
          isBusy={isBusy}
          testId="brand-theme-background"
          onChange={chooseBackground}
        />
        <ColorRoleSelect
          label="Buttons & links"
          value={roles?.accent ?? ""}
          /* Every palette color is a safe accent: the button label is derived */
          /* for legibility and the link color repaired against the background, */
          /* exactly as the scrape does for its own variations. */
          options={paletteHexes.filter((hex) => hex !== roles?.contentBackground)}
          colors={colors}
          isBusy={isBusy}
          testId="brand-theme-accent"
          onChange={(accent) => {
            setRoles((current) => (current === null ? null : { ...current, accent }));
            setCurrentKey(
              roles === null ? null : `${roles.contentBackground}|${accent}`,
            );
          }}
        />
        <ColorRoleSelect
          label="Heading text"
          value={roles?.headingText ?? ""}
          options={eligibleTextColors}
          colors={colors}
          isBusy={isBusy}
          testId="brand-theme-heading-text"
          onChange={(headingText) =>
            setRoles((current) => (current === null ? null : { ...current, headingText }))
          }
        />
        <ColorRoleSelect
          label="Body text"
          value={roles?.paragraphText ?? ""}
          options={eligibleTextColors}
          colors={colors}
          isBusy={isBusy}
          testId="brand-theme-paragraph-text"
          onChange={(paragraphText) =>
            setRoles((current) => (current === null ? null : { ...current, paragraphText }))
          }
        />
      </div>
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

/*
  One role's color picker. A native select on purpose (the palette editor's
  category select sets the precedent): the option list IS the filtered set, so
  the control that shows the choices is also the control that enforces them.
*/
function ColorRoleSelect({
  label,
  value,
  options,
  colors,
  isBusy,
  testId,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  colors: BrandColor[];
  isBusy: boolean;
  testId: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={testId} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-6 shrink-0 rounded border border-input"
          style={{ backgroundColor: value }}
          aria-hidden
        />
        <select
          id={testId}
          value={value}
          className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring"
          onChange={(event) => onChange(event.target.value)}
          disabled={isBusy || options.length === 0}
          data-testid={testId}
        >
          {options.map((hex) => (
            <option key={hex} value={hex}>
              {findPaletteColorName({ hex, colors }) ?? hex}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
