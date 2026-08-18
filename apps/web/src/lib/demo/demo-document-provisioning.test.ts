// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

/*
  The backend half of /demo's public-safety story, run against the real Convex
  functions in convex-test's in-memory backend.

  The two things that must hold:

  1. `createDocument({ isDemo: true })` both SEEDS the demo email and STAMPS
     the row, because those two facts drifting apart is how a public,
     scripted-looking draft ends up spending real Gemini quota on every turn.
  2. A row written WITHOUT the flag — which is every row in production today —
     answers exactly as it did before this field existed. `isDemo` is optional
     and additive; production deploys from `main`, and a required field or a
     changed default would break every existing draft.
*/

// NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
// vitest 4 (tinyglobby has no extglob support) — the array form with negative
// patterns is the equivalent that works.
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

function createBackend() {
  return convexTest(schema, modules);
}

const SESSION_ID = "session-demo-provisioning";

describe("provisioning a /demo document", () => {
  it("stamps isDemo and seeds the email with the planted problems", async () => {
    const backend = createBackend();
    const { documentId } = await backend.mutation(api.documents.createDocument, {
      sessionId: SESSION_ID,
      isDemo: true,
    });

    expect(await backend.query(api.documents.getDocumentIsDemo, { documentKey: documentId })).toBe(
      true,
    );

    const payload = await backend.query(api.documents.getDocumentByKey, {
      documentKey: documentId,
    });
    expect(payload?.isDemo).toBe(true);
    /* The seed, identified by the two problems the agents are here to find:
       the shouted paragraph and the second CTA that drifted from the first. */
    expect(JSON.stringify(payload?.doc)).toContain("LAST CHANCE");
    expect(JSON.stringify(payload?.doc)).toContain("Shop the spring lineup");
  });

  it("leaves an ordinary draft exactly as it was before the field existed", async () => {
    const backend = createBackend();
    const { documentId } = await backend.mutation(api.documents.createDocument, {
      sessionId: SESSION_ID,
    });

    /* Absent, not false: the row is byte-identical to the rows every release
       before this one wrote, which is what makes the migration a no-op. */
    const payload = await backend.query(api.documents.getDocumentByKey, {
      documentKey: documentId,
    });
    expect(payload?.isDemo).toBeUndefined();
    /* And the spend authority reads that absence as "an ordinary draft". */
    expect(await backend.query(api.documents.getDocumentIsDemo, { documentKey: documentId })).toBe(
      false,
    );
    /* Still the designed starter email, not the demo seed. */
    expect(JSON.stringify(payload?.doc)).not.toContain("LAST CHANCE");
  });

  it("answers false for an id that names nothing, rather than throwing", async () => {
    /* The `?doc=` param is untrusted input; a malformed id must degrade to
       "not a demo document" — today's behaviour for a request naming no
       document at all — instead of failing the turn. */
    const backend = createBackend();
    expect(
      await backend.query(api.documents.getDocumentIsDemo, { documentKey: "not-a-real-id" }),
    ).toBe(false);
  });
});
