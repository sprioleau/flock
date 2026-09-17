import { describe, expect, it } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import { getDraftRemovalAction } from "./DraftSelector";

describe("getDraftRemovalAction", () => {
  it("offers rollback only when an imported draft has a source binding", () => {
    expect(
      getDraftRemovalAction({
        htmlImport: { sourceDocumentId: "source" as Id<"documents"> },
      }),
    ).toBe("rollback");
    expect(getDraftRemovalAction({ htmlImport: {} })).toBe("delete");
    expect(getDraftRemovalAction({})).toBe("delete");
  });
});
