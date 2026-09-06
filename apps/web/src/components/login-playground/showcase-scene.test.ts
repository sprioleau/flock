import { describe, expect, it } from "vitest";
import {
  SHOWCASE_AGENTS,
  SHOWCASE_BEATS,
  getShowcaseSceneState,
} from "./showcase-scene";

describe("login playground showcase scene", () => {
  it("uses three stable, visually distinct AI identities", () => {
    expect(SHOWCASE_AGENTS).toHaveLength(3);
    expect(new Set(SHOWCASE_AGENTS.map((agent) => agent.id)).size).toBe(3);
    expect(new Set(SHOWCASE_AGENTS.map((agent) => agent.color)).size).toBe(3);
    expect(new Set(SHOWCASE_AGENTS.map((agent) => agent.glyph)).size).toBe(3);
    expect(SHOWCASE_AGENTS.every((agent) => agent.name.length > 0)).toBe(true);
  });

  it("stages meaningful inspect, select, edit, and propose work instead of random motion", () => {
    expect(SHOWCASE_BEATS.map((beat) => beat.kind)).toEqual(
      expect.arrayContaining(["inspect", "select", "edit", "propose"]),
    );
    expect(SHOWCASE_BEATS.every((beat) => beat.activity.length > 0)).toBe(true);
    expect(SHOWCASE_BEATS.every((beat) => beat.durationMs >= 1_400)).toBe(true);
  });

  it("applies edits cumulatively and wraps the loop without leaking future changes", () => {
    const initial = getShowcaseSceneState({ beatIndex: 0, isReducedMotion: false });
    const editedHeadline = getShowcaseSceneState({ beatIndex: 2, isReducedMotion: false });
    const final = getShowcaseSceneState({
      beatIndex: SHOWCASE_BEATS.length - 1,
      isReducedMotion: false,
    });
    const wrapped = getShowcaseSceneState({
      beatIndex: SHOWCASE_BEATS.length,
      isReducedMotion: false,
    });

    expect(initial.email.headline).toBe("A launch update worth opening");
    expect(initial.email.cta).toBe("Read the update");
    expect(editedHeadline.email.headline).toBe("Meet the faster way to ship email");
    expect(editedHeadline.email.cta).toBe("Read the update");
    expect(final.email.cta).toBe("See what changed");
    expect(final.completedActivities).toHaveLength(SHOWCASE_BEATS.length);
    expect(wrapped).toEqual(initial);
  });

  it("renders a stable completed scene when reduced motion is requested", () => {
    const reduced = getShowcaseSceneState({ beatIndex: 0, isReducedMotion: true });

    expect(reduced.activeBeatIndex).toBe(SHOWCASE_BEATS.length - 1);
    expect(reduced.email.headline).toBe("Meet the faster way to ship email");
    expect(reduced.email.cta).toBe("See what changed");
    expect(reduced.completedActivities).toHaveLength(SHOWCASE_BEATS.length);
  });
});
