import { describe, expect, it } from "vitest";
import {
  nextPhaseAfterGenerate,
  readIsBrandOnboardingDismissed,
  shouldShowBrandOnboardingGate,
} from "./brand-onboarding-gate";

/*
  The gating decision is the whole contract of the brand-first onboarding
  prompt: it has to show up for a brand-less session, and it has to actually
  go away once the user has a kit OR has told it to. Getting any one of these
  three wrong either re-traps a user who already skipped, or never prompts
  the one it exists for.
*/

describe("shouldShowBrandOnboardingGate", () => {
  it("shows for a ready document with no saved kit and no dismissal", () => {
    expect(
      shouldShowBrandOnboardingGate({
        isDocumentReady: true,
        hasSavedKit: false,
        isDismissed: false,
      }),
    ).toBe(true);
  });

  it("never shows before the document itself is ready", () => {
    expect(
      shouldShowBrandOnboardingGate({
        isDocumentReady: false,
        hasSavedKit: false,
        isDismissed: false,
      }),
    ).toBe(false);
  });

  it("stays away once the session has a saved brand kit", () => {
    expect(
      shouldShowBrandOnboardingGate({
        isDocumentReady: true,
        hasSavedKit: true,
        isDismissed: false,
      }),
    ).toBe(false);
  });

  it("stays away once the user has skipped or picked a placeholder — the escape hatch has to stick", () => {
    expect(
      shouldShowBrandOnboardingGate({
        isDocumentReady: true,
        hasSavedKit: false,
        isDismissed: true,
      }),
    ).toBe(false);
  });
});

describe("readIsBrandOnboardingDismissed", () => {
  it("reads false when nothing has been persisted (no window in this test environment)", () => {
    expect(readIsBrandOnboardingDismissed("session_new")).toBe(false);
  });
});

/*
  Owner's sequential-flow rule, stated directly: a successful scrape stays on
  the URL step (with a preview attached); a FAILED scrape is what reveals the
  curated archetype fallback. The two outcomes must never swap — showing
  archetypes on success or leaving a failure on a bare, unexplained URL box
  are both exactly the "all-options-at-once" shape the owner rejected.
*/
describe("nextPhaseAfterGenerate", () => {
  it("stays on the url phase after a successful scrape", () => {
    expect(nextPhaseAfterGenerate({ isOk: true })).toBe("url");
  });

  it("reveals the archetype fallback after a failed scrape", () => {
    expect(nextPhaseAfterGenerate({ isOk: false })).toBe("archetypes");
  });
});
