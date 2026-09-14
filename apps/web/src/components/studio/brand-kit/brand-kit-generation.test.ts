/* @vitest-environment edge-runtime */
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

describe("brand kit generation jobs", () => {
  it("persists progress, completion, and notification acknowledgement", async () => {
    const t = convexTest(schema, modules);
    const sessionId = "brand-generation-session";
    const jobId = await t.mutation(api.brandKitGeneration.start, {
      sessionId,
      sourceUrl: "https://acme.test",
    });

    await t.mutation(api.brandKitGeneration.setProgress, {
      sessionId,
      jobId,
      step: "finding-identity",
    });
    expect(await t.query(api.brandKitGeneration.getLatest, { sessionId })).toMatchObject({
      jobId,
      status: "running",
      step: "finding-identity",
    });

    const brandKitId = await t.run(async (ctx) =>
      ctx.db.insert("brandKits", {
        sessionId,
        name: "Acme",
        fonts: { heading: "Arial", body: "Arial" },
        variations: [],
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
    );
    await t.mutation(api.brandKitGeneration.complete, { sessionId, jobId, brandKitId });
    await t.mutation(api.brandKitGeneration.acknowledge, { sessionId, jobId });

    expect(await t.query(api.brandKitGeneration.getLatest, { sessionId })).toMatchObject({
      jobId,
      brandKitId,
      status: "succeeded",
      step: "complete",
      notificationSeenAtMs: expect.any(Number),
    });
  });
});
