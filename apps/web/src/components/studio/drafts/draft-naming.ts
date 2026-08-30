/**
 * Draft naming for the drafts menu flows — pure and unit-testable. Two
 * naming rules, both deduped against the CURRENT canvas draft list so a
 * generated name can never collide with an existing frame label:
 *
 * - {@link computeNextDraftName}: blank drafts ("New draft", "Ideate with
 *   AI") take the next available "Draft N".
 * - {@link computeVariationDraftName}: "Add design variation" derives from
 *   the SOURCE draft's name with exactly one "(variation …)" marker — an
 *   existing marker increments instead of stacking ("Draft 1 (variation)"
 *   → "Draft 1 (variation 2)", never "… (variation) (variation)"), and a
 *   renamed draft without the marker gets it appended once.
 */

/*
  One trailing variation marker: "(variation)" or "(variation N)". Matched
  case-insensitively so a hand-edited "(Variation 2)" still increments
  rather than stacking a second marker.
*/
const VARIATION_SUFFIX_REGEX = /\s*\(variation(?:\s+(\d+))?\)$/i;

/*
  The variation draft's name: the source name with a single "(variation)" /
  "(variation N)" marker, ordinal bumped until it collides with nothing in
  `existingNames`.
*/
export function computeVariationDraftName({
  sourceName,
  existingNames,
}: {
  sourceName: string;
  existingNames: readonly string[];
}): string {
  const trimmedSourceName = sourceName.trim();
  const suffixMatch = VARIATION_SUFFIX_REGEX.exec(trimmedSourceName);
  const baseName =
    suffixMatch === null
      ? trimmedSourceName
      : trimmedSourceName.slice(0, suffixMatch.index).trimEnd();
  /*
    A bare "(variation)" continues at 2; "(variation N)" continues at N+1.
  */
  const startOrdinal =
    suffixMatch === null ? 1 : suffixMatch[1] === undefined ? 2 : Number(suffixMatch[1]) + 1;
  const takenNames = new Set(existingNames);
  for (let ordinal = startOrdinal; ; ordinal++) {
    const marker = ordinal === 1 ? "(variation)" : `(variation ${ordinal})`;
    const candidate = baseName.length > 0 ? `${baseName} ${marker}` : marker;
    if (!takenNames.has(candidate)) {
      return candidate;
    }
  }
}

/*
  The next available name for a new draft.

  Without a `preferredName` this is the SMALLEST unused "Draft N", counting
  from 1 — variation names and renames don't inflate the numbering (a canvas
  of "Draft 1" + "Draft 1 (variation)" yields "Draft 2", not "Draft 3").

  With one — the agent naming a composed draft for what it IS ("Spring sale —
  bold") — that name is used as given, and only if the canvas already has it
  does it take the next free ordinal ("Spring sale — bold 2"). A blank or
  whitespace-only preference falls back to the numbered form.
*/
export function computeNextDraftName({
  existingNames,
  preferredName,
}: {
  existingNames: readonly string[];
  preferredName?: string;
}): string {
  const takenNames = new Set(existingNames);
  const trimmedPreferredName = preferredName?.trim() ?? "";
  if (trimmedPreferredName.length > 0) {
    if (!takenNames.has(trimmedPreferredName)) {
      return trimmedPreferredName;
    }
    for (let ordinal = 2; ; ordinal++) {
      const candidate = `${trimmedPreferredName} ${ordinal}`;
      if (!takenNames.has(candidate)) {
        return candidate;
      }
    }
  }
  for (let candidateNumber = 1; ; candidateNumber++) {
    const name = `Draft ${candidateNumber}`;
    if (!takenNames.has(name)) {
      return name;
    }
  }
}
