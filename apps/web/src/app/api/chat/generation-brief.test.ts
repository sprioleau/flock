import { createEmptyDocument, createStarterDocument, type EmailDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { GENERATION_REQUEST_DATA_PART_TYPE, type FlockChatDataPart } from "@/lib/chat-contract";
import {
  buildDesignVariationPrompt,
  buildIdeateDraftPrompt,
  buildIdeationOutline,
  buildVariationBrief,
  expandGenerationBriefPart,
  hasSourceThemeApplied,
  VARIATION_MAX_TEXT_CHARS,
} from "./generation-brief";

/**
 * The reported bug's own document, in miniature: a personal email with a
 * headline, a paragraph LONGER than the outline's 70-char snippet cap, a real
 * photo, and a CTA — plus a two-column hero so the brief has a column shape to
 * report. Any content that fails to reach the prompt from here is content the
 * model cannot preserve.
 */
const PERSONAL_PARAGRAPH =
  "I write code and break things (responsibly). Every couple of weeks I send a short note about what I shipped, what broke, and the one thing I'd do differently next time.";

function createPersonalSourceDocument(): EmailDocument {
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_hd01", "sec_hr01"],
      properties: { globals: { emailBackgroundColor: "#1b1035" } },
    },
    sec_hd01: {
      id: "sec_hd01",
      type: "section",
      parentId: "root",
      childrenIds: ["img_lg01"],
      properties: {},
    },
    img_lg01: {
      id: "img_lg01",
      type: "image",
      parentId: "sec_hd01",
      childrenIds: [],
      properties: { src: "https://cdn.example/sq-logo.png", alt: "San'Quan logo" },
    },
    sec_hr01: {
      id: "sec_hr01",
      type: "section",
      parentId: "root",
      childrenIds: ["row_hr01"],
      properties: {},
    },
    row_hr01: {
      id: "row_hr01",
      type: "row",
      parentId: "sec_hr01",
      childrenIds: ["col_hr01", "col_hr02"],
      properties: {},
    },
    col_hr01: {
      id: "col_hr01",
      type: "column",
      parentId: "row_hr01",
      childrenIds: ["txt_hr01", "btn_hr01"],
      properties: { widthPercent: 60 },
    },
    txt_hr01: {
      id: "txt_hr01",
      type: "text",
      parentId: "col_hr01",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Hi, I'm San'Quan." }],
            },
            { type: "paragraph", content: [{ type: "text", text: PERSONAL_PARAGRAPH }] },
          ],
        },
      },
    },
    btn_hr01: {
      id: "btn_hr01",
      type: "button",
      parentId: "col_hr01",
      childrenIds: [],
      properties: { label: "Read the latest", href: "https://sq.example/latest" },
    },
    col_hr02: {
      id: "col_hr02",
      type: "column",
      parentId: "row_hr01",
      childrenIds: ["img_ph01"],
      properties: { widthPercent: 40 },
    },
    img_ph01: {
      id: "img_ph01",
      type: "image",
      parentId: "col_hr02",
      childrenIds: [],
      properties: { src: "https://cdn.example/desk.jpg", alt: "My desk at 2am" },
    },
  } as unknown as EmailDocument;
}

describe("buildIdeationOutline", () => {
  it("returns an empty string for a blank draft — no context block worth writing", () => {
    // The shared generator would say "(no sections)"; the prompts read "" as
    // "there is no source to mention".
    expect(buildIdeationOutline(createEmptyDocument())).toBe("");
  });

  it("keeps the shared outline's default clip — a sketch, not source material", () => {
    const outline = buildIdeationOutline(createPersonalSourceDocument());
    expect(outline).toContain("Hi, I'm San'Quan.");
    // The whole point of the ideate path: the wording does NOT survive, so the
    // model invents rather than rewrites.
    expect(outline).not.toContain(PERSONAL_PARAGRAPH);
  });
});

describe("buildVariationBrief", () => {
  it("returns an empty string for a blank (childless-root) document", () => {
    expect(buildVariationBrief(createEmptyDocument())).toBe("");
  });

  it("carries the source's real copy WHOLE, past the clip that lost it", () => {
    const doc = createPersonalSourceDocument();
    // The reported failure, both halves: the ideate-fidelity view truncates
    // the owner's paragraph to a third of itself; this one does not.
    expect(buildIdeationOutline(doc)).not.toContain(PERSONAL_PARAGRAPH);
    expect(PERSONAL_PARAGRAPH.length).toBeLessThan(VARIATION_MAX_TEXT_CHARS);
    const brief = buildVariationBrief(doc);
    expect(brief).toContain(PERSONAL_PARAGRAPH);
    expect(brief).toContain("Hi, I'm San'Quan.");
  });

  it("keeps the shared outline's structural facts the variation has to change", () => {
    const brief = buildVariationBrief(createPersonalSourceDocument());
    // Column widths and heading levels — the current arrangement, stated so the
    // model can deliberately depart from it.
    expect(brief).toContain("row (2 col)");
    expect(brief).toContain("60%");
    expect(brief).toContain("40%");
    expect(brief).toMatch(/text h1,p/);
  });

  it("lists the EXACT image addresses, which the shared outline reduces to a host", () => {
    const brief = buildVariationBrief(createPersonalSourceDocument());
    // The shared outline says `src=cdn.example`; a variation that has to move
    // an image needs the file itself or it lands a grey placeholder.
    expect(brief).toContain("The pictures it uses:");
    expect(brief).toContain('- "My desk at 2am" → https://cdn.example/desk.jpg');
    expect(brief).toContain('- "San\'Quan logo" → https://cdn.example/sq-logo.png');
  });

  it("carries the theme summary, so a failed seed is still visible to the model", () => {
    expect(buildVariationBrief(createPersonalSourceDocument())).toContain(
      "emailBackgroundColor=#1b1035",
    );
  });
});

describe("hasSourceThemeApplied", () => {
  /** The blank draft the variation streams into, wearing `globals`. */
  function createTargetDocument(globals: Record<string, string>): EmailDocument {
    const doc = createEmptyDocument();
    const root = doc.root;
    if (root !== undefined && root.type === "root") {
      doc.root = { ...root, properties: { globals } };
    }
    return doc;
  }

  it("reports the seeded theme as applied", () => {
    // What DraftSelector's applyTheme op produces when it lands.
    expect(
      hasSourceThemeApplied({
        sourceDoc: createPersonalSourceDocument(),
        targetDoc: createTargetDocument({ emailBackgroundColor: "#1b1035" }),
      }),
    ).toBe(true);
  });

  it("reports a FAILED seed, so the model is told to match the look itself", () => {
    // The whole reason this is derived server-side: the client could only
    // report what it intended, this reports what is actually on the draft.
    expect(
      hasSourceThemeApplied({
        sourceDoc: createPersonalSourceDocument(),
        targetDoc: createEmptyDocument(),
      }),
    ).toBe(false);
  });

  it("counts a source on the shared defaults as a match with nothing to copy", () => {
    expect(
      hasSourceThemeApplied({
        sourceDoc: createStarterDocument(),
        targetDoc: createEmptyDocument(),
      }),
    ).toBe(true);
  });
});

describe("expandGenerationBriefPart", () => {
  const briefPart: FlockChatDataPart = {
    type: GENERATION_REQUEST_DATA_PART_TYPE,
    data: { kind: "designVariation", sourceDocumentId: "doc_1" },
  };

  it("expands THIS turn's request into the brief the model reads", () => {
    expect(
      expandGenerationBriefPart({
        part: briefPart,
        brief: { part: briefPart, text: "the brief" },
      }),
    ).toEqual({ type: "text", text: "the brief" });
  });

  it("leaves an EARLIER turn's request collapsed", () => {
    // Same part type, different instance: a thread that has already run a
    // generation must not pay for that brief on every later message.
    const olderPart: FlockChatDataPart = { ...briefPart };
    expect(
      expandGenerationBriefPart({ part: olderPart, brief: { part: briefPart, text: "the brief" } }),
    ).toBeUndefined();
  });

  it("drops every other data part, as passing no hook at all used to", () => {
    const tablePart: FlockChatDataPart = {
      type: "data-table",
      data: { toolCallId: "call_1", headers: ["Name"], rows: [["Draft 1"]] },
    };
    expect(expandGenerationBriefPart({ part: tablePart, brief: null })).toBeUndefined();
    expect(
      expandGenerationBriefPart({
        part: tablePart,
        brief: { part: briefPart, text: "the brief" },
      }),
    ).toBeUndefined();
  });
});

describe("buildIdeateDraftPrompt", () => {
  const promptInput = {
    sourceDraftName: "Launch email",
    sourceOutline: '1. text "Welcome"; button "Get started"',
  };

  it("carries the source draft's name and outline", () => {
    const prompt = buildIdeateDraftPrompt(promptInput);
    expect(prompt).toContain(promptInput.sourceDraftName);
    expect(prompt).toContain(promptInput.sourceOutline);
  });

  it("leaves the agent free to pick a different theme — a fresh concept may relook", () => {
    expect(buildIdeateDraftPrompt(promptInput)).toMatch(/different theme/i);
  });

  it("omits the context block when the source is blank", () => {
    const prompt = buildIdeateDraftPrompt({ sourceDraftName: "Draft 1", sourceOutline: "" });
    expect(prompt).not.toContain("Draft 1");
    expect(prompt).toMatch(/from scratch in this blank draft/i);
  });
});

describe("buildDesignVariationPrompt", () => {
  const themedInput = {
    sourceDraftName: "Launch email",
    sourceBrief: buildVariationBrief(createPersonalSourceDocument()),
    hasSourceTheme: true,
    direction: "",
  };

  it("carries the source draft's name and its whole content brief", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toContain("Launch email");
    expect(prompt).toContain(themedInput.sourceBrief);
    expect(prompt).toContain(PERSONAL_PARAGRAPH);
  });

  it("tells the agent to KEEP the theme rather than trying a different one", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/theme from "Launch email" is already applied/i);
    expect(prompt).toMatch(/Keep it/);
    // The regression under repair: the old prompt invited a relook.
    expect(prompt).not.toMatch(/different theme or visual feel/i);
  });

  it("asks the agent to match the source's look when the theme could not be seeded", () => {
    const prompt = buildDesignVariationPrompt({ ...themedInput, hasSourceTheme: false });
    expect(prompt).toMatch(/Match the look and feel/i);
    expect(prompt).not.toMatch(/already applied/i);
  });

  it("holds the CONTENT fixed and names the structural moves that are free", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/KEEP THE WORDS/);
    expect(prompt).toMatch(/CHANGE THE STRUCTURE/);
    // Concrete moves, not "rework the layout".
    expect(prompt).toMatch(/side-by-side columns/i);
    expect(prompt).toMatch(/how many sections/i);
    expect(prompt).toMatch(/MOVE THE IMAGERY/);
    expect(prompt).toMatch(/full width and much larger/i);
  });

  it("frames the brief as what the email SAYS, not how it is arranged", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/is what "Launch email" SAYS/);
    expect(prompt).toMatch(/the arrangement it happens to be in right now is the one thing/i);
    // The brief's ids belong to the SOURCE draft; this turn is pinned to an
    // empty one, so anchoring a section to them would fail.
    expect(prompt).toMatch(/block ids belong to that other draft/i);
  });

  it("forbids the template sample copy that replaced the user's own", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/Never substitute sample or marketing copy/i);
    expect(prompt).toMatch(/default text is a failure/i);
  });

  it("quotes the person's direction verbatim and lets it outrank the theme", () => {
    const prompt = buildDesignVariationPrompt({
      ...themedInput,
      direction: "  make it light and airy, different colors  ",
    });
    expect(prompt).toContain('"make it light and airy, different colors"');
    expect(prompt).toMatch(/change the theme to match/i);
    expect(prompt).toMatch(/outranks keeping the current one/i);
  });

  it("says nothing about a direction when the person gave none", () => {
    const prompt = buildDesignVariationPrompt({ ...themedInput, direction: "   " });
    expect(prompt).not.toMatch(/The person asked for this specifically/i);
    expect(prompt).not.toMatch(/outranks/i);
  });

  it("still produces a usable prompt when the source draft is empty", () => {
    // The fail-soft path: an unreadable source leaves the person's own
    // sentence to carry the turn, and the instructions still have to stand up.
    const prompt = buildDesignVariationPrompt({ ...themedInput, sourceBrief: "" });
    expect(prompt).toMatch(/KEEP THE WORDS/);
    expect(prompt).not.toMatch(/is what "Launch email" SAYS/);
  });
});
