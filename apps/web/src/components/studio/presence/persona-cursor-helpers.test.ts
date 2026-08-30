import { describe, expect, it } from "vitest";
import { FINDING_CARD_REVEAL_MS, FINDING_DWELL_MS } from "@/lib/personas/finding-presentation";
import {
  buildFindingHoverAnchor,
  buildReadingLaneX,
  extractPersonaSlugFromPresenceUserId,
  getMsUntilPresentationPhaseChange,
  getPresentationPhase,
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

describe("getPresentationPhase — the wander → dwell → select → post contract", () => {
  const CREATED_AT_MS = 1_700_000_000_000;

  it("opens in the dwell beat the instant the finding lands", () => {
    expect(
      getPresentationPhase({ findingCreatedAtMs: CREATED_AT_MS, nowMs: CREATED_AT_MS }),
    ).toBe("dwell");
  });

  it("dwells for FINDING_DWELL_MS, then flips to select", () => {
    expect(
      getPresentationPhase({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + FINDING_DWELL_MS - 1,
      }),
    ).toBe("dwell");
    expect(
      getPresentationPhase({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + FINDING_DWELL_MS,
      }),
    ).toBe("select");
  });

  it("closes when the presentation window passes", () => {
    expect(
      getPresentationPhase({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + PRESENTATION_WINDOW_MS,
      }),
    ).toBe("closed");
  });

  it("treats no finding (createdAtMs 0) as closed", () => {
    expect(getPresentationPhase({ findingCreatedAtMs: 0, nowMs: CREATED_AT_MS })).toBe("closed");
  });

  it("reads a future-stamped finding (clock skew) as the dwell beat", () => {
    expect(
      getPresentationPhase({
        findingCreatedAtMs: CREATED_AT_MS + 120_000,
        nowMs: CREATED_AT_MS,
      }),
    ).toBe("dwell");
  });

  it("orders the beats: the card posts only after the select beat began", () => {
    /*
      The cross-module invariant the flow depends on: at the card's reveal
      instant the cursor is already in its select pose.
    */
    expect(FINDING_CARD_REVEAL_MS).toBeGreaterThanOrEqual(FINDING_DWELL_MS);
    expect(
      getPresentationPhase({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + FINDING_CARD_REVEAL_MS,
      }),
    ).toBe("select");
  });
});

describe("getMsUntilPresentationPhaseChange", () => {
  const CREATED_AT_MS = 1_700_000_000_000;

  it("points a dwelling finding at the dwell → select boundary", () => {
    expect(
      getMsUntilPresentationPhaseChange({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + 1_000,
      }),
    ).toBe(FINDING_DWELL_MS - 1_000);
  });

  it("points a selecting finding at the window close", () => {
    expect(
      getMsUntilPresentationPhaseChange({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + FINDING_DWELL_MS,
      }),
    ).toBe(PRESENTATION_WINDOW_MS - FINDING_DWELL_MS);
  });

  it("returns null once closed — no timer to arm", () => {
    expect(
      getMsUntilPresentationPhaseChange({
        findingCreatedAtMs: CREATED_AT_MS,
        nowMs: CREATED_AT_MS + PRESENTATION_WINDOW_MS + 1,
      }),
    ).toBeNull();
    expect(
      getMsUntilPresentationPhaseChange({ findingCreatedAtMs: 0, nowMs: CREATED_AT_MS }),
    ).toBeNull();
  });
});
