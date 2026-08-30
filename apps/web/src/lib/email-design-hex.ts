import type { BrandColor } from "./brand-kit";

/*
  Hex-color plumbing for the email-design.md renderer (the CEILING over the
  structured brand kit's FLOOR). This module is React-free on purpose: the
  matching and kit-resolution rules are the testable logic, and they live
  here so vitest (node-env, no DOM) can exercise them without a component.

  The design rule (the owner's "pragmatic" model): the structured kit stays
  the single source of truth for COLOR; the md carries USAGE/INTENT. The
  renderer turns ANY hex in the md into a swatch chip. A hex that matches a
  kit color is labelled with that color's name and marked "from kit"; a hex
  that matches nothing in the kit is still chipped, but marked "unmanaged".
  Nothing here restates the palette as authoritative — it only annotates.
*/

/*
  One hex token found in a run of text: the normalized #rrggbb value, plus
  where it sat in the ORIGINAL string (so a renderer can slice the text into
  before / chip / after without re-searching).
*/
export interface HexToken {
  /*
    Normalized to lowercase #rrggbb, even when the source wrote #RGB or #ABC.
  */
  hex: string;
  /*
    Start offset of the match in the source string.
  */
  index: number;
  /*
    Length of the ORIGINAL matched text (#abc is 4, #aabbcc is 7) — so a
    slice using index + length lifts out exactly what was written.
  */
  length: number;
}

/*
  Matches #rgb and #rrggbb, case-insensitive. The negative lookbehind/ahead
  keep it from biting into a longer hex-ish token (#aabbccdd, #abcd) or a
  word character butted against the end, so only the two real CSS forms match.
*/
const HEX_TOKEN_PATTERN = /(?<![0-9a-fA-F#])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;

/*
  Expand a 3-digit hex body ("abc") to its 6-digit form ("aabbcc"). A body
  already 6 long is returned unchanged. Always lowercased.
*/
function normalizeHexBody(body: string): string {
  const lowered = body.toLowerCase();
  if (lowered.length === 3) {
    return lowered
      .split("")
      .map((character) => character + character)
      .join("");
  }
  return lowered;
}

/*
  Every hex token in a run of text, left to right, normalized to #rrggbb.
  Indices are into the ORIGINAL string; length is the original match length.
*/
export function findHexTokens(text: string): HexToken[] {
  const tokens: HexToken[] = [];
  /*
    A fresh regex per call would also work; resetting lastIndex keeps the
    single shared /g instance honest across calls.
  */
  HEX_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEX_TOKEN_PATTERN.exec(text)) !== null) {
    tokens.push({
      hex: `#${normalizeHexBody(match[1]!)}`,
      index: match.index,
      length: match[0].length,
    });
  }
  return tokens;
}

/*
  How a hex found in the md relates to the structured kit.
*/
export interface ResolvedHex {
  /*
    The normalized #rrggbb the caller passed in, echoed back for convenience.
  */
  hex: string;
  /*
    The matching kit color's name, or null when nothing in the kit matches.
  */
  kitColorName: string | null;
  /*
    True exactly when a kit color matched — the "from kit" vs "unmanaged"
    distinction the chip renders.
  */
  isFromKit: boolean;
}

/*
  Resolve a normalized hex against the kit's authored colors, case-insensitive.
  A match labels the chip with that color's NAME and marks it "from kit"; no
  match leaves the chip "unmanaged". First match wins (authored order).
*/
export function resolveHexAgainstKit({
  hex,
  colors,
}: {
  hex: string;
  colors: BrandColor[] | undefined;
}): ResolvedHex {
  const target = hex.toLowerCase();
  const match = (colors ?? []).find((color) => color.hex.toLowerCase() === target);
  return {
    hex,
    kitColorName: match?.name ?? null,
    isFromKit: match !== undefined,
  };
}
