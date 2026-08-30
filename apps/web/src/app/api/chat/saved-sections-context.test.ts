import { describe, expect, it } from "vitest";
import type { Doc } from "@convex/_generated/dataModel";
import { formatSavedSectionsContext } from "./saved-sections-context";

/*
  The saved-sections FRESH-layer context block (owner V2 items 3+4): one
  line per saved row advertising its scaffoldSection `saved:<id>`
  templateId, guidance falling back useWhen → description → block count,
  and the usage stat with TIEBREAKER-ONLY wording pinned.
*/

type SavedSectionRow = Parameters<typeof formatSavedSectionsContext>[0][number];

function buildRow(overrides: Partial<Doc<"savedSections">>): SavedSectionRow {
  return {
    _id: "kd7row1" as Doc<"savedSections">["_id"],
    name: "My footer",
    blockCount: 3,
    useWhen: undefined,
    description: undefined,
    useCount: undefined,
    ...overrides,
  };
}

describe("formatSavedSectionsContext", () => {
  it("returns null for an empty list (the turn proceeds catalog-only)", () => {
    expect(formatSavedSectionsContext([])).toBeNull();
  });

  it("advertises each row as a saved:<id> templateId with its name", () => {
    const context = formatSavedSectionsContext([
      buildRow({ _id: "kd7abc" as never, name: "Branded header" }),
    ]);
    expect(context).toContain('- saved:kd7abc — "Branded header"');
    expect(context).toContain("scaffoldSection");
  });

  it("falls back useWhen → description → block count for the guidance text", () => {
    const withUseWhen = formatSavedSectionsContext([
      buildRow({ useWhen: "Use as the closing footer.", description: "Ignored" }),
    ]);
    expect(withUseWhen).toContain("Use as the closing footer.");
    expect(withUseWhen).not.toContain("Ignored");

    const withDescription = formatSavedSectionsContext([
      buildRow({ description: "A stacked footer section." }),
    ]);
    expect(withDescription).toContain("A stacked footer section.");

    const bare = formatSavedSectionsContext([buildRow({ blockCount: 5 })]);
    expect(bare).toContain("5 blocks, saved by the user.");
  });

  it("appends the usage stat and pins the tiebreaker-only wording", () => {
    const context = formatSavedSectionsContext([buildRow({ useCount: 12 })]);
    expect(context).toContain("(used 12×)");
    /*
      Usage may TIEBREAK equivalent options, never outrank content fit.
    */
    expect(context).toMatch(
      /Prefer frequently-used saved sections only when options are otherwise equivalent[\s\S]*tiebreaker, never a substitute for content fit/,
    );
    /*
      Zero/absent counts show no stat.
    */
    expect(formatSavedSectionsContext([buildRow({ useCount: 0 })])).not.toContain("used 0");
  });
});
