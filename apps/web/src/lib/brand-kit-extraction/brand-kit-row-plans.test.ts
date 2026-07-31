/**
 * Stage S row-plan logic (convex/model/brandKitAssets.ts) + the decision-4
 * confirmed-only gate: pure functions, tested here because the web app owns
 * the vitest runner (the convex dir has none).
 */
import { describe, expect, it } from "vitest";
import {
  collectRowStorageIds,
  getEffectiveRevision,
  planAssetConfirmationPatch,
  planAssetRemovalPatch,
  planBrandKitSavePatch,
} from "@convex/model/brandKitAssets";
import { getConfirmedBrandAssetUrl, MOCK_BRAND_KIT } from "@/lib/brand-kit";

const confirmedLogoRow = {
  revision: 3,
  logoUrl: "https://storage.convex.cloud/abc", // durable — the confirmed state
  logoStorageId: "st_logo_1",
  logoSourceUrl: "https://acme.test/logo.png",
  logoConfirmedAtMs: 1_000,
  socialImageUrl: "https://acme.test/og.png", // still just a suggestion
};

describe("getEffectiveRevision", () => {
  it("treats pre-Stage-S rows (no revision) as revision 1", () => {
    expect(getEffectiveRevision({})).toBe(1);
    expect(getEffectiveRevision({ revision: 7 })).toBe(7);
  });
});

describe("planBrandKitSavePatch", () => {
  it("bumps revision on every save (from the normalized floor)", () => {
    const { patch } = planBrandKitSavePatch({
      existing: {},
      incomingLogoUrl: undefined,
      incomingSocialImageUrl: undefined,
    });
    expect(patch.revision).toBe(2); // absent = 1 → 2
  });

  it("keeps a confirmation when the incoming URL is unchanged", () => {
    const { patch, storageIdsToDelete } = planBrandKitSavePatch({
      existing: confirmedLogoRow,
      incomingLogoUrl: confirmedLogoRow.logoUrl,
      incomingSocialImageUrl: confirmedLogoRow.socialImageUrl,
    });
    expect(patch).toEqual({ revision: 4 }); // nothing but the bump
    expect(storageIdsToDelete).toEqual([]);
  });

  it("clears a confirmation (and surrenders its file) when a new suggestion arrives", () => {
    const { patch, storageIdsToDelete } = planBrandKitSavePatch({
      existing: confirmedLogoRow,
      incomingLogoUrl: "https://acme.test/new-logo.svg", // a re-scrape
      incomingSocialImageUrl: confirmedLogoRow.socialImageUrl,
    });
    expect(patch.logoUrl).toBe("https://acme.test/new-logo.svg");
    expect(patch).toHaveProperty("logoStorageId", undefined); // field removals
    expect(patch).toHaveProperty("logoConfirmedAtMs", undefined);
    expect(patch).toHaveProperty("logoSourceUrl", undefined);
    expect(storageIdsToDelete).toEqual(["st_logo_1"]);
    // The unchanged social suggestion is untouched.
    expect(patch).not.toHaveProperty("socialImageUrl");
  });

  it("removes an asset the incoming kit no longer carries", () => {
    const { patch } = planBrandKitSavePatch({
      existing: { socialImageUrl: "https://acme.test/og.png" },
      incomingLogoUrl: undefined,
      incomingSocialImageUrl: undefined,
    });
    expect(patch).toHaveProperty("socialImageUrl", undefined);
    expect(patch).not.toHaveProperty("logoUrl"); // was absent, stays absent
  });
});

describe("planAssetConfirmationPatch", () => {
  it("writes the durable URL, provenance, timestamp, and bumps revision", () => {
    const { patch, storageIdsToDelete } = planAssetConfirmationPatch({
      existing: { revision: 1, logoUrl: "https://acme.test/logo.png" },
      kind: "logo",
      storageId: "st_new",
      servingUrl: "https://storage.convex.cloud/new",
      sourceUrl: "https://acme.test/logo.png",
      nowMs: 5_000,
    });
    expect(patch).toEqual({
      revision: 2,
      logoUrl: "https://storage.convex.cloud/new",
      logoStorageId: "st_new",
      logoSourceUrl: "https://acme.test/logo.png",
      logoConfirmedAtMs: 5_000,
    });
    expect(storageIdsToDelete).toEqual([]);
  });

  it("surrenders the previously confirmed file when re-confirming", () => {
    const { storageIdsToDelete } = planAssetConfirmationPatch({
      existing: confirmedLogoRow,
      kind: "logo",
      storageId: "st_logo_2",
      servingUrl: "https://storage.convex.cloud/def",
      sourceUrl: confirmedLogoRow.logoUrl,
      nowMs: 6_000,
    });
    expect(storageIdsToDelete).toEqual(["st_logo_1"]);
  });

  it("addresses the social-card fields for kind socialCard", () => {
    const { patch } = planAssetConfirmationPatch({
      existing: confirmedLogoRow,
      kind: "socialCard",
      storageId: "st_social",
      servingUrl: "https://storage.convex.cloud/soc",
      sourceUrl: confirmedLogoRow.socialImageUrl,
      nowMs: 7_000,
    });
    expect(patch.socialImageUrl).toBe("https://storage.convex.cloud/soc");
    expect(patch.socialImageConfirmedAtMs).toBe(7_000);
    expect(patch).not.toHaveProperty("logoUrl"); // the logo is untouched
  });
});

describe("planAssetRemovalPatch", () => {
  it("clears every field for the kind and surrenders the file", () => {
    const { patch, storageIdsToDelete } = planAssetRemovalPatch({
      existing: confirmedLogoRow,
      kind: "logo",
    });
    expect(patch.revision).toBe(4);
    expect(patch).toHaveProperty("logoUrl", undefined);
    expect(patch).toHaveProperty("logoStorageId", undefined);
    expect(storageIdsToDelete).toEqual(["st_logo_1"]);
  });

  it("removing an unconfirmed suggestion surrenders nothing", () => {
    const { storageIdsToDelete } = planAssetRemovalPatch({
      existing: { socialImageUrl: "https://acme.test/og.png" },
      kind: "socialCard",
    });
    expect(storageIdsToDelete).toEqual([]);
  });
});

describe("collectRowStorageIds", () => {
  it("collects only the storage ids the row holds", () => {
    expect(collectRowStorageIds(confirmedLogoRow)).toEqual(["st_logo_1"]);
    expect(collectRowStorageIds({})).toEqual([]);
  });
});

describe("getConfirmedBrandAssetUrl (owner decision 4 gate)", () => {
  it("returns null for unconfirmed suggestions — they never enter documents", () => {
    const suggestedKit = { ...MOCK_BRAND_KIT, logoUrl: "https://acme.test/logo.png" };
    expect(getConfirmedBrandAssetUrl({ brandKit: suggestedKit, kind: "logo" })).toBeNull();
    expect(getConfirmedBrandAssetUrl({ brandKit: suggestedKit, kind: "socialCard" })).toBeNull();
  });

  it("returns the durable URL once confirmed", () => {
    const confirmedKit = {
      ...MOCK_BRAND_KIT,
      logoUrl: "https://storage.convex.cloud/abc",
      logoConfirmedAtMs: 1_000,
    };
    expect(getConfirmedBrandAssetUrl({ brandKit: confirmedKit, kind: "logo" })).toBe(
      "https://storage.convex.cloud/abc",
    );
  });
});
