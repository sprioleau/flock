import { describe, expect, it } from "vitest";
import {
  createEmptyDraftOutcome,
  toCreateDraftToolOutput,
  type CreateDraftOutcome,
} from "./create-draft-report";

/*
  The sentence the agent is entitled to say about a draft it created. The
  outcomes exercised here are the ones the convex-test end-to-end cannot reach
  cheaply — nothing landed, and only some of what was asked for landed — and
  they are exactly the ones the old server-composed note got wrong, because a
  note composed from the plan cannot represent a shortfall at all.
*/

function outcome(overrides: Partial<CreateDraftOutcome> = {}): CreateDraftOutcome {
  return {
    requestedCount: 1,
    createdDrafts: [
      {
        name: "Portfolio",
        plannedSectionCount: 4,
        carriedOverSectionCount: 0,
        templateDefaultSectionCount: 0,
      },
    ],
    isComposed: true,
    isSourceCopyCarryOverAllowed: false,
    failureNotice: null,
    ...overrides,
  };
}

describe("toCreateDraftToolOutput", () => {
  it("reports a total failure as a SUCCESSFUL result the model must not retry", () => {
    /*
      The house rule. Routing this through `output-error` would put the model
      on the SDK's repair path, and the repair for createDraft is to call it
      again — which creates a second draft on the user's canvas rather than
      fixing the first.
    */
    const output = toCreateDraftToolOutput({
      ...createEmptyDraftOutcome(),
      requestedCount: 2,
      failureNotice: "Couldn't create the draft (connection error).",
    });
    expect(output.isCreated).toBe(false);
    expect(output.createdDrafts).toEqual([]);
    expect(output.note).toContain("connection error");
    expect(output.note).toContain("do NOT call createDraft again");
  });

  it("says how many of the asked-for drafts are actually there", () => {
    const output = toCreateDraftToolOutput(
      outcome({
        requestedCount: 3,
        failureNotice: "Only some of the new drafts could be created (connection error).",
      }),
    );
    expect(output.isCreated).toBe(true);
    expect(output.note).toContain("Only 1 of the 3 drafts");
    expect(output.note).toContain("do NOT call createDraft again");
  });

  it("does not let a fully-composed draft be described as sample copy, or the reverse", () => {
    const composed = toCreateDraftToolOutput(outcome());
    expect(composed.note).toContain("built from the copy you passed");
    expect(composed.note).not.toContain("SAMPLE");

    const thin = toCreateDraftToolOutput(
      outcome({
        createdDrafts: [
          {
            name: "Portfolio",
            plannedSectionCount: 1,
            carriedOverSectionCount: 0,
            templateDefaultSectionCount: 3,
          },
        ],
      }),
    );
    expect(thin.note).toContain("3 sections");
    expect(thin.note).toContain("SAMPLE text");
    expect(thin.note).not.toContain("built from the copy you passed");
  });

  it("names carried-over copy as the user's own, not as new writing", () => {
    const output = toCreateDraftToolOutput(
      outcome({
        isSourceCopyCarryOverAllowed: true,
        createdDrafts: [
          {
            name: "Variation",
            plannedSectionCount: 1,
            carriedOverSectionCount: 2,
            templateDefaultSectionCount: 0,
          },
        ],
      }),
    );
    expect(output.note).toContain("filled from the draft the user is already looking at");
    expect(output.note).toContain("do not present it as new");
  });
});
