import { describe, expect, it } from "vitest";
import {
  getBrandKitValidationErrors,
  getBrandKitPalette,
  MOCK_BRAND_KIT,
} from "./brand-kit";
import { isHumanOwnedColor, isHumanOwnedTone } from "./brand-kit-reconcile";
import { getBrandFontsValidationErrors } from "./brand-kit-fonts";
import { buildDefaultBrandKit, DEFAULT_BRAND_KIT_NAME } from "./brand-kit-default";
import { decodeSvgDataUri, isSvgMarkupSafe } from "./brand-kit-extraction/confirm-asset";
import { getEligibleThemeBackgrounds, getPaletteHexes } from "./brand-theme-builder";

/*
  The STARTER kit (§14.5c) — Flock's own brand, seeded so a user whose site
  cannot be scraped is not locked out of every editor in the panel.

  These assertions are the ones that would be real bugs in production: a kit
  the server would refuse to store, a palette that cannot build a theme, a
  logo that cannot be confirmed, or provenance that would make the starter
  outlive the user's own scrape of their own website.
*/

describe("the default Flock brand kit", () => {
  it("passes the same contract gate a scraped kit does", () => {
    /*
      `assertBrandKitIsValid` runs this exact function server-side before the
      seed row is written, so a starter kit that failed it would be a mutation
      that always throws — the feature would not exist.
    */
    expect(getBrandKitValidationErrors(buildDefaultBrandKit())).toEqual([]);
  });

  it("uses email-safe font stacks, so the fonts editor can actually change them", () => {
    /*
      `updateBrandFonts` refuses anything outside the email-safe list. A
      starter kit whose fonts were not on it would show "Custom" in both
      dropdowns and turn the first font edit into a rejection.
    */
    expect(getBrandFontsValidationErrors(buildDefaultBrandKit().fonts)).toEqual([]);
  });

  it("ships the app's existing themes, Midnight included, rather than re-authored ones", () => {
    const kit = buildDefaultBrandKit();
    expect(kit.variations.map((variation) => variation.id)).toEqual(
      MOCK_BRAND_KIT.variations.map((variation) => variation.id),
    );
    expect(kit.variations.map((variation) => variation.name)).toContain("Midnight");
    /*
      Copied, not aliased: a kit row owns its variations.
    */
    expect(kit.variations[0]).not.toBe(MOCK_BRAND_KIT.variations[0]);
  });

  it("names and groups the Flock palette the way a scraped one is named", () => {
    const kit = buildDefaultBrandKit();
    expect(kit.name).toBe(DEFAULT_BRAND_KIT_NAME);
    /*
      Read through the same accessor the color picker uses, so this asserts
      what a person actually sees in the swatch row.
    */
    expect(getBrandKitPalette(kit)).toEqual([
      { color: "#000000", label: "Black" },
      { color: "#3a3a3c", label: "Charcoal" },
      { color: "#ffffff", label: "White" },
    ]);
  });

  it("gives the theme builder a palette it can actually build from", () => {
    /*
      A monochrome palette legitimately produces an EMPTY eligible-background
      set, and the builder then renders its "no two colors are readable
      together" empty state. Shipping a starter kit that lands there would
      hand the user an editor that says it cannot help them.
    */
    const paletteHexes = getPaletteHexes(buildDefaultBrandKit().colors);
    expect(getEligibleThemeBackgrounds(paletteHexes).length).toBeGreaterThan(0);
  });

  it("carries a tone of voice, and it is not marked as the user's", () => {
    const toneOfVoice = buildDefaultBrandKit().toneOfVoice;
    expect(toneOfVoice?.descriptors.length).toBeGreaterThan(0);
    expect(toneOfVoice?.guidance ?? "").not.toHaveLength(0);
    /*
      PROVENANCE IS THE POINT. `reconcileToneOfVoice` protects human-owned tone
      from a re-scrape; a starter tone that claimed to be the user's would
      survive the scrape of their own website and quietly keep writing their
      emails in Flock's voice.
    */
    expect(toneOfVoice === undefined ? true : isHumanOwnedTone(toneOfVoice)).toBe(false);
  });

  it("does not lock its colors against the user's own scrape", () => {
    /*
      Same reasoning as the tone: a scrape must be able to sweep these away.
    */
    const colors = buildDefaultBrandKit().colors ?? [];
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.some((color) => isHumanOwnedColor(color))).toBe(false);
  });

  it("ships the logo as an UNCONFIRMED data URI the confirm route can decode", () => {
    const kit = buildDefaultBrandKit();
    /*
      Unconfirmed is not an oversight — it is the rule. `logoConfirmedAtMs` is
      absent, so `getConfirmedBrandAssetUrl` answers null and nothing writes
      this into a document. Confirming it runs the shipped route, which decodes
      the data URI and uploads the bytes to Convex storage; only the resulting
      storage URL may reach an email, because a `data:` src is blocked by most
      clients.
    */
    expect(kit.logoConfirmedAtMs).toBeUndefined();
    const decoded = decodeSvgDataUri(kit.logoUrl ?? "");
    expect(decoded).not.toBeNull();
    expect(decoded?.svgText.startsWith("<svg")).toBe(true);
    /*
      And the same safety gate a scraped inline SVG has to clear.
    */
    expect(isSvgMarkupSafe(decoded?.svgText ?? "")).toBe(true);
  });
});
