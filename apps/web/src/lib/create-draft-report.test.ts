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

/** A draft whose every section came from the model's own plan. */
const FULLY_PLANNED = {
  plannedSectionCount: 4,
  carriedOverSectionCount: 0,
  templateDefaultSectionCount: 0,
  substitutedSectionCount: 0,
  droppedSectionCount: 0,
};

function outcome(overrides: Partial<CreateDraftOutcome> = {}): CreateDraftOutcome {
  return {
    requestedCount: 1,
    createdDrafts: [{ name: "Portfolio", ...FULLY_PLANNED }],
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
            substitutedSectionCount: 0,
            droppedSectionCount: 0,
          },
        ],
      }),
    );
    expect(thin.note).toContain("3 sections");
    expect(thin.note).toContain("SAMPLE text");
    expect(thin.note).not.toContain("built from the copy you passed");
  });

  /*
    THE SENTENCE THAT SENT THE USER LOOKING FOR A DRAFT THAT WAS NOT THERE.
    Draft names are deduped per canvas as they are ALLOCATED, so the name the
    model asked for and the name in the drafts bar are routinely different
    strings. The note may therefore only quote names that came back from the
    browser, and must say out loud that they can differ from the ones asked
    for — otherwise the agent confidently names a draft nobody can find.
  */
  it("quotes the names the drafts bar actually allocated, not the ones asked for", () => {
    const output = toCreateDraftToolOutput(
      outcome({
        requestedCount: 3,
        createdDrafts: [
          { name: "Portfolio 2", ...FULLY_PLANNED },
          { name: "Portfolio 3", ...FULLY_PLANNED },
          { name: "Bold launch", ...FULLY_PLANNED },
        ],
      }),
    );
    expect(output.note).toContain('"Portfolio 2", "Portfolio 3" and "Bold launch"');
    expect(output.note).toContain("may not be the names you asked for");
    expect(output.createdDrafts.map((created) => created.name)).toEqual([
      "Portfolio 2",
      "Portfolio 3",
      "Bold launch",
    ]);
    /* Three asked for, three landed — no shortfall language. */
    expect(output.note).toContain("Created 3 new drafts");
    expect(output.note).toContain("current draft is untouched");
    expect(output.note).not.toContain("Only 3 of the");
  });

  /*
    Provenance is a fact about the WHOLE call, not about its first draft. A
    report that looked only at `createdDrafts[0]` would describe this call as
    fully written by the model, which is exactly the claim the user caught
    being false.
  */
  it("counts sample copy and carried-over copy across every draft in the call", () => {
    const output = toCreateDraftToolOutput(
      outcome({
        requestedCount: 3,
        isSourceCopyCarryOverAllowed: true,
        createdDrafts: [
          { name: "Written", ...FULLY_PLANNED },
          {
            name: "Thin",
            plannedSectionCount: 1,
            carriedOverSectionCount: 0,
            templateDefaultSectionCount: 2,
            substitutedSectionCount: 0,
            droppedSectionCount: 0,
          },
          {
            name: "Borrowed",
            plannedSectionCount: 1,
            carriedOverSectionCount: 3,
            templateDefaultSectionCount: 0,
            substitutedSectionCount: 0,
            droppedSectionCount: 0,
          },
        ],
      }),
    );
    expect(output.note).toContain("2 sections");
    expect(output.note).toContain("SAMPLE text");
    expect(output.note).toContain("3 sections");
    expect(output.note).toContain("filled from the draft the user is already looking at");
    /* And the call as a whole may NOT be described as fully written. */
    expect(output.note).not.toContain("Every section was built from the copy you passed");
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
            substitutedSectionCount: 0,
            droppedSectionCount: 0,
          },
        ],
      }),
    );
    expect(output.note).toContain("filled from the draft the user is already looking at");
    expect(output.note).toContain("do not present it as new");
  });
});
