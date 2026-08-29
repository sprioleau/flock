import { SYSTEM_STATIC, buildToolGuidance } from "@flock/agent";
import { describe, expect, it } from "vitest";
import { chatActionRegistry } from "./registry";
import { buildSystemContext } from "./system-context";

const emptyDoc = {
  root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: {} },
} as never;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/*
  THE DEFECT THESE PIN.

  The createDraft tool result became honest: it now tells the model, in
  imperative English, which planned sections were rebuilt as a different
  template and which were left out of the draft entirely. The model read that
  and still opened its reply with "three new drafts ... complete with your
  headshot and details from your background, story, and selected projects",
  and on another turn described a hero, an article section and testimonials
  that were not in the draft at all.

  The instruction was in the conversation and it lost, because nothing in the
  STANDING prompt said a tool result outranks the plan the model sent. The
  document outline had such a clause ("It is authoritative — trust it over
  anything earlier in the conversation") and tool results had none, while two
  standing rules pulled the other way: "tell the user in plain language what
  each one is" (a question the plan answers) and "name what you read in your
  reply".

  No test can make a model obey. What these pin is that the rule is in the
  bytes the model receives, on every turn rather than only draft turns, stated
  once in the section about how it speaks, and positioned after the per-tool
  guidance so no bullet gets the last word on it.
*/
describe("the reply describes the tool result, not the plan", () => {
  const { staticInstructions } = buildSystemContext({ doc: emptyDoc });

  it("grants tool results the authority the document outline already had", () => {
    expect(staticInstructions).toContain("## Only describe what the tools reported");
    expect(staticInstructions).toContain("that result is authoritative");
    /*
      The three things it must outrank, named, because each one produced a
      false sentence in the wild: the plan, the intent, and the source page.
    */
    expect(staticInstructions).toMatch(
      /outranks the plan you sent[\s\S]*a source you read led you to expect/,
    );
  });

  it("forbids describing anything the result did not confirm", () => {
    expect(staticInstructions).toContain(
      "NEVER describe a section, a draft, an image, a heading, or a line of copy the result did not confirm",
    );
    expect(staticInstructions).toContain("Your own plan is not evidence that it landed");
  });

  it("requires the shortfall in the same reply, not a softer later one", () => {
    expect(staticInstructions).toContain("SAY SO PLAINLY IN THAT SAME REPLY");
    expect(staticInstructions).toContain("not after a paragraph of what went well");
  });

  it("separates naming the source from claiming what landed", () => {
    /*
      "based on your portfolio at sprioleau.dev" was true. Everything after it
      was not. The source-page workflow tells the model to name what it read,
      and that instruction must not be readable as licence to describe
      contents.
    */
    expect(staticInstructions).toContain("says where you looked");
    expect(staticInstructions).toMatch(
      /never a claim about what is in the result[\s\S]*never licenses describing content the result did not confirm/,
    );
  });

  it("states the law exactly once", () => {
    expect(countOccurrences(staticInstructions, "## Only describe what the tools reported")).toBe(1);
    expect(countOccurrences(staticInstructions, "that result is authoritative")).toBe(1);
  });

  it("keeps the law out of SYSTEM_STATIC and the registry-gated tool guidance", () => {
    /*
      SYSTEM_STATIC is shared with the personas route, which has no tools to
      report on; every section of buildToolGuidance is gated on an action
      being registered, so a law living there could be dropped by a registry
      that lacks one tool. The rule belongs in the conduct layer, which is
      unconditional and specific to this pipeline.
    */
    expect(SYSTEM_STATIC).not.toContain("## Only describe what the tools reported");
    expect(buildToolGuidance(chatActionRegistry)).not.toContain(
      "## Only describe what the tools reported",
    );
  });

  it("sits after the per-tool guidance so no bullet gets the last word on it", () => {
    const lawIndex = staticInstructions.indexOf("## Only describe what the tools reported");
    const draftGuidanceIndex = staticInstructions.indexOf("## Making a new draft");
    const pageGuidanceIndex = staticInstructions.indexOf("## Building from a page");
    expect(draftGuidanceIndex).toBeGreaterThanOrEqual(0);
    expect(pageGuidanceIndex).toBeGreaterThanOrEqual(0);
    expect(lawIndex).toBeGreaterThan(draftGuidanceIndex);
    expect(lawIndex).toBeGreaterThan(pageGuidanceIndex);
  });

  it("reaches every turn, not only the ones that carry fresh context", () => {
    /*
      The law lives in the cached prefix, so it is present whatever the
      document, the selection, or the optional fresh layers are — and it costs
      nothing per turn.
    */
    const withFreshLayers = buildSystemContext({
      doc: emptyDoc,
      brandContextLine: "Brand social links: x=https://x.com/cnn",
      savedSectionsContext: "Saved sections: none",
    });
    expect(withFreshLayers.staticInstructions).toBe(staticInstructions);
    expect(withFreshLayers.documentContext).not.toContain(
      "## Only describe what the tools reported",
    );
  });
});
