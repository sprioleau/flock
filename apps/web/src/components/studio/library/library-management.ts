/*
  Content Studio Stage M — the decision logic behind renaming and deleting a
  library asset (proposal §6.2, §8). Pure and unit-tested directly: the panel
  that uses it renders in a jsdom-less test environment, so anything worth
  asserting lives here rather than inside the component.
*/

/*
*/
export interface AssetDeleteRefusal {
  /*
  */
  draftNames: readonly string[];
  /*
  */
  otherDraftCount: number;
}

/*
  Whether an edited name is worth a round trip, and what to send.

  A BLANK name is a real edit, not a no-op: the server reseeds it from the
  asset's generation prompt or its kind label (`seedAssetName`), so clearing
  the field means "put the default name back" — a deliberate way out of a bad
  rename. Only a name that is unchanged after trimming is dropped, so
  blur-without-typing never writes.
*/
export function resolveAssetRenameCommit(args: {
  currentName: string;
  draftName: string;
}): { shouldCommit: boolean; name: string } {
  const trimmedName = args.draftName.trim();
  return { shouldCommit: trimmedName !== args.currentName, name: trimmedName };
}

/*
  The sentence shown when a delete is refused because the image is still on a
  draft. It has to do two jobs: say why nothing happened, and say what to do
  about it — a refusal the user cannot act on is indistinguishable from a bug.

  Drafts the caller does not own are counted, never named (the server decides
  that; see findAssetUsage). A refusal carrying NO drafts at all is the
  scan-bound case: the server could not answer the reference question and
  therefore declined, which is a different sentence — "we couldn't check", not
  "it is in use".
*/
export function buildAssetDeleteRefusalMessage(args: {
  assetName: string;
  refusal: AssetDeleteRefusal;
}): string {
  const { assetName, refusal } = args;
  const usage = formatDraftUsage(refusal);
  if (usage === null) {
    return `We couldn’t check which drafts use “${assetName}”, so it wasn’t deleted. Try again in a moment.`;
  }
  return `“${assetName}” is still used in ${usage}. Remove it there first, then delete it from your library.`;
}

/*
*/
function formatDraftUsage(refusal: AssetDeleteRefusal): string | null {
  const quotedNames = refusal.draftNames.map((name) => `“${name}”`);
  const otherPart =
    refusal.otherDraftCount === 0
      ? null
      : refusal.otherDraftCount === 1
        ? quotedNames.length === 0
          ? "another draft"
          : "1 other draft"
        : `${refusal.otherDraftCount} other drafts`;
  const parts = otherPart === null ? quotedNames : [...quotedNames, otherPart];
  const lastPart = parts.at(-1);
  if (lastPart === undefined) {
    return null;
  }
  const leadingParts = parts.slice(0, -1);
  return leadingParts.length === 0 ? lastPart : `${leadingParts.join(", ")} and ${lastPart}`;
}
