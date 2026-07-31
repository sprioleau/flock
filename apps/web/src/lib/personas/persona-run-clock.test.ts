import { describe, expect, it } from "vitest";
import { buildNextCheckLabel } from "./persona-run-clock";

/**
 * The facepile hover card's next-check line — the contract is USER-FACING
 * language for every internal state (owner principle: never raw ms or
 * internal names).
 */
describe("buildNextCheckLabel", () => {
  const NOW_MS = 1_700_000_000_000;

  it("says Paused (with the manual-check hint) whenever recommendations are paused — outranking everything", () => {
    expect(
      buildNextCheckLabel({
        isPaused: true,
        personaStatus: "thinking",
        lastRunAtMs: NOW_MS,
        cooldownSeconds: 45,
        nowMs: NOW_MS,
      }),
    ).toBe("Paused — check manually");
  });

  it("says Checking now… while a run is live (reading or thinking)", () => {
    for (const personaStatus of ["reading", "thinking"] as const) {
      expect(
        buildNextCheckLabel({
          isPaused: false,
          personaStatus,
          lastRunAtMs: null,
          cooldownSeconds: 45,
          nowMs: NOW_MS,
        }),
      ).toBe("Checking now…");
    }
  });

  it("counts down inside the cooldown window, in whole seconds", () => {
    expect(
      buildNextCheckLabel({
        isPaused: false,
        personaStatus: "idle",
        lastRunAtMs: NOW_MS - 15_000,
        cooldownSeconds: 45,
        nowMs: NOW_MS,
      }),
    ).toBe("Checks again in about 30 seconds");
  });

  it("uses the singular for the last second", () => {
    expect(
      buildNextCheckLabel({
        isPaused: false,
        personaStatus: "idle",
        lastRunAtMs: NOW_MS - 44_500,
        cooldownSeconds: 45,
        nowMs: NOW_MS,
      }),
    ).toBe("Checks again in about 1 second");
  });

  it("switches to minutes for long cooldowns", () => {
    expect(
      buildNextCheckLabel({
        isPaused: false,
        personaStatus: "idle",
        lastRunAtMs: NOW_MS,
        cooldownSeconds: 180,
        nowMs: NOW_MS,
      }),
    ).toBe("Checks again in about 3 minutes");
  });

  it("says Waiting for changes past the cooldown — a check fires on the next edit, not a timer", () => {
    expect(
      buildNextCheckLabel({
        isPaused: false,
        personaStatus: "idle",
        lastRunAtMs: NOW_MS - 46_000,
        cooldownSeconds: 45,
        nowMs: NOW_MS,
      }),
    ).toBe("Waiting for changes");
  });

  it("says Waiting for changes when this browser has never triggered a run", () => {
    expect(
      buildNextCheckLabel({
        isPaused: false,
        personaStatus: undefined,
        lastRunAtMs: null,
        cooldownSeconds: 45,
        nowMs: NOW_MS,
      }),
    ).toBe("Waiting for changes");
  });
});
