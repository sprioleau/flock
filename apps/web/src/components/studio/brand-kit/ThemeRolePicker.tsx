"use client";

import type { BrandColor } from "@/lib/brand-kit";
import {
  findPaletteColorName,
  getEligibleTextColors,
  getEligibleThemeBackgrounds,
  type ThemeColorRoles,
} from "@/lib/brand-theme-builder";

/*
  The four color-role selects, shared by ADDING a theme and EDITING one
  (brand-kit-v2 §2.1, brand-kit-user-control §14.5b).

  EXTRACTED SO THE FILTER IS THE SAME FILTER. The whole feature is
  filter-before-offering rather than reject-after-choosing, and the way that
  guarantee stops being true is two forms computing "which colors may I offer"
  in two places, one of which quietly falls behind. There is one implementation:
  the eligible background set and, for the chosen background, the eligible text
  set — both from lib/brand-theme-builder.ts, both unit-tested — so a
  combination the contrast gate would refuse is never on screen in either form.

  What differs between the two callers is only which palette they hand in: the
  add form passes the kit's palette, the edit form passes that palette unioned
  with the theme's own four colors (getThemeEditPaletteHexes explains why).
*/
export function ThemeRolePicker({
  roles,
  paletteHexes,
  colors,
  isBusy,
  idPrefix,
  onRolesChange,
}: {
  roles: ThemeColorRoles;
  /*
    The colors this form may offer, BEFORE contrast filtering.
  */
  paletteHexes: string[];
  colors: BrandColor[];
  isBusy: boolean;
  /*
    Distinguishes this form's control ids from any other on screen.
  */
  idPrefix: string;
  onRolesChange: (roles: ThemeColorRoles) => void;
}) {
  const eligibleBackgrounds = getEligibleThemeBackgrounds(paletteHexes);
  const eligibleTextColors = getEligibleTextColors({
    background: roles.contentBackground,
    paletteHexes,
  });

  return (
    <div className="grid grid-cols-2 gap-2">
      <ColorRoleSelect
        label="Background"
        value={roles.contentBackground}
        options={eligibleBackgrounds}
        colors={colors}
        isBusy={isBusy}
        testId={`${idPrefix}-background`}
        onChange={(contentBackground) => {
          /*
            Changing the background can strand text colors that were legible on
            the OLD one, so both are re-derived from the new background's
            eligible set. Leaving an illegible color selected and refusing to
            save is the reject-after-choosing shape this feature exists to
            avoid.
          */
          const nextEligible = getEligibleTextColors({
            background: contentBackground,
            paletteHexes,
          });
          const headingText = nextEligible.includes(roles.headingText)
            ? roles.headingText
            : (nextEligible[0] ?? roles.headingText);
          const paragraphText = nextEligible.includes(roles.paragraphText)
            ? roles.paragraphText
            : (nextEligible[1] ?? headingText);
          onRolesChange({ ...roles, contentBackground, headingText, paragraphText });
        }}
      />
      <ColorRoleSelect
        label="Buttons & links"
        value={roles.accent}
        /*
          Every palette color is a safe accent: the button label is derived
        */
        /*
          for legibility and the link color repaired against the background,
        */
        /*
          exactly as the scrape does for its own variations.
        */
        options={paletteHexes.filter((hex) => hex !== roles.contentBackground)}
        colors={colors}
        isBusy={isBusy}
        testId={`${idPrefix}-accent`}
        onChange={(accent) => onRolesChange({ ...roles, accent })}
      />
      <ColorRoleSelect
        label="Heading text"
        value={roles.headingText}
        options={eligibleTextColors}
        colors={colors}
        isBusy={isBusy}
        testId={`${idPrefix}-heading-text`}
        onChange={(headingText) => onRolesChange({ ...roles, headingText })}
      />
      <ColorRoleSelect
        label="Body text"
        value={roles.paragraphText}
        options={eligibleTextColors}
        colors={colors}
        isBusy={isBusy}
        testId={`${idPrefix}-paragraph-text`}
        onChange={(paragraphText) => onRolesChange({ ...roles, paragraphText })}
      />
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
