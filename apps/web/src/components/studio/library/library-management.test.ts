import { describe, expect, it } from "vitest";
import {
  buildAssetDeleteRefusalMessage,
  resolveAssetRenameCommit,
} from "./library-management";

/*
  Content Studio Stage M: the two decisions the library panel makes locally.
  The refusal sentence is the whole value of blocking an in-use delete — a
  refusal that doesn't say which drafts to fix is a dead end — so it is
  asserted at the character level.
*/

describe("resolveAssetRenameCommit", () => {
  it("skips the round trip when nothing changed", () => {
    expect(
      resolveAssetRenameCommit({ currentName: "hero.png", draftName: "  hero.png  " }),
    ).toEqual({ shouldCommit: false, name: "hero.png" });
  });

  it("commits a trimmed new name", () => {
    expect(
      resolveAssetRenameCommit({ currentName: "hero.png", draftName: "  Spring hero " }),
    ).toEqual({ shouldCommit: true, name: "Spring hero" });
  });

  it("treats a cleared field as a real edit (the server reseeds the default name)", () => {
    expect(resolveAssetRenameCommit({ currentName: "hero.png", draftName: "   " })).toEqual({
      shouldCommit: true,
      name: "",
    });
  });
});

describe("buildAssetDeleteRefusalMessage", () => {
  it("names the single draft still using the image", () => {
    expect(
      buildAssetDeleteRefusalMessage({
        assetName: "hero.png",
        refusal: { draftNames: ["Spring sale"], otherDraftCount: 0 },
      }),
    ).toBe(
      "“hero.png” is still used in “Spring sale”. Remove it there first, then delete it from your library.",
    );
  });

  it("joins several named drafts", () => {
    const message = buildAssetDeleteRefusalMessage({
      assetName: "hero.png",
      refusal: { draftNames: ["Spring sale", "Draft 2", "Launch"], otherDraftCount: 0 },
    });
    expect(message).toContain("“Spring sale”, “Draft 2” and “Launch”");
  });

  it("counts the drafts it cannot name alongside the ones it can", () => {
    const message = buildAssetDeleteRefusalMessage({
      assetName: "hero.png",
      refusal: { draftNames: ["Spring sale"], otherDraftCount: 2 },
    });
    expect(message).toContain("“Spring sale” and 2 other drafts");
  });

  it("describes an unnamed single draft without pretending to know it", () => {
    const message = buildAssetDeleteRefusalMessage({
      assetName: "hero.png",
      refusal: { draftNames: [], otherDraftCount: 1 },
    });
    expect(message).toContain("still used in another draft");
  });

  /*
    The scan-bound case (findAssetUsage blew MAX_BLOCK_ROWS_SCANNED_FOR_USAGE
    and refused rather than guessed). "Still in use in zero drafts" would be
    nonsense; the user is told the check failed, which is the truth.
  */
  it("says the check could not run when the refusal carries no drafts", () => {
    const message = buildAssetDeleteRefusalMessage({
      assetName: "hero.png",
      refusal: { draftNames: [], otherDraftCount: 0 },
    });
    expect(message).toBe(
      "We couldn’t check which drafts use “hero.png”, so it wasn’t deleted. Try again in a moment.",
    );
  });
});
