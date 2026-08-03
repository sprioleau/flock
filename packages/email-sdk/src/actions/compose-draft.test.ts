import { describe, expect, it } from "vitest";
import { applyOperations } from "../operations/apply";
import { getSectionTemplate } from "../sections/catalog";
import { ROOT_BLOCK_ID } from "../schema/ids";
import {
  createEmptyDocument,
  createStarterDocument,
  type EmailDocument,
} from "../store/document";
import {
  buildComposedDrafts,
  completeDraftSections,
  createDraftInputSchema,
  deriveDraftContentClues,
  diversifyDraftSections,
  resolveCreateDraftCommand,
  type CreateDraftCommand,
  type DraftSectionPlan,
} from "./compose-draft";

/**
 * The create-draft composition primitive: a plan the model can actually
 * express content in, translated deterministically into a complete email.
 *
 * The bar these tests hold the primitive to is the owner's report:
 * every new draft is a whole sendable email (header + body + footer), it keeps
 * the theme already on screen, it continues the current draft's subject matter
 * instead of starting from placeholder copy, several drafts in one call really
 * differ, and none of it touches the draft the user is on.
 */

/** Deterministic id source so composed documents are byte-stable in tests. */
function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function composeOne(command: CreateDraftCommand, sourceDoc: EmailDocument): EmailDocument {
  const [composed] = buildComposedDrafts({
    sourceDoc,
    command,
    random: createSeededRandom(7),
  });
  const result = applyOperations(createEmptyDocument(), composed!.ops);
  expect(result.isOk).toBe(true);
  if (!result.isOk) {
    throw new Error("compose failed");
  }
  return result.doc;
}

function getSectionCategories(doc: EmailDocument): (string | undefined)[] {
  // The composed doc's sections are catalog-built; identify each by matching
  // its rendered subtree back to nothing — instead we assert on the ops.
  return doc[ROOT_BLOCK_ID]!.childrenIds.map((id) => doc[id]?.type);
}

function getAllText(doc: EmailDocument): string {
  const collect = (node: unknown): string => {
    if (typeof node !== "object" || node === null) return "";
    const candidate = node as { text?: unknown; content?: unknown };
    if (typeof candidate.text === "string") return candidate.text;
    if (Array.isArray(candidate.content)) return candidate.content.map(collect).join(" ");
    return "";
  };
  return Object.values(doc)
    .map((block) => {
      const properties = block.properties as Record<string, unknown>;
      if (block.type === "text") return collect(properties.text);
      if (block.type === "button") return String(properties.label ?? "");
      if (block.type === "image") return String(properties.alt ?? "");
      return "";
    })
    .join(" | ");
}

describe("createDraft input schema", () => {
  it("accepts a content plan — the shape the old count-only schema could not express", () => {
    const parsed = createDraftInputSchema.safeParse({
      drafts: [
        {
          name: "Spring sale — bold",
          sections: [
            { templateId: "header", params: { brandName: "Petal" } },
            { templateId: "hero", params: { headline: "Spring sale starts now" } },
            { templateId: "footer" },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts the bare count form", () => {
    expect(createDraftInputSchema.safeParse({ count: 3 }).success).toBe(true);
    expect(createDraftInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects templateIds that are not in the section catalog", () => {
    const parsed = createDraftInputSchema.safeParse({
      drafts: [{ sections: [{ templateId: "not-a-template" }] }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("resolveCreateDraftCommand", () => {
  it("resolves count from the plan length and defaults theme inheritance on", () => {
    const command = resolveCreateDraftCommand({
      drafts: [
        { sections: [{ templateId: "hero" }] },
        { sections: [{ templateId: "article" }] },
      ],
    });
    expect(command.count).toBe(2);
    expect(command.shouldInheritTheme).toBe(true);
    expect(command.drafts).toHaveLength(2);
  });

  it("keeps the count-only form intact (no plan)", () => {
    expect(resolveCreateDraftCommand({ count: 4 })).toEqual({
      type: "createDraft",
      count: 4,
      shouldInheritTheme: true,
    });
    expect(resolveCreateDraftCommand({}).count).toBe(1);
  });

  it("honors an explicit opt-out of theme inheritance", () => {
    expect(resolveCreateDraftCommand({ shouldInheritTheme: false }).shouldInheritTheme).toBe(false);
  });
});

describe("completeDraftSections — every draft is a whole email", () => {
  const categoriesOf = (sections: DraftSectionPlan[]): (string | undefined)[] =>
    sections.map((section) => getSectionTemplate(section.templateId)?.category);

  it("adds a header when the plan starts with a body section", () => {
    const completed = completeDraftSections([{ templateId: "hero" }, { templateId: "footer" }]);
    expect(categoriesOf(completed)).toEqual(["header", "hero", "footer"]);
  });

  it("adds a footer when the plan has none", () => {
    const completed = completeDraftSections([{ templateId: "header" }, { templateId: "cta" }]);
    expect(categoriesOf(completed)).toEqual(["header", "content", "footer"]);
  });

  it("adds a body when the plan is header + footer only", () => {
    const completed = completeDraftSections([{ templateId: "header" }, { templateId: "footer" }]);
    expect(categoriesOf(completed)).toEqual(["header", "hero", "footer"]);
  });

  it("repairs a bare one-section plan into a full email", () => {
    expect(categoriesOf(completeDraftSections([{ templateId: "testimonial" }]))).toEqual([
      "header",
      "social-proof",
      "footer",
    ]);
  });

  it("moves a stray footer to the end and keeps the model's copy", () => {
    const completed = completeDraftSections([
      { templateId: "header" },
      { templateId: "footer", params: { companyName: "Petal" } },
      { templateId: "hero", params: { headline: "Kept" } },
    ]);
    expect(categoriesOf(completed)).toEqual(["header", "hero", "footer"]);
    expect(completed.at(-1)?.params).toEqual({ companyName: "Petal" });
    expect(completed[1]?.params).toEqual({ headline: "Kept" });
  });

  it("preserves a well-formed plan verbatim", () => {
    const sections: DraftSectionPlan[] = [
      { templateId: "header-centered" },
      { templateId: "hero-split" },
      { templateId: "feature-columns" },
      { templateId: "footer-social" },
    ];
    expect(completeDraftSections(sections)).toEqual(sections);
  });
});

describe("deriveDraftContentClues", () => {
  it("reads the starter email's brand, headline, body and call to action", () => {
    const clues = deriveDraftContentClues(createStarterDocument());
    expect(clues.brandName).toBe("Acme");
    expect(clues.headline).toBe("Welcome to Acme");
    expect(clues.body).toContain("Thanks for signing up");
    expect(clues.ctaLabel).toBeDefined();
    expect(clues.ctaHref).toBeDefined();
  });

  it("returns nothing for a blank document", () => {
    expect(deriveDraftContentClues(createEmptyDocument())).toEqual({});
  });
});

describe("diversifyDraftSections", () => {
  it("leaves genuinely different plans alone", () => {
    const plans = [
      [{ templateId: "header" }, { templateId: "hero" }, { templateId: "footer" }],
      [{ templateId: "header" }, { templateId: "article" }, { templateId: "footer" }],
    ];
    expect(diversifyDraftSections(plans)).toEqual(plans);
  });

  it("pulls identical sibling plans apart into catalog counterparts", () => {
    const identical = [
      { templateId: "header" },
      { templateId: "hero" },
      { templateId: "footer" },
    ];
    const [first, second, third] = diversifyDraftSections([identical, identical, identical]);
    expect(first!.map((s) => s.templateId)).toEqual(["header", "hero", "footer"]);
    // "a plain hero in one and a split hero in another" — the owner's example.
    expect(second!.map((s) => s.templateId)).toEqual([
      "header-centered",
      "hero-split",
      "footer-social",
    ]);
    expect(third!.map((s) => s.templateId)).not.toEqual(second!.map((s) => s.templateId));
  });

  it("keeps the model's copy while swapping the shape", () => {
    const plan = [
      { templateId: "header" },
      { templateId: "hero", params: { headline: "Spring sale" } },
      { templateId: "footer" },
    ];
    const [, second] = diversifyDraftSections([plan, plan]);
    expect(second![1]).toEqual({ templateId: "hero-split", params: { headline: "Spring sale" } });
  });
});

describe("buildComposedDrafts", () => {
  const planCommand = (
    overrides: Partial<CreateDraftCommand> = {},
  ): CreateDraftCommand => ({
    type: "createDraft",
    count: 1,
    shouldInheritTheme: true,
    drafts: [
      {
        name: "Spring sale",
        sections: [
          { templateId: "header" },
          { templateId: "hero", params: { headline: "Spring sale starts now" } },
          { templateId: "footer" },
        ],
      },
    ],
    ...overrides,
  });

  it("returns no ops for the count-only form (host falls back to starter drafts)", () => {
    expect(
      buildComposedDrafts({
        sourceDoc: createStarterDocument(),
        command: { type: "createDraft", count: 3, shouldInheritTheme: true },
      }),
    ).toEqual([]);
  });

  it("builds one applyTheme + one addSection per section, in reading order", () => {
    const themed = createStarterDocument();
    themed[ROOT_BLOCK_ID] = {
      ...themed[ROOT_BLOCK_ID]!,
      properties: { globals: { emailBackgroundColor: "#101014" } },
    } as EmailDocument[string];
    const [composed] = buildComposedDrafts({
      sourceDoc: themed,
      command: planCommand(),
      random: createSeededRandom(3),
    });
    expect(composed!.name).toBe("Spring sale");
    expect(composed!.ops.map((op) => op.name)).toEqual([
      "applyTheme",
      "addSection",
      "addSection",
      "addSection",
    ]);
  });

  it("omits the theme op when the source draft has no theme of its own", () => {
    const [composed] = buildComposedDrafts({
      sourceDoc: createStarterDocument(),
      command: planCommand(),
      random: createSeededRandom(3),
    });
    expect(composed!.ops.map((op) => op.name)).toEqual([
      "addSection",
      "addSection",
      "addSection",
    ]);
  });

  it("carries the current theme into the new draft", () => {
    const themed = createStarterDocument();
    themed[ROOT_BLOCK_ID] = {
      ...themed[ROOT_BLOCK_ID]!,
      properties: {
        globals: { emailBackgroundColor: "#101014", paragraphTextColor: "#f5f5f5" },
      },
    } as EmailDocument[string];
    const doc = composeOne(planCommand(), themed);
    const root = doc[ROOT_BLOCK_ID]!;
    expect(root.type === "root" && root.properties.globals).toEqual({
      emailBackgroundColor: "#101014",
      paragraphTextColor: "#f5f5f5",
    });
  });

  it("does NOT carry the theme when inheritance is switched off", () => {
    const themed = createStarterDocument();
    themed[ROOT_BLOCK_ID] = {
      ...themed[ROOT_BLOCK_ID]!,
      properties: { globals: { emailBackgroundColor: "#101014" } },
    } as EmailDocument[string];
    const doc = composeOne(planCommand({ shouldInheritTheme: false }), themed);
    const root = doc[ROOT_BLOCK_ID]!;
    expect(root.type === "root" && root.properties.globals).toEqual({});
  });

  it("produces a complete, sendable email even from a one-section plan", () => {
    const doc = composeOne(
      {
        type: "createDraft",
        count: 1,
        shouldInheritTheme: true,
        drafts: [{ sections: [{ templateId: "hero", params: { headline: "Just this" } }] }],
      },
      createStarterDocument(),
    );
    // Header, body, footer — three top-level sections, never a bare hero.
    expect(doc[ROOT_BLOCK_ID]!.childrenIds).toHaveLength(3);
    expect(getSectionCategories(doc)).toEqual(["section", "section", "section"]);
    expect(getAllText(doc)).toContain("Just this");
  });

  it("carries the source draft's brand and call to action into unspecified params", () => {
    // A source draft with its own voice, so a carried-over value can't be
    // confused with a template default.
    const source = createStarterDocument();
    source.img_lg01 = {
      ...source.img_lg01!,
      properties: { ...source.img_lg01!.properties, alt: "Petal Studio logo" },
    } as EmailDocument[string];
    source.btn_ct01 = {
      ...source.btn_ct01!,
      properties: {
        ...source.btn_ct01!.properties,
        label: "Shop the spring drop",
        href: "https://petal.example/spring",
      },
    } as EmailDocument[string];
    const doc = composeOne(
      {
        type: "createDraft",
        count: 1,
        shouldInheritTheme: true,
        drafts: [
          {
            sections: [
              { templateId: "header" },
              { templateId: "cta", params: { headline: "Ready when you are" } },
              { templateId: "footer" },
            ],
          },
        ],
      },
      source,
    );
    const text = getAllText(doc);
    // The SOURCE draft's brand and CTA — not the templates' placeholder copy.
    expect(text).toContain("Petal Studio logo");
    expect(text).toContain("Shop the spring drop");
    expect(text).not.toContain("Acme");
    // …and the copy the model DID specify wins over the carried-over headline.
    expect(text).toContain("Ready when you are");
    expect(text).not.toContain("Welcome to Acme");
  });

  it("does not repeat the carried-over headline in every section", () => {
    const doc = composeOne(
      {
        type: "createDraft",
        count: 1,
        shouldInheritTheme: true,
        drafts: [
          {
            sections: [
              { templateId: "header" },
              { templateId: "hero" },
              { templateId: "cta" },
              { templateId: "footer" },
            ],
          },
        ],
      },
      createStarterDocument(),
    );
    const occurrences = getAllText(doc).split("Welcome to Acme").length - 1;
    expect(occurrences).toBe(1);
  });

  it("never touches the source document", () => {
    const source = createStarterDocument();
    const before = JSON.stringify(source);
    buildComposedDrafts({
      sourceDoc: source,
      command: planCommand(),
      random: createSeededRandom(3),
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("gives every composed draft in one call fresh, non-colliding block ids", () => {
    const composed = buildComposedDrafts({
      sourceDoc: createStarterDocument(),
      command: {
        type: "createDraft",
        count: 2,
        shouldInheritTheme: true,
        drafts: [
          { name: "A", sections: [{ templateId: "hero" }] },
          { name: "B", sections: [{ templateId: "hero" }] },
        ],
      },
      random: createSeededRandom(11),
    });
    for (const draft of composed) {
      const ids = draft.ops.flatMap((op) =>
        op.name === "addSection"
          ? [op.section.id, ...(op.children ?? []).map((block) => block.id)]
          : [],
      );
      expect(new Set(ids).size).toBe(ids.length);
      const result = applyOperations(createEmptyDocument(), draft.ops);
      expect(result.isOk).toBe(true);
    }
  });

  it("makes several drafts from one call structurally different", () => {
    const sections: DraftSectionPlan[] = [
      { templateId: "header" },
      { templateId: "hero", params: { headline: "One idea" } },
      { templateId: "footer" },
    ];
    const composed = buildComposedDrafts({
      sourceDoc: createStarterDocument(),
      command: {
        type: "createDraft",
        count: 3,
        shouldInheritTheme: true,
        drafts: [{ sections }, { sections }, { sections }],
      },
      random: createSeededRandom(5),
    });
    const shapes = composed.map((draft) =>
      draft.ops
        .filter((op) => op.name === "addSection")
        .map((op) =>
          op.name === "addSection" ? (op.children ?? []).map((c) => c.type).join(",") : "",
        )
        .join(" / "),
    );
    expect(new Set(shapes).size).toBe(3);
    // …without losing the essence: the headline survives every variant.
    for (const draft of composed) {
      const doc = applyOperations(createEmptyDocument(), draft.ops);
      expect(doc.isOk).toBe(true);
      if (doc.isOk) {
        expect(getAllText(doc.doc)).toContain("One idea");
      }
    }
  });

  it("falls back to template defaults when a carried-over param fails validation", () => {
    const source = createEmptyDocument();
    const doc = composeOne(
      {
        type: "createDraft",
        count: 1,
        shouldInheritTheme: true,
        drafts: [{ sections: [{ templateId: "hero", params: { ctaLabel: "" } }] }],
      },
      source,
    );
    expect(doc[ROOT_BLOCK_ID]!.childrenIds).toHaveLength(3);
  });
});
