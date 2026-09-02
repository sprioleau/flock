// @vitest-environment edge-runtime
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import {
  applyOperations,
  buildComposedDrafts,
  createEmptyDocument,
  emailDocumentSchema,
  resolveCreateDraftCommand,
  type CreateDraftInput,
  type EmailDocument,
  type GlobalStyles,
  type NamedTheme,
  type PageTheme,
} from "@flock/email-sdk";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { toCreateDraftToolOutput } from "@/lib/create-draft-report";
import { createAgentDrafts, type AgentDraftsConvexClient } from "./create-agent-drafts";

/*
  THE CAPTURED FAILURE, reproduced against the real Convex functions.

  The owner typed: "create a new draft based on my portfolio website:
  sprioleau.dev. Pull in the images and details about me." Two green tool
  chips — the page WAS read — then a new draft that contained none of it, and
  an agent reply claiming it was "built directly from your website details".

  A CORRECTION TO THE ORIGINAL DIAGNOSIS, worth writing down. The report's
  decisive evidence was that the new draft's "A note from the team" paragraph
  was character-identical to the Draft 1 beside it. It is — but that string is
  the ARTICLE TEMPLATE'S OWN DEFAULT HEADLINE
  (packages/email-sdk/src/sections/templates/article.ts), as are "Ship email
  your whole team loves" (hero-split) and the Fast/Flexible/On brand columns
  (feature-columns). Draft 1 was the stock starter, so both drafts show the
  same template defaults and the identity proves nothing about carry-over. The
  captured draft is fully explained by an under-filled plan alone.

  The carry-over defect is real all the same, and is reproduced below with
  sentinel strings that CANNOT come from a template: the composer backfills
  params the model left out from the SOURCE draft's own copy, which is right
  for "make another version of this" and silently wrong the moment the content
  came from somewhere else. Both failures produce the same user-visible
  result — an email that is not about what was asked for — and only one of
  them is honest about it, since sample copy reads as sample copy while the
  user's own prose reads as deliberate.

  So these tests drive `createAgentDrafts` end to end in convex-test's
  in-memory backend — real createDocument, real applyOperations — and then
  RE-READ the stored document and look at its words. A return value saying
  "created" over a document full of the wrong paragraphs is precisely the
  failure being fixed, so nothing here trusts a return value about content.

  NOT PROVABLE HERE, and deliberately not claimed: that the model then says
  the right sentence. The mock model's `sendAutomaticallyWhen` returns false
  (use-flock-chat.ts), so on a mock run the model never receives a tool result
  at all. What IS pinned below is the payload the browser hands it.
*/

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

function createBackend() {
  const backend = convexTest(schema, modules);
  registerProsemirrorSync(backend);
  return backend;
}

type Backend = ReturnType<typeof createBackend>;

const BROWSER_SESSION_ID = "8c2e5a71-64b0-4f18-9d3a-1b7e0c4f9a26";
const CHAT_ID = "chat_2f9b";

/*
  Sentinels, not the starter email's real copy. The point of the test is that
  the SOURCE draft's words must not appear in the NEW draft, and phrases like
  "Get started" collide with the section catalog's own defaults — a collision
  would make the assertion pass or fail for the wrong reason. These strings
  can only have come from the source.
*/
const SOURCE_HEADLINE = "Draft 1 headline about the spring wholesale launch";
const SOURCE_BODY = "Draft 1's own paragraph, which no other draft should ever repeat.";
const SOURCE_LATER_HEADLINE = "A note from the team, as Draft 1 words it";
const SOURCE_LATER_BODY = "The supporting paragraph Draft 1 carries in its second section.";
const SOURCE_STRINGS = [SOURCE_HEADLINE, SOURCE_BODY, SOURCE_LATER_HEADLINE, SOURCE_LATER_BODY];

/*
  The model's own copy for the ONE section it bothered to fill in.
*/
const PORTFOLIO_HEADLINE = "Hi, I'm San'Quan Prioleau";
const PORTFOLIO_BODY = "Staff Software Engineer, writing about the web from Atlanta.";

/*
  Deterministic ids so a composed document is byte-stable across runs.
*/
function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/*
  The draft the user is looking at — built through the composer itself with
  every param spelled out, so it is a real email whose exact copy is known.
*/
function buildSourceDoc(): EmailDocument {
  const [composed] = buildComposedDrafts({
    sourceDoc: createEmptyDocument(),
    command: resolveCreateDraftCommand({
      drafts: [
        {
          name: "Draft 1",
          sections: [
            { templateId: "header", params: { brandName: "Draft One Co" } },
            {
              templateId: "hero",
              params: { headline: SOURCE_HEADLINE, body: SOURCE_BODY },
            },
            {
              templateId: "article",
              params: { headline: SOURCE_LATER_HEADLINE, body: SOURCE_LATER_BODY },
            },
            /*
              A real company name, because composition now DROPS a section
              nothing fills. A paramless footer would leave this source three
              sections long, which silently collapses the supporting-copy
              window every carry-over assertion below depends on.
            */
            { templateId: "footer", params: { companyName: "Draft One Co" } },
          ],
        },
      ],
    }),
    random: createSeededRandom(11),
  });
  /*
    Applied through the SDK's own op applier rather than assembled by hand, so
    the source is a document the editor could really be showing.
  */
  const result = applyOperations(createEmptyDocument(), composed?.ops ?? []);
  if (!result.isOk) {
    throw new Error(`source draft ops rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.doc;
}

/*
  The under-filled plan the model actually sent: one headline, nothing else.
*/
const UNDER_FILLED_PORTFOLIO_PLAN: CreateDraftInput = {
  drafts: [
    {
      name: "San'Quan Prioleau - Portfolio",
      sections: [
        { templateId: "header" },
        /*
          The hero carries BOTH the params it requires, so it survives and the
          model's own copy is still observable. The other three are left empty
          on purpose: that is the under-filling this fixture exists to model,
          and composition now drops them rather than inventing their copy.
        */
        { templateId: "hero", params: { headline: PORTFOLIO_HEADLINE, body: PORTFOLIO_BODY } },
        { templateId: "article" },
        { templateId: "footer" },
      ],
    },
  ],
};

/*
  Every word the stored document renders — text, button labels, image alts.
*/
function readAllText(doc: EmailDocument): string {
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

async function readStoredText({
  t,
  documentId,
}: {
  t: Backend;
  documentId: Id<"documents">;
}): Promise<string> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  expect(payload).not.toBeNull();
  return readAllText(emailDocumentSchema.parse(payload!.doc));
}

async function seedCanvas(t: Backend): Promise<Id<"canvases">> {
  const { canvasId } = await t.mutation(api.documents.createDocument, {
    sessionId: BROWSER_SESSION_ID,
    name: "Draft 1",
  });
  return canvasId;
}

/*
  The page theme a turn would have read off wesbos.com — the payload the
  ingestion pipeline derives WITHOUT a model call, carried here so the tests
  can prove the draft is born wearing it rather than born on the defaults.
*/
const PAGE_THEME = {
  globals: { emailBackgroundColor: "#ffffff", buttonBackgroundColor: "#ffc600" },
  source: "accent #ffc600 (--ui-accent-1)",
  url: "https://wesbos.com/about",
};

const KIT_THEMES = [
  {
    id: "midnight",
    name: "Midnight",
    globals: { emailBackgroundColor: "#101014", paragraphTextColor: "#f5f5f5" },
  },
];

async function runCreateDraft({
  t,
  hasIngestedSource,
  input = UNDER_FILLED_PORTFOLIO_PLAN,
  pageTheme = null,
  kitThemes = KIT_THEMES,
  sourceGlobals = null,
}: {
  t: Backend;
  hasIngestedSource: boolean;
  input?: CreateDraftInput;
  pageTheme?: PageTheme | null;
  kitThemes?: NamedTheme[];
  sourceGlobals?: GlobalStyles | null;
}) {
  const convexClient: AgentDraftsConvexClient = t;
  const canvasId = await seedCanvas(t);
  const outcome = await createAgentDrafts({
    convexClient,
    canvasId,
    sessionId: BROWSER_SESSION_ID,
    command: resolveCreateDraftCommand(input),
    sourceDoc: buildSourceDoc(),
    hasIngestedSource,
    authorId: CHAT_ID,
    pageTheme,
    kitThemes,
    sourceGlobals,
  });
  return outcome;
}

/*
  The globals a stored draft ended up wearing.
*/
async function readStoredGlobals({
  t,
  documentId,
}: {
  t: Backend;
  documentId: Id<"documents">;
}): Promise<GlobalStyles> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  expect(payload).not.toBeNull();
  const doc = emailDocumentSchema.parse(payload!.doc);
  const root = doc.root;
  expect(root.type).toBe("root");
  return root.type === "root" ? (root.properties.globals ?? {}) : {};
}

/*
  THE SECOND CAPTURED FAILURE, and the one this whole theme change exists for.

  A live turn read wesbos.com/about, the pipeline derived the page's theme
  correctly (accent #ffc600, canvas left white) — and the draft it created came
  back with `globals: {}`. The model called readWebPage and createDraft and
  never applied the theme.

  It was RIGHT not to, which is the part worth stating. The only theming tool
  it had was `applyTheme`, a content op with no document target, so it applies
  to the turn's own document — the draft the user was looking at. Applying the
  page's theme would have repainted their draft while leaving the new one
  bare. There was no expressible form of "theme the draft you are making", and
  no amount of prompt insistence could have produced one.

  These tests read the STORED document's globals, not the return value, for
  the same reason the copy tests above read its words.
*/
describe("a new draft's theme", () => {
  it("is born wearing the theme the call named, off a source draft that has none", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({
      t,
      hasIngestedSource: true,
      input: { ...UNDER_FILLED_PORTFOLIO_PLAN, theme: "page" },
      pageTheme: PAGE_THEME,
    });

    expect(outcome.failureNotice).toBeNull();
    const globals = await readStoredGlobals({ t, documentId: outcome.createdDocumentIds[0]! });
    expect(globals).toEqual(PAGE_THEME.globals);
  });

  /*
    The regression in its exact captured shape: the same call WITHOUT the
    theme reference still lands on `{}`. Pinned so the fix cannot be mistaken
    for "drafts are themed now" — inheritance is unchanged, and an unthemed
    source still yields an unthemed draft.
  */
  it("stays on the shared defaults when the call names no theme", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({ t, hasIngestedSource: true, pageTheme: PAGE_THEME });
    const globals = await readStoredGlobals({ t, documentId: outcome.createdDocumentIds[0]! });
    expect(globals).toEqual({});
  });

  it("wears a named kit theme, and its NAME resolves to that theme's own colours", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({
      t,
      hasIngestedSource: false,
      input: { ...UNDER_FILLED_PORTFOLIO_PLAN, theme: "Midnight" },
    });
    const globals = await readStoredGlobals({ t, documentId: outcome.createdDocumentIds[0]! });
    expect(globals).toEqual(KIT_THEMES[0]!.globals);
  });

  /*
    A theme name that does not exist must NOT take the draft down with it: the
    model may not retry createDraft (a retry makes a second draft), so a
    failure here would leave the user with nothing over a typo. The draft is
    created, wearing what it would have worn, and the report says the theme
    was not applied and names the ones that are.
  */
  it("still creates the draft when the named theme does not exist, and says so", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({
      t,
      hasIngestedSource: false,
      input: { ...UNDER_FILLED_PORTFOLIO_PLAN, theme: "Neon" },
      sourceGlobals: { emailBackgroundColor: "#101014" },
    });

    expect(outcome.createdDocumentIds).toHaveLength(1);
    const globals = await readStoredGlobals({ t, documentId: outcome.createdDocumentIds[0]! });
    /*
      Inheritance stood, as it would have without the reference at all.
    */
    expect(globals).toEqual({});
    const note = toCreateDraftToolOutput(outcome).note;
    expect(note).toContain("was NOT applied");
    expect(note).toContain("Midnight");
  });

  /*
    A page read three turns ago is not this turn's page. The resolver can only
    answer with what the CALLER hands it, so a caller with no page theme makes
    "page" unanswerable — reported, never substituted with something else.
  */
  it("cannot resolve the page theme when this turn read no page", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({
      t,
      hasIngestedSource: false,
      input: { ...UNDER_FILLED_PORTFOLIO_PLAN, theme: "page" },
      pageTheme: null,
    });
    const globals = await readStoredGlobals({ t, documentId: outcome.createdDocumentIds[0]! });
    expect(globals).toEqual({});
    expect(toCreateDraftToolOutput(outcome).note).toContain("no page was read this turn");
  });
});

describe("a draft composed in a turn that ingested a source", () => {
  it("does not inherit the source draft's copy", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({ t, hasIngestedSource: true });

    expect(outcome.failureNotice).toBeNull();
    expect(outcome.createdDocumentIds).toHaveLength(1);
    const text = await readStoredText({ t, documentId: outcome.createdDocumentIds[0]! });

    /*
      THE REPORTED BUG IN ONE ASSERTION. Before the fix the new draft's
      article section carried SOURCE_LATER_HEADLINE / SOURCE_LATER_BODY
      verbatim and its header carried the source's brand — the user's own
      words, presented as an email built from their website.
    */
    for (const sourceString of SOURCE_STRINGS) {
      expect(text).not.toContain(sourceString);
    }
    /*
      The copy the model DID write is still there — the fix suppresses the backfill, not the plan.
    */
    expect(text).toContain(PORTFOLIO_HEADLINE);
  });

  /*
    This used to assert the sections were "showing SAMPLE text". That outcome
    is now impossible: composition refuses to let a template's `.default()`
    stand in as content. The GUARANTEE the test was written for is unchanged —
    a partial outcome must be reported as partial, never claimed as whole — so
    it now pins the shortfall that actually happens, which is that the sections
    are not in the draft at all. Left claiming nothing, the model would happily
    describe an article and a footer that do not exist.
  */
  it("reports the sections it left out instead of claiming them", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({ t, hasIngestedSource: true });

    expect(outcome.createdDrafts).toHaveLength(1);
    const [draft] = outcome.createdDrafts;
    expect(draft).toMatchObject({
      name: "San'Quan Prioleau - Portfolio",
      plannedSectionCount: 1,
      carriedOverSectionCount: 0,
    });
    /*
      header, article and footer had no copy in the plan, and none of them survived.
    */
    expect(draft!.droppedSectionCount).toBe(3);
    /*
      Nothing was invented to fill them — that is the whole point.
    */
    expect(draft!.templateDefaultSectionCount).toBe(0);

    /*
      The sentence the model is entitled to say. A partial outcome rides the
      SUCCESS channel: `isCreated` is true, and the note carries the shortfall
      plus the instruction not to try again.
    */
    const output = toCreateDraftToolOutput(outcome);
    expect(output.isCreated).toBe(true);
    expect(output.createdDrafts.map((created) => created.name)).toEqual([
      "San'Quan Prioleau - Portfolio",
    ]);
    expect(output.note).toContain("NOT in the draft");
    expect(output.note).not.toContain("SAMPLE text");
    expect(output.note).toContain("Do NOT call createDraft again");
  });
});

describe("a draft composed in an ordinary turn", () => {
  it("still continues the draft the user is looking at", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({ t, hasIngestedSource: false });

    expect(outcome.failureNotice).toBeNull();
    const text = await readStoredText({ t, documentId: outcome.createdDocumentIds[0]! });

    /*
      The carry-over is CORRECT behaviour for "make me a variation of this" —
      the drafts menu's own AI flow depends on it. Deleting it would have been
      the easy fix and the wrong one.
    */
    expect(text).toContain(SOURCE_LATER_HEADLINE);
    expect(outcome.createdDrafts[0]!.carriedOverSectionCount).toBeGreaterThan(0);
  });
});

describe("what createDraft reports back", () => {
  it("reports the drafts bar's real names, not the ones the model asked for", async () => {
    const t = createBackend();
    const convexClient: AgentDraftsConvexClient = t;
    const canvasId = await seedCanvas(t);
    /*
      A draft already carrying the name the model is about to ask for.
    */
    await t.mutation(api.documents.createDocument, {
      sessionId: BROWSER_SESSION_ID,
      canvasId,
      name: "Portfolio",
    });

    const outcome = await createAgentDrafts({
      convexClient,
      canvasId,
      sessionId: BROWSER_SESSION_ID,
      command: resolveCreateDraftCommand({
        drafts: [{ name: "Portfolio", sections: [{ templateId: "hero" }] }],
      }),
      sourceDoc: buildSourceDoc(),
      hasIngestedSource: true,
      authorId: CHAT_ID,
      pageTheme: null,
      kitThemes: KIT_THEMES,
      sourceGlobals: null,
    });

    const [created] = outcome.createdDrafts;
    expect(created!.name).not.toBe("Portfolio");
    /*
      The model quotes what the note says, and the note says what exists.
    */
    expect(toCreateDraftToolOutput(outcome).note).toContain(created!.name);
  });

  it("calls an empty-starter run empty rather than describing content", async () => {
    const t = createBackend();
    const convexClient: AgentDraftsConvexClient = t;
    const canvasId = await seedCanvas(t);

    const outcome = await createAgentDrafts({
      convexClient,
      canvasId,
      sessionId: BROWSER_SESSION_ID,
      command: resolveCreateDraftCommand({ count: 2 }),
      sourceDoc: buildSourceDoc(),
      hasIngestedSource: false,
      authorId: CHAT_ID,
      pageTheme: null,
      kitThemes: KIT_THEMES,
      sourceGlobals: null,
    });

    expect(outcome.createdDrafts).toHaveLength(2);
    const output = toCreateDraftToolOutput(outcome);
    expect(output.note).toContain("EMPTY starter draft");
  });
});

describe("a composed draft's inbox metadata", () => {
  it("persists subject and preview text on the created draft without inventing an audience", async () => {
    const t = createBackend();
    const outcome = await runCreateDraft({
      t,
      hasIngestedSource: true,
      input: {
        drafts: [
          {
            name: "Managed agents",
            subject: "A practical guide to managed agents",
            previewText: "How to preserve the brain while replacing the hands.",
            sections: [
              {
                templateId: "article",
                params: {
                  headline: "A practical guide to managed agents",
                  body: "How to preserve the brain while replacing the hands.",
                },
              },
            ],
          },
        ],
      },
    });

    const metadata = await t.query(api.documents.getDraftEmailMeta, {
      documentId: outcome.createdDocumentIds[0]!,
      sessionId: BROWSER_SESSION_ID,
    });
    expect(metadata).toEqual({
      subject: "A practical guide to managed agents",
      previewText: "How to preserve the brain while replacing the hands.",
    });
  });
});
