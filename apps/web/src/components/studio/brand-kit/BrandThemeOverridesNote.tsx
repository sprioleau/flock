"use client";

/*
  The brand kit panel's half of the override indicator (§14.5a). The owner asked
  for two surfaces and drew the line between them himself: "a small circle next
  to the theme dropdown ... and maybe within the brand kit area where the theme
  section is, indicate that there have been some overrides to the applied theme."

  So the dot answers "does THIS draft differ from its theme?" and this answers
  "which drafts on this canvas differ, and from what?" — the canvas-wide view,
  which is the one the panel is for.

  Same restraint as the dot: muted body text, no icon, no color, no action.
  Nothing here is wrong and nothing needs fixing, so nothing shouts. It renders
  null when no draft overrides anything, which is the common case.

  GLOBALS LAYER ONLY, and the wording is careful about it. Per-section
  background overrides are block properties that getCanvasBrandStatus
  deliberately does not read (it would make a hot reactive query depend on every
  block row of every draft — see ThemeOverrideDot). Saying "some of its colors
  and fonts" rather than counting would overclaim; saying which THEME each draft
  is an instance of is exactly what the query knows.
*/
export function BrandThemeOverridesNote({
  drafts,
}: {
  /* Structurally the query's draft rows, narrowed to what the note reads. */
  drafts: readonly {
    name: string;
    parentVariation: { id: string; name: string } | null;
    overriddenGlobalKeys: readonly string[];
  }[];
}) {
  const overriddenDrafts = drafts.filter(
    (draft) => draft.parentVariation !== null && draft.overriddenGlobalKeys.length > 0,
  );
  if (overriddenDrafts.length === 0) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid="brand-theme-overrides-note">
      {overriddenDrafts.length === 1
        ? `“${overriddenDrafts[0]!.name}” uses “${overriddenDrafts[0]!.parentVariation!.name}” with some changes of its own. `
        : `${overriddenDrafts.length} drafts use a theme from this kit with some changes of their own. `}
      Brand updates keep those changes; picking the theme again from the toolbar resets them.
    </p>
  );
}
