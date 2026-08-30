// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

/*
  Persona registry backend: createPersona (slug scheme, collision suffixing,
  built-in shadow avoidance, validation) and deletePersona (ownership), plus
  how created personas surface through listPersonas (isUserCreated flag,
  sort position) and how they interact with resetPersonaToBuiltIn.

  Runs the REAL Convex functions against convex-test's in-memory backend.
*/

/*
  NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
  vitest 4 (tinyglobby has no extglob support) — the array form with negative
  patterns is the equivalent that works.
*/
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-persona-test-1";
const OTHER_SESSION_ID = "session-persona-test-2";

const VALID_MARKDOWN = `---
name: Accessibility Checker
color: "#c026d3"
capabilities: advisory
cooldownSeconds: 60
description: Flags content subscribers with disabilities cannot use.
---

You are the Accessibility Checker.

What you watch for:
- Meaningful images without alt text.

How you respond:
- Quote the content and propose a concrete fix.`;

function createBackend() {
  return convexTest(schema, modules);
}

function buildCreateArgs(overrides: Partial<{
  sessionId: string;
  name: string;
  color: string;
  cooldownSeconds: number;
  personaMarkdown: string;
}> = {}) {
  return {
    sessionId: SESSION_ID,
    name: "Accessibility Checker",
    color: "#c026d3",
    cooldownSeconds: 60,
    personaMarkdown: VALID_MARKDOWN,
    ...overrides,
  };
}

describe("createPersona", () => {
  it("creates a session-owned advisory row under user/<sessionId>/<slugified-name>", async () => {
    const t = createBackend();
    const { slug } = await t.mutation(api.personas.createPersona, buildCreateArgs());
    expect(slug).toBe(`user/${SESSION_ID}/accessibility-checker`);

    const personas = await t.query(api.personas.listPersonas, { sessionId: SESSION_ID });
    const created = personas.find((persona) => persona.slug === slug);
    expect(created).toMatchObject({
      name: "Accessibility Checker",
      color: "#c026d3",
      capabilityMode: "advisory",
      cooldownSeconds: 60,
      isBuiltIn: false,
      isUserCreated: true,
    });
  });

  it("suffixes the slug on collision within the same session", async () => {
    const t = createBackend();
    const first = await t.mutation(api.personas.createPersona, buildCreateArgs());
    const second = await t.mutation(api.personas.createPersona, buildCreateArgs());
    expect(first.slug).toBe(`user/${SESSION_ID}/accessibility-checker`);
    expect(second.slug).toBe(`user/${SESSION_ID}/accessibility-checker-2`);
  });

  it("never squats on a built-in's copy slug (a created 'Tone Police' cannot shadow the built-in)", async () => {
    const t = createBackend();
    await t.mutation(api.personas.seedBuiltInPersonas, {});
    const { slug } = await t.mutation(
      api.personas.createPersona,
      buildCreateArgs({ name: "Tone Police" }),
    );
    /*
      "tone-police" is the copy-slug base for builtin/tone-police — skipped.
    */
    expect(slug).toBe(`user/${SESSION_ID}/tone-police-2`);

    const personas = await t.query(api.personas.listPersonas, { sessionId: SESSION_ID });
    const slugs = personas.map((persona) => persona.slug);
    /*
      The pristine built-in is still visible alongside the created persona.
    */
    expect(slugs).toContain("builtin/tone-police");
    expect(slugs).toContain(slug);
  });

  it("slugifies unicode and symbol-heavy names, falling back to 'agent'", async () => {
    const t = createBackend();
    const accented = await t.mutation(
      api.personas.createPersona,
      buildCreateArgs({ name: "  Café Sécurité!  " }),
    );
    expect(accented.slug).toBe(`user/${SESSION_ID}/cafe-securite`);
    const symbols = await t.mutation(
      api.personas.createPersona,
      buildCreateArgs({ name: "!!!" }),
    );
    expect(symbols.slug).toBe(`user/${SESSION_ID}/agent`);
  });

  it("rejects blank names, bad colors, out-of-bounds cooldowns, and oversized markdown", async () => {
    const t = createBackend();
    await expect(
      t.mutation(api.personas.createPersona, buildCreateArgs({ name: "   " })),
    ).rejects.toThrow(/display name/);
    await expect(
      t.mutation(api.personas.createPersona, buildCreateArgs({ color: "hotpink" })),
    ).rejects.toThrow(/6-digit hex/);
    await expect(
      t.mutation(api.personas.createPersona, buildCreateArgs({ cooldownSeconds: 5 })),
    ).rejects.toThrow(/between 10 and 600/);
    await expect(
      t.mutation(
        api.personas.createPersona,
        buildCreateArgs({ personaMarkdown: "x".repeat(8193) }),
      ),
    ).rejects.toThrow(/too long/);
    await expect(
      t.mutation(api.personas.createPersona, buildCreateArgs({ personaMarkdown: "   " })),
    ).rejects.toThrow(/cannot be empty/);
  });
});

describe("deletePersona", () => {
  it("deletes an owned created persona", async () => {
    const t = createBackend();
    const { slug } = await t.mutation(api.personas.createPersona, buildCreateArgs());
    await t.mutation(api.personas.deletePersona, { slug, sessionId: SESSION_ID });
    const personas = await t.query(api.personas.listPersonas, { sessionId: SESSION_ID });
    expect(personas.map((persona) => persona.slug)).not.toContain(slug);
  });

  it("refuses another session's persona and built-ins", async () => {
    const t = createBackend();
    await t.mutation(api.personas.seedBuiltInPersonas, {});
    const { slug } = await t.mutation(api.personas.createPersona, buildCreateArgs());
    await expect(
      t.mutation(api.personas.deletePersona, { slug, sessionId: OTHER_SESSION_ID }),
    ).rejects.toThrow(/different session/);
    await expect(
      t.mutation(api.personas.deletePersona, {
        slug: "builtin/tone-police",
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

describe("listPersonas with created personas", () => {
  it("sorts created personas after the built-ins and hides them from other sessions", async () => {
    const t = createBackend();
    await t.mutation(api.personas.seedBuiltInPersonas, {});
    const { slug } = await t.mutation(api.personas.createPersona, buildCreateArgs());

    const ownList = await t.query(api.personas.listPersonas, { sessionId: SESSION_ID });
    const ownSlugs = ownList.map((persona) => persona.slug);
    /*
      Created persona sorts after every built-in ("user/…" > "builtin/…").
    */
    expect(ownSlugs.at(-1)).toBe(slug);
    expect(ownSlugs.filter((s) => s.startsWith("builtin/"))).toHaveLength(4);

    const otherList = await t.query(api.personas.listPersonas, {
      sessionId: OTHER_SESSION_ID,
    });
    expect(otherList.map((persona) => persona.slug)).not.toContain(slug);
  });

  it("still flags a copy-on-edit fork as customized, not user-created", async () => {
    const t = createBackend();
    await t.mutation(api.personas.seedBuiltInPersonas, {});
    const { savedSlug } = await t.mutation(api.personas.updatePersonaMarkdown, {
      slug: "builtin/tone-police",
      sessionId: SESSION_ID,
      personaMarkdown: VALID_MARKDOWN,
    });
    const personas = await t.query(api.personas.listPersonas, { sessionId: SESSION_ID });
    const copy = personas.find((persona) => persona.slug === savedSlug);
    expect(copy).toMatchObject({ isBuiltIn: false, isUserCreated: false });
  });
});

describe("resetPersonaToBuiltIn vs created personas", () => {
  it("refuses to reset a created persona (delete is its affordance)", async () => {
    const t = createBackend();
    await t.mutation(api.personas.seedBuiltInPersonas, {});
    const { slug } = await t.mutation(api.personas.createPersona, buildCreateArgs());
    await expect(
      t.mutation(api.personas.resetPersonaToBuiltIn, { slug, sessionId: SESSION_ID }),
    ).rejects.toThrow(/not a copy of a built-in/);
  });
});
