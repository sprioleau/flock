/*
  Settle a button-label editing session's raw editor text into the stored
  label string: paragraph breaks from multiline pastes arrive as separator
  characters, so all whitespace runs collapse to single spaces and the ends
  trim. Returns "" for an effectively-empty label — the caller keeps the
  previous label then (the schema requires a non-empty label).
*/
export function normalizeButtonLabel(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}
