import { describe, expect, it } from "vitest";
import {
  buildFindingHoverAnchor,
  buildReadingLaneX,
  extractPersonaSlugFromPresenceUserId,
  getPresentationRemainingMs,
  PRESENTATION_WINDOW_MS,
} from "./persona-cursor-helpers";

describe("extractPersonaSlugFromPresenceUserId", () => {
  it("extracts a builtin slug (slashes intact) from persona:<slug>:<docId>", () => {
    expect(
      extractPersonaSlugFromPresenceUserId("persona:builtin/tone-police:jd7abc123"),
    ).toBe("builtin/tone-police");
  });

  it("extracts a session-copy slug with multiple slashes", () => {
    expect(
      extractPersonaSlugFromPresenceUserId("persona:user/sess-1/styling-recommender:jd7abc123"),
    ).toBe("user/sess-1/styling-recommender");
  });

  it("returns null for human and agent roster members", () => {
    expect(extractPersonaSlugFromPresenceUserId("session-abc")).toBeNull();
    expect(extractPersonaSlugFromPresenceUserId("agent")).toBeNull();
  });

  it("returns null for a malformed persona id with no document suffix", () => {
    expect(extractPersonaSlugFromPresenceUserId("persona:")).toBeNull();
    expect(extractPersonaSlugFromPresenceUserId("persona:slug-without-doc")).toBeNull();
  });
});

describe("buildFindingHoverAnchor", () => {
  it("is deterministic — the cross-tab consistency contract", () => {
    const first = buildFindingHoverAnchor("jx7finding123");
    const second = buildFindingHoverAnchor("jx7finding123");
    expect(second).toEqual(first);
  });

  it("stays inside the block rect's hover band (x 0.55–0.85, y 0.3–0.6)", () => {
    for (const findingId of ["a", "jx7finding123", "another-finding-id", "z9y8x7"]) {
      const anchor = buildFindingHoverAnchor(findingId);
      expect(anchor.x).toBeGreaterThanOrEqual(0.55);
      expect(anchor.x).toBeLessThan(0.85);
      expect(anchor.y).toBeGreaterThanOrEqual(0.3);
      expect(anchor.y).toBeLessThan(0.6);
    }
  });

  it("spreads different findings to different spots", () => {
    expect(buildFindingHoverAnchor("finding-one")).not.toEqual(
      buildFindingHoverAnchor("finding-two"),
    );
  });
});

describe("buildReadingLaneX", () => {
  it("is deterministic per slug and stays inside the 0.3–0.7 lane band", () => {
    for (const slug of ["builtin/tone-police", "builtin/styling-recommender"]) {
      const lane = buildReadingLaneX(slug);
      expect(lane).toBe(buildReadingLaneX(slug));
      expect(lane).toBeGreaterThanOrEqual(0.3);
      expect(lane).toBeLessThan(0.7);
    }
  });

  it("separates the two built-in personas' lanes", () => {
    expect(buildReadingLaneX("builtin/tone-police")).not.toBe(
      buildReadingLaneX("builtin/styling-recommender"),
    );
  });
});

describe("getPresentationRemainingMs", () => {
  const CREATED_AT_MS = 1_700_000_000_000;

  it("grants the full window to a finding that just landed", () => {
    expect(
      getPresentationRemainingMs({ findingCreatedAtMs: CREATED_AT_MS, nowMs: CREATED_AT_MS }),
    ).toBe(PRESENTATION_WINDOW_MS);
  });

  it("counts down as the finding ages", () => {
    expect(
      getPresentationRemainingMs({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + 3_000,
      }),
    ).toBe(PRESENTATION_WINDOW_MS - 3_000);
  });

  it("returns 0 once the window has passed — the cursor-fade contract", () => {
    expect(
      getPresentationRemainingMs({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + PRESENTATION_WINDOW_MS,
      }),
    ).toBe(0);
    expect(
      getPresentationRemainingMs({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + PRESENTATION_WINDOW_MS + 60_000,
      }),
    ).toBe(0);
  });

  it("returns 0 for a finding that arrived already old (late-joining tab)", () => {
    expect(
      getPresentationRemainingMs({
        findingCreatedAtMs: CREATED_AT_MS - 3_600_000,
        nowMs: CREATED_AT_MS,
      }),
    ).toBe(0);
  });

  it("clamps a future-stamped finding (clock skew) to the full window, never more", () => {
    expect(
      getPresentationRemainingMs({
        findingCreatedAtMs: CREATED_AT_MS + 120_000,
        nowMs: CREATED_AT_MS,
      }),
    ).toBe(PRESENTATION_WINDOW_MS);
  });
});
