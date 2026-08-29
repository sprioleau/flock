// @vitest-environment edge-runtime
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import {
  emailDocumentSchema,
  type ApplyThemeToDraftCommand,
  type GlobalStyles,
  type NamedTheme,
  type PageTheme,
} from "@flock/email-sdk";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { toApplyThemeToolOutput } from "./apply-theme-report";
import { applyThemeToDraft, type ApplyThemeConvexClient } from "./apply-theme-to-draft";

/*
  RE-THEMING A DRAFT THE USER IS NOT LOOKING AT — the capability `applyTheme`
  structurally could not provide, driven end to end against the real Convex
  functions (real listDocumentsByCanvas, real getDocument, real
  applyOperations) and verified by RE-READING the stored documents.

  Nothing here trusts a return value about which draft changed. The two
  failures the owner named are both of the "reports success while doing the
  wrong thing" family — a theme that does not actually change, and a theme
  that lands on the wrong draft — and a test that asserted only "isApplied:
  true" would pass for either. So every case reads the globals of BOTH drafts
  afterwards: the one that was meant to change, and the one that was not.
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
const OTHER_SESSION_ID = "1d0f6b42-77aa-4c31-8e55-9b2c3d4e5f60";
const CHAT_ID = "chat_2f9b";
const BATCH_ID = "batch_7c1e";

const PAGE_THEME: PageTheme = {
  globals: { emailBackgroundColor: "#ffffff", buttonBackgroundColor: "#ffc600" },
  source: "accent #ffc600 (--ui-accent-1)",
  url: "https://wesbos.com/about",
};

const MIDNIGHT_GLOBALS: GlobalStyles = {
  emailBackgroundColor: "#101014",
  paragraphTextColor: "#f5f5f5",
};

const KIT_THEMES: NamedTheme[] = [
  { id: "midnight", name: "Midnight", globals: MIDNIGHT_GLOBALS },
  {
    id: "warm-sand",
    name: "Warm Sand",
    globals: { emailBackgroundColor: "#f5efe6", paragraphTextColor: "#2b2118" },
  },
];

/** One canvas with two drafts, both on the shared defaults. */
async function seedTwoDraftCanvas(t: Backend): Promise<{
  canvasId: Id<"canvases">;
  currentDocumentId: Id<"documents">;
  otherDocumentId: Id<"documents">;
}> {
  const first = await t.mutation(api.documents.createDocument, {
    sessionId: BROWSER_SESSION_ID,
    name: "Spring sale",
  });
  const second = await t.mutation(api.documents.createDocument, {
    sessionId: BROWSER_SESSION_ID,
    canvasId: first.canvasId,
    name: "Launch v2",
  });
  return {
    canvasId: first.canvasId,
    currentDocumentId: first.documentId,
    otherDocumentId: second.documentId,
  };
}

async function readStoredGlobals({
  t,
  documentId,
}: {
  t: Backend;
  documentId: Id<"documents">;
}): Promise<GlobalStyles> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  expect(payload).not.toBeNull();
  const root = emailDocumentSchema.parse(payload!.doc).root;
  return root.type === "root" ? (root.properties.globals ?? {}) : {};
}

function run({
  t,
  canvasId,
  command,
  currentDocumentId,
  currentGlobals = null,
  pageTheme = PAGE_THEME,
  kitThemes = KIT_THEMES,
}: {
  t: Backend;
  canvasId: Id<"canvases">;
  command: ApplyThemeToDraftCommand;
  currentDocumentId: Id<"documents"> | null;
  currentGlobals?: GlobalStyles | null;
  pageTheme?: PageTheme | null;
  kitThemes?: NamedTheme[];
}) {
  const convexClient: ApplyThemeConvexClient = t;
  return applyThemeToDraft({
    convexClient,
    canvasId,
    sessionId: BROWSER_SESSION_ID,
    command,
    currentDocumentId,
    currentGlobals,
    pageTheme,
    kitThemes,
    authorId: CHAT_ID,
    batchId: BATCH_ID,
  });
}

type ListDocumentsByCanvas = typeof api.documents.listDocumentsByCanvas;
type GetDocument = typeof api.documents.getDocument;

/**
 * A client whose canvas listing OFFERS a document the canvas does not hold:
 * the real rows, plus the real rows of `staleCanvasId`.
 *
 * Spelled out with the same two overloads the production interface declares,
 * so the stub satisfies it without a cast — and so this stays a stub of that
 * exact contract rather than of a looser one that would let a real mismatch
 * through unnoticed.
 */
async function createStaleListingClient({
  t,
  staleCanvasId,
}: {
  t: Backend;
  staleCanvasId: Id<"canvases">;
}): Promise<ApplyThemeConvexClient> {
  const staleRows = await t.query(api.documents.listDocumentsByCanvas, {
    canvasId: staleCanvasId,
  });
  async function query(
    reference: ListDocumentsByCanvas,
    args: { canvasId: Id<"canvases"> },
  ): Promise<Awaited<ReturnType<Backend["query"]>>>;
  async function query(
    reference: GetDocument,
    args: { documentId: Id<"documents"> },
  ): Promise<Awaited<ReturnType<Backend["query"]>>>;
  /*
    The implementation signature ignores `reference` and re-derives it from the
    arguments. The executor's two queries are distinguishable by their args
    alone, and going through `api.documents.*` directly keeps this stub free of
    casts — the overloads above are what hold it to the production contract.
  */
  async function query(
    _reference: ListDocumentsByCanvas | GetDocument,
    args: { canvasId: Id<"canvases"> } | { documentId: Id<"documents"> },
  ) {
    if ("canvasId" in args) {
      const rows = await t.query(api.documents.listDocumentsByCanvas, args);
      return [...rows, ...staleRows];
    }
    return t.query(api.documents.getDocument, args);
  }
  return {
    query,
    mutation: (reference, args) => t.mutation(reference, args),
  };
}

describe("targeting a draft the user is not looking at", () => {
  /*
    THE CAPABILITY, and the assertion that proves it is not the old one in
    disguise: the NAMED draft's globals change AND the current draft's do not.
    Drop the second half and this test passes for the exact bug it exists to
    catch — `applyTheme` painting the turn's own document.
  */
  it("re-themes the named draft and leaves the current one alone", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId, otherDocumentId } = await seedTwoDraftCanvas(t);

    const outcome = await run({
      t,
      canvasId,
      currentDocumentId,
      command: { type: "applyThemeToDraft", theme: "page", draft: "Launch v2" },
    });

    expect(outcome.kind).toBe("applied");
    expect(outcome.kind === "applied" && outcome.draftName).toBe("Launch v2");
    expect(await readStoredGlobals({ t, documentId: otherDocumentId })).toEqual(PAGE_THEME.globals);
    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual({});
  });

  it("re-themes the CURRENT draft when no draft is named", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId, otherDocumentId } = await seedTwoDraftCanvas(t);

    await run({
      t,
      canvasId,
      currentDocumentId,
      command: { type: "applyThemeToDraft", theme: "Midnight" },
    });

    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual(MIDNIGHT_GLOBALS);
    expect(await readStoredGlobals({ t, documentId: otherDocumentId })).toEqual({});
  });

  /*
    THE AUTHORIZATION PROPERTY, against real data. The draft exists, it is
    owned by another session and sits on another canvas, and its name is
    handed to the executor verbatim. It must not change — not because a check
    rejected it, but because the only list of candidates is the drafts on the
    canvas passed in.
  */
  it("cannot reach a draft on another canvas, even by its exact name", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId } = await seedTwoDraftCanvas(t);
    const foreign = await t.mutation(api.documents.createDocument, {
      sessionId: OTHER_SESSION_ID,
      name: "Someone else's draft",
    });

    const outcome = await run({
      t,
      canvasId,
      currentDocumentId,
      command: { type: "applyThemeToDraft", theme: "page", draft: "Someone else's draft" },
    });

    expect(outcome.kind).toBe("draft-unresolved");
    expect(await readStoredGlobals({ t, documentId: foreign.documentId })).toEqual({});
    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual({});
    /* And it does not quietly fall back to the draft the user IS on. */
    expect(toApplyThemeToolOutput(outcome).isApplied).toBe(false);
  });

  /*
    THE SECOND LOCK, which no tool call can reach — so it is driven directly.

    `listDocumentsByCanvas` is the candidate list AND the authorization
    boundary, so a document from another canvas can only get past it if the
    listing itself is wrong: a stale cache, or a document moved between the
    listing and the write. The lock exists for that window, and an untested
    lock is a lock nobody will notice deleting.
  */
  it("refuses a listed document that turns out to be on another canvas", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId } = await seedTwoDraftCanvas(t);
    const foreign = await t.mutation(api.documents.createDocument, {
      sessionId: OTHER_SESSION_ID,
      name: "Moved away",
    });
    const lyingClient = await createStaleListingClient({ t, staleCanvasId: foreign.canvasId });

    const outcome = await applyThemeToDraft({
      convexClient: lyingClient,
      canvasId,
      sessionId: BROWSER_SESSION_ID,
      command: { type: "applyThemeToDraft", theme: "page", draft: "Moved away" },
      currentDocumentId,
      currentGlobals: null,
      pageTheme: PAGE_THEME,
      kitThemes: KIT_THEMES,
      authorId: CHAT_ID,
      batchId: BATCH_ID,
    });

    expect(outcome).toMatchObject({ kind: "draft-unresolved" });
    expect(await readStoredGlobals({ t, documentId: foreign.documentId })).toEqual({});
    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual({});
  });

  it("refuses, and writes nothing, when two drafts share the named name", async () => {
    const t = createBackend();
    const first = await t.mutation(api.documents.createDocument, {
      sessionId: BROWSER_SESSION_ID,
      name: "Launch",
    });
    const second = await t.mutation(api.documents.createDocument, {
      sessionId: BROWSER_SESSION_ID,
      canvasId: first.canvasId,
      name: "Launch",
    });

    const outcome = await run({
      t,
      canvasId: first.canvasId,
      currentDocumentId: first.documentId,
      command: { type: "applyThemeToDraft", theme: "page", draft: "Launch" },
    });

    expect(outcome).toMatchObject({ kind: "draft-unresolved", reason: "ambiguous-draft" });
    expect(await readStoredGlobals({ t, documentId: first.documentId })).toEqual({});
    expect(await readStoredGlobals({ t, documentId: second.documentId })).toEqual({});
  });
});

describe("resolving the theme", () => {
  it("applies the PAGE's own colours, not the current draft's", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId, otherDocumentId } = await seedTwoDraftCanvas(t);

    await run({
      t,
      canvasId,
      currentDocumentId,
      currentGlobals: MIDNIGHT_GLOBALS,
      command: { type: "applyThemeToDraft", theme: "page", draft: "Launch v2" },
    });

    const globals = await readStoredGlobals({ t, documentId: otherDocumentId });
    expect(globals).toEqual(PAGE_THEME.globals);
    expect(globals).not.toEqual(MIDNIGHT_GLOBALS);
  });

  /*
    A NAME THE CANVAS DOES NOT OFFER WRITES NOTHING. This is where a soft-
    deleted theme lands: the caller filters it out of `kitThemes`, so it is not
    a candidate, and a draft can never be left wearing a theme its kit no
    longer has.
  */
  it("writes nothing when the theme name is not one this canvas offers", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId } = await seedTwoDraftCanvas(t);

    const outcome = await run({
      t,
      canvasId,
      currentDocumentId,
      kitThemes: [KIT_THEMES[1]!],
      command: { type: "applyThemeToDraft", theme: "Midnight" },
    });

    expect(outcome).toMatchObject({ kind: "theme-unresolved", reason: "unknown-theme" });
    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual({});
    const note = toApplyThemeToolOutput(outcome).note;
    expect(note).toContain('"Warm Sand"');
    expect(note).toContain("NEVER pass a colour value");
  });

  it("writes nothing, and says so, when this turn read no page", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId } = await seedTwoDraftCanvas(t);

    const outcome = await run({
      t,
      canvasId,
      currentDocumentId,
      pageTheme: null,
      command: { type: "applyThemeToDraft", theme: "page" },
    });

    expect(outcome).toMatchObject({ kind: "theme-unresolved", reason: "no-page-theme" });
    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual({});
  });

  /*
    A HEX VALUE IS NOT A THEME. The house rule, driven all the way to the
    document: a model that ignores every instruction and passes a colour gets
    a refusal and an unchanged draft, not a re-theme in a colour nobody chose.
  */
  it("refuses a colour value outright and leaves every draft untouched", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId, otherDocumentId } = await seedTwoDraftCanvas(t);

    const outcome = await run({
      t,
      canvasId,
      currentDocumentId,
      command: { type: "applyThemeToDraft", theme: "#ffc600" },
    });

    expect(outcome.kind).toBe("theme-unresolved");
    expect(await readStoredGlobals({ t, documentId: currentDocumentId })).toEqual({});
    expect(await readStoredGlobals({ t, documentId: otherDocumentId })).toEqual({});
  });
});

describe("a draft that is already wearing the theme", () => {
  /*
    THE QUIETEST FAILURE MODE, and the one "a theme was applied" reports
    identically to a real apply: nothing changes, and the agent says it did
    something. It has to be observable — no op written, and a report that
    says nothing changed.
  */
  it("writes no second op and reports that nothing changed", async () => {
    const t = createBackend();
    const { canvasId, currentDocumentId } = await seedTwoDraftCanvas(t);
    const command: ApplyThemeToDraftCommand = { type: "applyThemeToDraft", theme: "Midnight" };

    const first = await run({ t, canvasId, currentDocumentId, command });
    expect(first.kind).toBe("applied");
    const versionAfterFirst = (await t.query(api.documents.getDocument, {
      documentId: currentDocumentId,
    }))!.headVersion;

    const second = await run({ t, canvasId, currentDocumentId, command });

    expect(second).toMatchObject({ kind: "already-applied", draftName: "Spring sale" });
    /* No op was written: the draft's history is exactly where it was. */
    const versionAfterSecond = (await t.query(api.documents.getDocument, {
      documentId: currentDocumentId,
    }))!.headVersion;
    expect(versionAfterSecond).toBe(versionAfterFirst);

    const report = toApplyThemeToolOutput(second);
    expect(report.isApplied).toBe(false);
    expect(report.note).toContain("ALREADY wearing that theme");
  });
});

describe("the report", () => {
  it("names the draft that changed and the signals the page theme came from", () => {
    const note = toApplyThemeToolOutput({
      kind: "applied",
      draftName: "Launch v2",
      themeName: "https://wesbos.com/about",
      themeSource: "page",
      derivedFrom: "accent #ffc600 (--ui-accent-1)",
    }).note;
    expect(note).toContain('"Launch v2"');
    expect(note).toContain("accent #ffc600 (--ui-accent-1)");
  });

  /*
    A connection failure is NOT "that draft does not exist". Telling the model
    a name is wrong when nothing was ever checked sends it off to correct
    something that was never broken — a fabrication of exactly the kind this
    reporting layer exists to prevent.
  */
  it("does not turn an unreachable backend into a missing draft", () => {
    const note = toApplyThemeToolOutput({ kind: "unreachable" }).note;
    expect(note).toContain("connection error");
    expect(note).not.toContain("is not a theme that exists");
    expect(note).not.toContain("there is no draft called");
  });
});
