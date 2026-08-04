// @vitest-environment edge-runtime
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";

/**
 * THE SECURITY TEST for convex/authIdentity.ts — the one that has to fail if
 * the fix is ever undone.
 *
 * The attack it encodes, end to end against the REAL Convex functions:
 *
 *   Two people open the same shared canvas. The presence roster publishes
 *   every member's `userId`, which IS their ownership key
 *   (apps/web/src/lib/presence.tsx:316). One of them copies the other's id out
 *   of the roster and replays it as the `sessionId` argument of every
 *   session-scoped function — brand kit, asset library, saved sections,
 *   personas, comments. Before this fix, that read and rewrote the victim's
 *   library. It is a scraped string with NO auth cookie behind it: the whole
 *   point is that the attacker never has to be the victim, only to quote them.
 *
 * Each adopter is asserted twice, because "refused" and "refused for the right
 * reason" are different results:
 *
 *   - STRICT (FLOCK_REQUIRE_AUTH_IDENTITY=true): a caller with no identity
 *     cannot name an owner at all, so the scraped id buys nothing.
 *   - AUTHENTICATED (auth on, strict off): a caller WITH an identity who
 *     quotes someone else's id is silently confined to their own rows — the
 *     argument is ignored, not merely rejected.
 *
 * The last block is the other half of the deal: with both flags off, every
 * one of these paths still behaves exactly as it did before auth existed. A
 * security fix that bricks the running app is not a fix.
 */

// NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
// vitest 4 (tinyglobby has no extglob support) — the array form with negative
// patterns is the equivalent that works.
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

/** The victim's ownership key, exactly as a collaborator would read it off the roster. */
const VICTIM_OWNER_ID = "user_victim";
const ATTACKER_OWNER_ID = "user_attacker";

/** A pre-auth browser's localStorage UUID — the legacy fallback key. */
const LEGACY_SESSION_ID = "8f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

const PERSONA_MARKDOWN = `---
name: Accessibility Checker
color: "#c026d3"
capabilities: advisory
cooldownSeconds: 60
description: Flags content subscribers with disabilities cannot use.
---

You are the Accessibility Checker.

What you watch for:
- Meaningful images without alt text.`;

/** The smallest subtree savedSections accepts: one childless section root. */
const SAVED_SECTION_BLOCKS = [
  { id: "sec_a1b2", type: "section", parentId: "root", childrenIds: [], properties: {} },
];

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/**
 * A backend handle bound to a caller. `withIdentity` returns a NARROWER type
 * than the root handle (it drops `withIdentity`/`registerComponent`), so
 * helpers that must accept both an anonymous `t` and an identity-bound caller
 * take this, not `Backend`.
 */
type Caller = ReturnType<Backend["withIdentity"]>;

/** A valid kit payload — the mock variations pass completeness + contrast. */
function buildKitInput(name: string) {
  return {
    name,
    fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
    variations: [
      {
        id: "classic-light",
        name: "Classic Light",
        globals: { ...MOCK_BRAND_KIT.variations[0]!.globals },
      },
    ],
  };
}

/**
 * Everything the victim owns, written by the victim. `claimedSessionId` is
 * whatever that browser happens to send; the OWNER is decided server-side, so
 * these helpers take the caller, not the key.
 */
async function seedLibrary(
  caller: Caller,
  args: { claimedSessionId: string; kitName: string },
): Promise<{
  savedSectionId: Id<"savedSections">;
  personaSlug: string;
  storageId: Id<"_storage">;
}> {
  const sessionId = args.claimedSessionId;
  await caller.mutation(api.brandKits.saveBrandKit, {
    sessionId,
    brandKit: buildKitInput(args.kitName),
  });
  const storageId = await caller.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
  );
  await caller.mutation(api.assets.register, {
    sessionId,
    storageId,
    kind: "uploaded",
    name: `${args.kitName}-hero.png`,
  });
  const { savedSectionId } = await caller.mutation(api.savedSections.save, {
    sessionId,
    name: `${args.kitName} header`,
    blocks: SAVED_SECTION_BLOCKS,
  });
  const { slug } = await caller.mutation(api.personas.createPersona, {
    sessionId,
    name: "Accessibility Checker",
    color: "#c026d3",
    cooldownSeconds: 60,
    personaMarkdown: PERSONA_MARKDOWN,
  });
  return { savedSectionId, personaSlug: slug, storageId };
}

/** The victim's kit as stored, read straight from the table (no ownership path). */
async function readStoredKitNames(t: Backend, ownerId: string): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("brandKits")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
      .collect();
    return rows.map((row) => row.name);
  });
}

async function countRowsOwnedBy(t: Backend, ownerId: string) {
  return await t.run(async (ctx) => {
    const assets = await ctx.db
      .query("assets")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
      .collect();
    const savedSections = await ctx.db
      .query("savedSections")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerId))
      .collect();
    const personas = await ctx.db
      .query("agents")
      .withIndex("by_createdBySessionId", (q) => q.eq("createdBySessionId", ownerId))
      .collect();
    return { assets: assets.length, savedSections: savedSections.length, personas: personas.length };
  });
}

const previousStrictFlag = process.env[STRICT_FLAG];

afterEach(() => {
  if (previousStrictFlag === undefined) {
    delete process.env[STRICT_FLAG];
  } else {
    process.env[STRICT_FLAG] = previousStrictFlag;
  }
});

describe("strict mode: a scraped session id names nobody", () => {
  beforeEach(() => {
    process.env[STRICT_FLAG] = "true";
  });

  /** The best case for the attacker: they scraped the victim's REAL owner key. */
  async function setUp() {
    const t = createBackend();
    const victim = t.withIdentity({ subject: VICTIM_OWNER_ID });
    const seeded = await seedLibrary(victim, {
      claimedSessionId: LEGACY_SESSION_ID,
      kitName: "Victim Co",
    });
    return { t, victim, seeded };
  }

  it("refuses every brand-kit call made with the victim's id and no auth cookie", async () => {
    const { t } = await setUp();
    const signedOut = /signed out/i;

    // Reads that mount on page load answer "nobody" with the EMPTY answer
    // rather than an exception — throwing there took the studio down for
    // every signed-out visitor. What matters for ownership is unchanged and
    // asserted here: the scraped id yields none of the victim's data.
    expect(
      await t.query(api.brandKits.getActiveBrandKit, { sessionId: VICTIM_OWNER_ID }),
    ).toBeNull();
    await expect(
      t.mutation(api.brandKits.saveBrandKit, {
        sessionId: VICTIM_OWNER_ID,
        brandKit: buildKitInput("Stolen Co"),
      }),
    ).rejects.toThrow(signedOut);
    await expect(
      t.mutation(api.brandKits.renameBrandKit, { sessionId: VICTIM_OWNER_ID, name: "Stolen Co" }),
    ).rejects.toThrow(signedOut);
    await expect(
      t.mutation(api.brandKits.clearBrandKit, { sessionId: VICTIM_OWNER_ID }),
    ).rejects.toThrow(signedOut);

    expect(await readStoredKitNames(t, VICTIM_OWNER_ID)).toEqual(["Victim Co"]);
  });

  it("refuses every asset-library call made with the victim's id", async () => {
    const { t, seeded } = await setUp();

    // Empty, not the victim's library — see the brand-kit case above.
    expect(await t.query(api.assets.listForSession, { sessionId: VICTIM_OWNER_ID })).toEqual([]);
    await expect(
      t.mutation(api.assets.register, {
        sessionId: VICTIM_OWNER_ID,
        storageId: seeded.storageId,
        kind: "uploaded",
      }),
    ).rejects.toThrow(/signed out/i);

    expect((await countRowsOwnedBy(t, VICTIM_OWNER_ID)).assets).toBe(1);
  });

  it("refuses every saved-section call made with the victim's id", async () => {
    const { t, seeded } = await setUp();
    const signedOut = /signed out/i;

    // Empty / null, not the victim's rows — see the brand-kit case above.
    expect(
      await t.query(api.savedSections.listForSession, { sessionId: VICTIM_OWNER_ID }),
    ).toEqual([]);
    expect(
      await t.query(api.savedSections.getForSession, {
        sessionId: VICTIM_OWNER_ID,
        savedSectionId: seeded.savedSectionId,
      }),
    ).toBeNull();
    await expect(
      t.mutation(api.savedSections.rename, {
        sessionId: VICTIM_OWNER_ID,
        savedSectionId: seeded.savedSectionId,
        name: "Stolen",
      }),
    ).rejects.toThrow(signedOut);
    await expect(
      t.mutation(api.savedSections.remove, {
        sessionId: VICTIM_OWNER_ID,
        savedSectionId: seeded.savedSectionId,
      }),
    ).rejects.toThrow(signedOut);

    expect((await countRowsOwnedBy(t, VICTIM_OWNER_ID)).savedSections).toBe(1);
  });

  it("refuses every persona call made with the victim's id, and hides their copies", async () => {
    const { t, seeded } = await setUp();

    await expect(
      t.mutation(api.personas.deletePersona, {
        slug: seeded.personaSlug,
        sessionId: VICTIM_OWNER_ID,
      }),
    ).rejects.toThrow(/signed out/i);
    await expect(
      t.mutation(api.personas.updatePersonaMarkdown, {
        slug: seeded.personaSlug,
        sessionId: VICTIM_OWNER_ID,
        personaMarkdown: PERSONA_MARKDOWN,
        name: "Hijacked",
      }),
    ).rejects.toThrow(/signed out/i);

    // A listing degrades to the built-ins rather than throwing — but it must
    // not hand the victim's copies to a caller who only quoted their id.
    const listed = await t.query(api.personas.listPersonas, { sessionId: VICTIM_OWNER_ID });
    expect(listed.some((persona) => persona.slug === seeded.personaSlug)).toBe(false);
    expect((await countRowsOwnedBy(t, VICTIM_OWNER_ID)).personas).toBe(1);
  });

  it("refuses to post or close a comment as the victim", async () => {
    const { t, victim } = await setUp();
    const { documentId } = await victim.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
    });
    const commentId = await victim.mutation(api.comments.createComment, {
      documentId,
      sessionId: LEGACY_SESSION_ID,
      authorName: "brave otter",
      anchor: { blockId: null, x: 0.5, y: 0.5 },
      context: { breadcrumb: "" },
      text: "Please tighten this headline.",
    });

    await expect(
      t.mutation(api.comments.createComment, {
        documentId,
        sessionId: VICTIM_OWNER_ID,
        authorName: "brave otter",
        anchor: { blockId: null, x: 0.1, y: 0.1 },
        context: { breadcrumb: "" },
        text: "Posted in your name.",
      }),
    ).rejects.toThrow(/signed out/i);
    await expect(
      t.mutation(api.comments.resolveComment, { commentId, sessionId: VICTIM_OWNER_ID }),
    ).rejects.toThrow(/signed out/i);

    const row = await t.run(async (ctx) => ctx.db.get(commentId));
    expect(row?.status).toBe("open");
  });
});

describe("auth on, strict off: a verified identity outranks the claimed id", () => {
  beforeEach(() => {
    delete process.env[STRICT_FLAG];
  });

  /** Victim and attacker both signed in; the attacker quotes the victim's key. */
  async function setUp() {
    const t = createBackend();
    const victim = t.withIdentity({ subject: VICTIM_OWNER_ID });
    const attacker = t.withIdentity({ subject: ATTACKER_OWNER_ID });
    const seeded = await seedLibrary(victim, {
      claimedSessionId: LEGACY_SESSION_ID,
      kitName: "Victim Co",
    });
    return { t, victim, attacker, seeded };
  }

  it("writes the attacker's own brand kit instead of overwriting the victim's", async () => {
    const { t, attacker } = await setUp();

    await attacker.mutation(api.brandKits.saveBrandKit, {
      sessionId: VICTIM_OWNER_ID,
      brandKit: buildKitInput("Stolen Co"),
    });

    expect(await readStoredKitNames(t, VICTIM_OWNER_ID)).toEqual(["Victim Co"]);
    expect(await readStoredKitNames(t, ATTACKER_OWNER_ID)).toEqual(["Stolen Co"]);
  });

  it("clears nothing when the attacker asks to clear the victim's kit", async () => {
    const { t, attacker } = await setUp();
    await attacker.mutation(api.brandKits.clearBrandKit, { sessionId: VICTIM_OWNER_ID });
    expect(await readStoredKitNames(t, VICTIM_OWNER_ID)).toEqual(["Victim Co"]);
  });

  it("serves the attacker their own (empty) library, not the victim's", async () => {
    const { attacker } = await setUp();

    expect(await attacker.query(api.assets.listForSession, { sessionId: VICTIM_OWNER_ID })).toEqual(
      [],
    );
    expect(
      await attacker.query(api.savedSections.listForSession, { sessionId: VICTIM_OWNER_ID }),
    ).toEqual([]);
    expect(
      await attacker.query(api.brandKits.getActiveBrandKit, { sessionId: VICTIM_OWNER_ID }),
    ).toBeNull();
  });

  it("refuses to touch a saved section owned by the victim", async () => {
    const { t, attacker, seeded } = await setUp();

    expect(
      await attacker.query(api.savedSections.getForSession, {
        sessionId: VICTIM_OWNER_ID,
        savedSectionId: seeded.savedSectionId,
      }),
    ).toBeNull();
    await expect(
      attacker.mutation(api.savedSections.remove, {
        sessionId: VICTIM_OWNER_ID,
        savedSectionId: seeded.savedSectionId,
      }),
    ).rejects.toThrow(/different session/i);
    await expect(
      attacker.mutation(api.savedSections.applyEnrichment, {
        sessionId: VICTIM_OWNER_ID,
        savedSectionId: seeded.savedSectionId,
        useWhen: "whenever",
        description: "hijacked",
      }),
    ).rejects.toThrow(/different session/i);

    expect((await countRowsOwnedBy(t, VICTIM_OWNER_ID)).savedSections).toBe(1);
  });

  it("refuses to edit or delete a persona owned by the victim", async () => {
    const { t, attacker, seeded } = await setUp();

    await expect(
      attacker.mutation(api.personas.deletePersona, {
        slug: seeded.personaSlug,
        sessionId: VICTIM_OWNER_ID,
      }),
    ).rejects.toThrow(/different session/i);
    await expect(
      attacker.mutation(api.personas.updatePersonaMarkdown, {
        slug: seeded.personaSlug,
        sessionId: VICTIM_OWNER_ID,
        personaMarkdown: PERSONA_MARKDOWN,
        name: "Hijacked",
      }),
    ).rejects.toThrow(/different session/i);
    await expect(
      attacker.mutation(api.personas.resetPersonaToBuiltIn, {
        slug: seeded.personaSlug,
        sessionId: VICTIM_OWNER_ID,
      }),
    ).rejects.toThrow(/can be reset/i);

    expect((await countRowsOwnedBy(t, VICTIM_OWNER_ID)).personas).toBe(1);
    expect(
      await attacker.query(api.personas.listPersonas, { sessionId: VICTIM_OWNER_ID }),
    ).toEqual([]);
  });

  it("registers a stolen-id asset under the attacker, never the victim", async () => {
    const { t, attacker } = await setUp();
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([7, 7])], { type: "image/png" })),
    );

    await attacker.mutation(api.assets.register, {
      sessionId: VICTIM_OWNER_ID,
      storageId,
      kind: "uploaded",
      name: "planted.png",
    });

    expect((await countRowsOwnedBy(t, VICTIM_OWNER_ID)).assets).toBe(1);
    expect((await countRowsOwnedBy(t, ATTACKER_OWNER_ID)).assets).toBe(1);
  });

  it("attributes a comment and its resolution to the caller, not the quoted id", async () => {
    const { t, victim, attacker } = await setUp();
    const { documentId } = await victim.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
    });

    const commentId = await attacker.mutation(api.comments.createComment, {
      documentId,
      sessionId: VICTIM_OWNER_ID,
      authorName: "brave otter",
      anchor: { blockId: null, x: 0.5, y: 0.5 },
      context: { breadcrumb: "" },
      text: "Posted in someone else's name.",
    });
    await attacker.mutation(api.comments.addThreadEntry, {
      commentId,
      authorKind: "user",
      authorSessionId: VICTIM_OWNER_ID,
      authorName: "brave otter",
      text: "And replied in it too.",
    });
    await attacker.mutation(api.comments.resolveComment, {
      commentId,
      sessionId: VICTIM_OWNER_ID,
    });

    const row = await t.run(async (ctx) => ctx.db.get(commentId));
    expect(row?.sessionId).toBe(ATTACKER_OWNER_ID);
    expect(row?.resolvedBySessionId).toBe(ATTACKER_OWNER_ID);
    expect(row?.thread.map((entry) => entry.authorSessionId)).toEqual([
      ATTACKER_OWNER_ID,
      ATTACKER_OWNER_ID,
    ]);
  });
});

describe("comment payloads never carry an author id", () => {
  beforeEach(() => {
    delete process.env[STRICT_FLAG];
  });

  it("returns the display name and nothing that could key someone's library", async () => {
    const t = createBackend();
    const { documentId, canvasId } = await t.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
    });
    const commentId = await t.mutation(api.comments.createComment, {
      documentId,
      sessionId: LEGACY_SESSION_ID,
      authorName: "brave otter",
      anchor: { blockId: null, x: 0.5, y: 0.5 },
      context: { breadcrumb: "" },
      text: "Please tighten this headline.",
    });
    await t.mutation(api.comments.resolveComment, { commentId, sessionId: LEGACY_SESSION_ID });

    // The row still records who wrote it — the migration seam re-keys it.
    const row = await t.run(async (ctx) => ctx.db.get(commentId));
    expect(row?.sessionId).toBe(LEGACY_SESSION_ID);

    // What a reader of the canvas gets back must not contain it anywhere.
    for (const payload of [
      ...(await t.query(api.comments.listCommentsForCanvas, { canvasId })),
      ...(await t.query(api.comments.listOpenCommentsForDocument, { documentId })),
    ]) {
      expect(JSON.stringify(payload)).not.toContain(LEGACY_SESSION_ID);
      expect(payload.thread.every((entry) => entry.authorName.length > 0)).toBe(true);
    }
  });
});

describe("both flags off: the live app is untouched", () => {
  beforeEach(() => {
    delete process.env[STRICT_FLAG];
  });

  it("still lets a pre-auth browser own and read its own rows by session id", async () => {
    const t = createBackend();
    const seeded = await seedLibrary(t, {
      claimedSessionId: LEGACY_SESSION_ID,
      kitName: "Legacy Co",
    });

    const kit = await t.query(api.brandKits.getActiveBrandKit, { sessionId: LEGACY_SESSION_ID });
    expect(kit?.name).toBe("Legacy Co");
    expect(await t.query(api.assets.listForSession, { sessionId: LEGACY_SESSION_ID })).toHaveLength(
      1,
    );
    const sections = await t.query(api.savedSections.listForSession, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(sections.map((section) => section._id)).toEqual([seeded.savedSectionId]);
    const personas = await t.query(api.personas.listPersonas, { sessionId: LEGACY_SESSION_ID });
    expect(personas.map((persona) => persona.slug)).toContain(seeded.personaSlug);
    expect(seeded.personaSlug).toBe(`user/${LEGACY_SESSION_ID}/accessibility-checker`);
  });

  it("leaves the pre-auth hole open — which is why the flags exist", async () => {
    const t = createBackend();
    await seedLibrary(t, { claimedSessionId: LEGACY_SESSION_ID, kitName: "Legacy Co" });

    // With nobody signed in there is nothing to tell two callers apart: the
    // scraped id IS the credential. This is documented, not accidental — see
    // the roll-out order in convex/authIdentity.ts. If this ever starts
    // failing, the app has gained a way to distinguish callers with auth off
    // and the deploy order below it should be revisited.
    await t.mutation(api.brandKits.renameBrandKit, {
      sessionId: LEGACY_SESSION_ID,
      name: "Renamed by a stranger",
    });
    expect(await readStoredKitNames(t, LEGACY_SESSION_ID)).toEqual(["Renamed by a stranger"]);
  });
});
