import { applyOperations, createDemoDocument, type EmailDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { selectSeededFinding } from "./demo-findings";
import { composeFindingOps } from "./finding-ops";

/*
  The /demo fixture is the only place in the product where the words on a
  recommendation card were written by a person instead of a model, so the
  things that must hold are: it is about the email it claims to be about, its
  one-press fix actually applies and actually fixes the thing, and it stops
  serving the moment the email stops matching.

  Every fix here is composed through composeFindingOps — the SAME translation
  the route runs on a live persona's output. The fixture carries no operations
  of its own, so these tests double as proof that its authored edits are a
  shape the live runner could have produced.
*/

const TONE_POLICE = "builtin/tone-police";
const STYLING_RECOMMENDER = "builtin/styling-recommender";

function applySeededFix({
  doc,
  personaSlug,
}: {
  doc: EmailDocument;
  personaSlug: string;
}): EmailDocument {
  const finding = selectSeededFinding({ doc, personaSlug });
  if (finding === null) {
    throw new Error(`expected a seeded finding for ${personaSlug}`);
  }
  const ops = composeFindingOps({
    doc,
    proposedEdits: finding.proposedEdits,
    proposedCopyEdits: finding.proposedCopyEdits,
  });
  if (ops === null || ops.length === 0) {
    throw new Error(`the seeded fix for ${personaSlug} composed no applyable ops`);
  }
  const result = applyOperations(doc, ops);
  if (!result.isOk) {
    throw new Error(`the seeded fix for ${personaSlug} did not apply`);
  }
  return result.doc;
}

describe("selectSeededFinding", () => {
  it("serves a finding for each of the demo's two agents against the seed email", () => {
    const doc = createDemoDocument();
    expect(selectSeededFinding({ doc, personaSlug: TONE_POLICE })).not.toBeNull();
    expect(selectSeededFinding({ doc, personaSlug: STYLING_RECOMMENDER })).not.toBeNull();
  });

  it("serves nothing for a persona the fixture was not written for", () => {
    const doc = createDemoDocument();
    expect(selectSeededFinding({ doc, personaSlug: "builtin/qa-reviewer" })).toBeNull();
  });

  it("serves nothing for an email that is not the seed", () => {
    /* The generic mock covers everything else. A confident, specific
       recommendation about a paragraph that does not exist is worse than an
       obviously generic one. */
    expect(selectSeededFinding({ doc: {}, personaSlug: TONE_POLICE })).toBeNull();
  });

  it("stops serving once the visitor edits the block the finding is about", () => {
    const doc = createDemoDocument();
    const edited = applySeededFix({ doc, personaSlug: TONE_POLICE });
    /* The fix itself is a drift: having applied it, the finding that proposed
       it must not come back and propose it again. */
    expect(selectSeededFinding({ doc: edited, personaSlug: TONE_POLICE })).toBeNull();
    /* …and the OTHER agent's finding is untouched, because staleness is per
       block, not per document. */
    expect(selectSeededFinding({ doc: edited, personaSlug: STYLING_RECOMMENDER })).not.toBeNull();
  });

  it("every seeded finding composes into an applyable op and offers no chat handoff", () => {
    /* Ops-first is the whole point (convex/schema.ts personaFindings: ops
       carry the fix, suggestedPrompt is the fallback when they cannot). A
       demo recommendation that sends the visitor to the chat composer to ask
       for the edit is a demo of a to-do list. */
    const doc = createDemoDocument();
    for (const personaSlug of [TONE_POLICE, STYLING_RECOMMENDER]) {
      const finding = selectSeededFinding({ doc, personaSlug });
      const ops = composeFindingOps({
        doc,
        proposedEdits: finding?.proposedEdits,
        proposedCopyEdits: finding?.proposedCopyEdits,
      });
      expect(ops?.length).toBeGreaterThan(0);
      expect(finding?.suggestedPrompt).toBeUndefined();
    }
  });

  it("proposes its fixes in the model's own shape — the fixture holds no operations", () => {
    /* The fixture's authored judgement is the only thing it is allowed to
       buy. The moment it starts carrying hand-built ops it is showing the
       visitor a product one change ahead of the live runner. */
    const doc = createDemoDocument();
    for (const personaSlug of [TONE_POLICE, STYLING_RECOMMENDER]) {
      const finding = selectSeededFinding({ doc, personaSlug });
      const serialized = JSON.stringify(finding);
      expect(serialized).not.toContain('"name":"update');
      expect(serialized).not.toContain('"type":"doc"');
    }
    /* And the copy fix is a copy edit, not a property edit smuggling a doc. */
    const tonePolice = selectSeededFinding({ doc, personaSlug: TONE_POLICE });
    expect(tonePolice?.proposedCopyEdits).toEqual([
      { blockId: "txt_push", text: expect.stringContaining("Sunday") },
    ]);
  });

  it("says nothing about being a mock — the disclosure belongs at the exit", () => {
    const doc = createDemoDocument();
    for (const personaSlug of [TONE_POLICE, STYLING_RECOMMENDER]) {
      expect(JSON.stringify(selectSeededFinding({ doc, personaSlug })).toLowerCase()).not.toContain(
        "mock",
      );
    }
  });

  it("the Tone Police's fix travels as an updateText op (the SDK's text path)", () => {
    /* Text content has a dedicated write path all the way down — agent
       updateText ops merge into the block's live ProseMirror sync doc instead
       of clobbering it (convex/agentText.ts). A copy fix that arrived as a
       property write on `text` would bypass that. */
    const doc = createDemoDocument();
    const finding = selectSeededFinding({ doc, personaSlug: TONE_POLICE });
    const ops = composeFindingOps({ doc, proposedCopyEdits: finding?.proposedCopyEdits });
    expect(ops?.map((op) => op.name)).toEqual(["updateText"]);
  });

  it("the Tone Police's fix replaces the shouting with the letter's own voice", () => {
    const fixed = applySeededFix({ doc: createDemoDocument(), personaSlug: TONE_POLICE });
    const rewritten = JSON.stringify(fixed.txt_push);
    expect(rewritten).not.toContain("LAST CHANCE");
    expect(rewritten).not.toContain("RESERVE NOW");
    /* The real deadline survives the rewrite — the finding claims it does. */
    expect(rewritten).toContain("Sunday");
  });

  it("the Styling Recommender's fix makes the second button match the first", () => {
    const fixed = applySeededFix({
      doc: createDemoDocument(),
      personaSlug: STYLING_RECOMMENDER,
    });
    const primary = fixed.btn_prim;
    const secondary = fixed.btn_scnd;
    if (primary?.type !== "button" || secondary?.type !== "button") {
      throw new Error("the demo seed must keep both CTA buttons");
    }
    expect(secondary.properties.backgroundColor).toBe(primary.properties.backgroundColor);
    expect(secondary.properties.borderRadius).toBe(primary.properties.borderRadius);
    expect(secondary.properties.align).toBe(primary.properties.align);
    /* The label and destination are the visitor's copy, not the agent's. */
    expect(secondary.properties.label).toBe("Shop the spring lineup");
  });
});
