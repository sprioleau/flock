import { createEmptyDocument, createStarterDocument, type EmailDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { GENERATION_REQUEST_DATA_PART_TYPE, type FlockChatDataPart } from "@/lib/chat-contract";
import {
  buildDesignVariationPrompt,
  buildIdeateDraftPrompt,
  buildIdeationOutline,
  buildVariationBrief,
  countSourceSections,
  expandGenerationBriefPart,
  resolveVariationThemeState,
  VARIATION_MAX_TEXT_CHARS,
} from "./generation-brief";

/*
  The reported bug's own document, in miniature: a personal email with a
  headline, a paragraph LONGER than the outline's 70-char snippet cap, a real
  photo, and a CTA — plus a two-column hero so the brief has a column shape to
  report. Any content that fails to reach the prompt from here is content the
  model cannot preserve.
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
    /*
      The shared generator would say "(no sections)"; the prompts read "" as
      "there is no source to mention".
    */
    expect(buildIdeationOutline(createEmptyDocument())).toBe("");
  });

  it("keeps the shared outline's default clip — a sketch, not source material", () => {
    const outline = buildIdeationOutline(createPersonalSourceDocument());
    expect(outline).toContain("Hi, I'm San'Quan.");
    /*
      The whole point of the ideate path: the wording does NOT survive, so the
      model invents rather than rewrites.
    */
    expect(outline).not.toContain(PERSONAL_PARAGRAPH);
  });
});

describe("buildVariationBrief", () => {
  it("returns an empty string for a blank (childless-root) document", () => {
    expect(buildVariationBrief(createEmptyDocument())).toBe("");
  });

  it("carries the source's real copy WHOLE, past the clip that lost it", () => {
    const doc = createPersonalSourceDocument();
    /*
      The reported failure, both halves: the ideate-fidelity view truncates
      the owner's paragraph to a third of itself; this one does not.
    */
    expect(buildIdeationOutline(doc)).not.toContain(PERSONAL_PARAGRAPH);
    expect(PERSONAL_PARAGRAPH.length).toBeLessThan(VARIATION_MAX_TEXT_CHARS);
    const brief = buildVariationBrief(doc);
    expect(brief).toContain(PERSONAL_PARAGRAPH);
    expect(brief).toContain("Hi, I'm San'Quan.");
  });

  it("keeps the shared outline's structural facts the variation has to change", () => {
    const brief = buildVariationBrief(createPersonalSourceDocument());
    /*
      Column widths and heading levels — the current arrangement, stated so the
      model can deliberately depart from it.
    */
    expect(brief).toContain("row (2 col)");
    expect(brief).toContain("60%");
    expect(brief).toContain("40%");
    expect(brief).toMatch(/text h1,p/);
  });

  it("lists the EXACT image addresses, which the shared outline reduces to a host", () => {
    const brief = buildVariationBrief(createPersonalSourceDocument());
    /*
      The shared outline says `src=cdn.example`; a variation that has to move
      an image needs the file itself or it lands a grey placeholder.
    */
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

describe("resolveVariationThemeState", () => {
  /*
    The blank draft the variation streams into, wearing `globals`.
  */
  function createTargetDocument(globals: Record<string, string>): EmailDocument {
    const doc = createEmptyDocument();
    const root = doc.root;
    if (root !== undefined && root.type === "root") {
      doc.root = { ...root, properties: { globals } };
    }
    return doc;
  }

  it("reports the seeded theme as applied", () => {
    /*
      What DraftSelector's applyTheme op produces when it lands.
    */
    expect(
      resolveVariationThemeState({
        sourceDoc: createPersonalSourceDocument(),
        targetDoc: createTargetDocument({ emailBackgroundColor: "#1b1035" }),
      }),
    ).toBe("source-theme");
  });

  it("reports a FAILED seed, so the model is told to match the look itself", () => {
    /*
      The whole reason this is derived server-side: the client could only
      report what it intended, this reports what is actually on the draft.
    */
    expect(
      resolveVariationThemeState({
        sourceDoc: createPersonalSourceDocument(),
        targetDoc: createEmptyDocument(),
      }),
    ).toBe("unthemed");
  });

  it("counts a source on the shared defaults as a match with nothing to copy", () => {
    expect(
      resolveVariationThemeState({
        sourceDoc: createStarterDocument(),
        targetDoc: createEmptyDocument(),
      }),
    ).toBe("source-theme");
  });

  it("tells a DELIBERATELY varied theme apart from a failed seed", () => {
    /*
      Both leave the target wearing something other than the source's theme,
      and the model must be told opposite things about them: keep the recolour
      in one, undo it in the other. Distinguishing them is the whole reason
      this returns three states instead of a boolean.
    */
    expect(
      resolveVariationThemeState({
        sourceDoc: createPersonalSourceDocument(),
        targetDoc: createTargetDocument({ emailBackgroundColor: "#f1e8da" }),
      }),
    ).toBe("varied-theme");
  });

  it("counts a themed draft built from an UNTHEMED source as varied", () => {
    /*
      Varying works against the shared defaults too — the picker offers kit
      themes to a source that has none, and "nothing to copy" would be wrong.
    */
    expect(
      resolveVariationThemeState({
        sourceDoc: createStarterDocument(),
        targetDoc: createTargetDocument({ emailBackgroundColor: "#0b1120" }),
      }),
    ).toBe("varied-theme");
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
    /*
      Same part type, different instance: a thread that has already run a
      generation must not pay for that brief on every later message.
    */
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

describe("countSourceSections", () => {
  it("counts the source's top-level sections — the number the brief states", () => {
    /*
      The owner's requirement is a COUNT ("roughly the same number of sections
      as the previous email draft did"), and the server holds the document, so
      it can say the number instead of hoping for it.
    */
    expect(countSourceSections(createPersonalSourceDocument())).toBe(2);
  });

  it("reports zero for a blank draft, which is the fallback-target signal", () => {
    expect(countSourceSections(createEmptyDocument())).toBe(0);
  });
});

describe("buildIdeateDraftPrompt", () => {
  const promptInput = {
    sourceDraftName: "Launch email",
    sourceOutline: '1. text "Welcome"; button "Get started"',
    sourceSectionCount: 5,
    direction: "",
  };

  it("carries the source draft's name and outline", () => {
    const prompt = buildIdeateDraftPrompt(promptInput);
    expect(prompt).toContain(promptInput.sourceDraftName);
    expect(prompt).toContain(promptInput.sourceOutline);
  });

  it("asks for the source's SUBJECT in fresh words, not its sentences", () => {
    /*
      The tension this path lives with: the outline is clipped to 60 chars so
      ideate invents rather than paraphrases, while the owner asked it to
      "base the new text content off of the existing text content". Resolved by
      changing the ASK, not the clip — carry the meaning, write the copy.
    */
    const prompt = buildIdeateDraftPrompt(promptInput);
    expect(prompt).toMatch(/SAME SUBJECT, FRESH WORDS/);
    expect(prompt).toMatch(/CLIPPED on purpose/i);
    expect(prompt).toMatch(/not inventing a different company, product or campaign/i);
  });

  it("asks for variants of the SECTION TYPES the source uses, plus a new layout and a restyle", () => {
    /*
      The three remaining defaults the owner said a user should not have to
      type ("try various layouts", "make style updates", "try different
      variants of the sections that exist in the source draft").
    */
    const prompt = buildIdeateDraftPrompt(promptInput);
    expect(prompt).toMatch(/RIFF ON THE SECTIONS IT HAS/);
    expect(prompt).toMatch(/TRY A DIFFERENT LAYOUT/);
    expect(prompt).toMatch(/RESTYLE IT/);
  });

  it("states the source-parity target as a number", () => {
    expect(buildIdeateDraftPrompt(promptInput)).toContain(
      '"Launch email" has 5 sections, so build about 5',
    );
  });

  it("falls back to a whole-email target when the source has no sections to match", () => {
    const prompt = buildIdeateDraftPrompt({ ...promptInput, sourceSectionCount: 0 });
    expect(prompt).toMatch(/about 5 sections/);
    expect(prompt).toMatch(/One or two sections is not an email/);
  });

  it("drops the floor warning on a source too small to fall short of", () => {
    /*
      "Build about 2" and "one or two sections is a failure" cannot both be
      said about the same draft — the warning is only meaningful when there is
      room under the target.
    */
    const prompt = buildIdeateDraftPrompt({ ...promptInput, sourceSectionCount: 2 });
    expect(prompt).toContain('"Launch email" has 2 sections, so build about 2');
    expect(prompt).not.toMatch(/comes back as one or two sections/);
  });

  it("asks for every section in ONE response — the actual fix for one-section drafts", () => {
    /*
      The defect is arithmetic: one content op per response × a
      continuation ceiling of 1 is a two-op turn. Ops per RESPONSE is the only
      lever that does not cost another ~20k-token round.
    */
    const prompt = buildIdeateDraftPrompt(promptInput);
    expect(prompt).toMatch(/SEND EVERY SECTION IN ONE RESPONSE/);
    expect(prompt).toMatch(/one tool call per section, in reading order/i);
  });

  it("quotes the person's direction and lets it outrank the built-in defaults", () => {
    const prompt = buildIdeateDraftPrompt({
      ...promptInput,
      direction: "  aim it at first-time attendees  ",
    });
    expect(prompt).toContain('"aim it at first-time attendees"');
    expect(prompt).toMatch(/outranks the defaults/i);
  });

  it("says nothing about a direction when the person gave none", () => {
    expect(buildIdeateDraftPrompt({ ...promptInput, direction: "   " })).not.toMatch(
      /The person asked for this specifically/i,
    );
  });

  it("omits the context block when the source is blank", () => {
    const prompt = buildIdeateDraftPrompt({
      ...promptInput,
      sourceDraftName: "Draft 1",
      sourceOutline: "",
      sourceSectionCount: 0,
    });
    expect(prompt).not.toContain("Draft 1");
    expect(prompt).toMatch(/from scratch in this blank draft/i);
  });
});

describe("buildDesignVariationPrompt", () => {
  const themedInput = {
    sourceDraftName: "Launch email",
    sourceBrief: buildVariationBrief(createPersonalSourceDocument()),
    sourceSectionCount: 6,
    themeState: "source-theme" as const,
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
    /*
      The regression under repair: the old prompt invited a relook.
    */
    expect(prompt).not.toMatch(/different theme or visual feel/i);
  });

  it("never tells the agent to restore the source's colours over a VARIED theme", () => {
    /*
      The failure this pins is a prompt that fights its own seed: the draft has
      deliberately been given another of the kit's themes, so both of the older
      sentences — "the theme from X is already applied, keep it" and "match the
      look and feel of X" — would read as an instruction to put the source's
      colours back, undoing the variation the person asked for.
    */
    const prompt = buildDesignVariationPrompt({ ...themedInput, themeState: "varied-theme" });
    expect(prompt).not.toMatch(/theme from "Launch email"/i);
    expect(prompt).not.toMatch(/Match the look and feel/i);
    expect(prompt).toMatch(/DIFFERENT theme/);
    expect(prompt).toMatch(/part of the variation/i);
    /*
      Still KEEP: the seeded theme is a real kit variation this draft is now an
      instance of, and re-picking colours would detach it.
    */
    expect(prompt).toMatch(/Keep it exactly as it is/);
  });

  it("asks the agent to match the source's look when the theme could not be seeded", () => {
    const prompt = buildDesignVariationPrompt({ ...themedInput, themeState: "unthemed" });
    expect(prompt).toMatch(/Match the look and feel/i);
    expect(prompt).not.toMatch(/already applied/i);
  });

  it("holds the CONTENT fixed and names the structural moves that are free", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/KEEP THE WORDS/);
    expect(prompt).toMatch(/CHANGE THE STRUCTURE/);
    /*
      Concrete moves, not "rework the layout".
    */
    expect(prompt).toMatch(/side-by-side columns/i);
    expect(prompt).toMatch(/how many sections/i);
    expect(prompt).toMatch(/MOVE THE IMAGERY/);
    expect(prompt).toMatch(/full width and much larger/i);
  });

  it("names the HERO move outright — it was only implied before", () => {
    /*
      The owner's stated goal is visual appeal, and "make one thing
      prominent" was reachable only through "leading the email … or full width
      and much larger". Naming it is cheap and concrete.
    */
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/CONSIDER LEADING WITH A HERO/);
    expect(prompt).toMatch(/a single image and the main headline carry the whole width/i);
  });

  it("offers the asset library as a SECOND image source, behind the source's own", () => {
    /*
      The genuinely new capability, in the owner's own priority order: source
      images are known-relevant, library images are a guess from a filename.
      Getting this backwards would swap unrelated pictures into variations,
      which is a worse failure than the one being fixed.
    */
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/IMAGE LIBRARY IS AVAILABLE, SECOND/);
    expect(prompt).toMatch(/listAssets/);
    /*
      Name-based selection is the accepted limitation; kind is the coarse
      filter that is already there and costs nothing.
    */
    expect(prompt).toMatch(/Pick by the NAME/);
    expect(prompt).toMatch(/"Logo" for a brand mark/);
    /*
      And the refusal: no plausible match means no library image at all.
    */
    expect(prompt).toMatch(/use none of it/i);
  });

  it("states the source-parity target as a number the model can aim at", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toContain('"Launch email" has 6 sections, so build about 6');
    /*
      "Roughly" has to stay roughly: this same prompt asks the model to split,
      fold, and add sections, so a hard equality would fight the feature.
    */
    expect(prompt).toMatch(/give or take one or two/);
    expect(prompt).toMatch(/Going over is fine/);
  });

  it("asks for every section in ONE response — the actual fix for one-section drafts", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/SEND EVERY SECTION IN ONE RESPONSE/);
    /*
      The clause that keeps this compatible with the static prompt's
      per-section streaming rule: one call per section either way.
    */
    expect(prompt).toMatch(/one tool call per section, in reading order/i);
    expect(prompt).toMatch(/each section appears on the canvas the moment its own call completes/i);
  });

  it("frames the brief as what the email SAYS, not how it is arranged", () => {
    const prompt = buildDesignVariationPrompt(themedInput);
    expect(prompt).toMatch(/is what "Launch email" SAYS/);
    expect(prompt).toMatch(/the arrangement it happens to be in right now is the one thing/i);
    /*
      The brief's ids belong to the SOURCE draft; this turn is pinned to an
      empty one, so anchoring a section to them would fail.
    */
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
    /*
      The fail-soft path: an unreadable source leaves the person's own
      sentence to carry the turn, and the instructions still have to stand up.
    */
    const prompt = buildDesignVariationPrompt({ ...themedInput, sourceBrief: "" });
    expect(prompt).toMatch(/KEEP THE WORDS/);
    expect(prompt).not.toMatch(/is what "Launch email" SAYS/);
  });
});
