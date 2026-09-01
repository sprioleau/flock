import { describe, expect, it } from "vitest";
import { getPanelPreferences } from "./panel-preferences";

/*
  `window` is undefined in this suite's node test environment, which exactly
  exercises the "storage unavailable" branch every real SSR/first-paint read
  also takes. Getting a NEW preference's default wrong here (an added key
  the merge forgot to seed) would silently ship `undefined` for it instead of
  a real boolean everywhere the panel reads it before mount.
*/
describe("getPanelPreferences", () => {
  it("falls back to the full set of documented defaults, including the brand sheet's", () => {
    expect(getPanelPreferences()).toEqual({
      isChatPanelExpanded: false,
      isRightRailExpanded: true,
      isBrandSheetExpanded: false,
    });
  });
});
