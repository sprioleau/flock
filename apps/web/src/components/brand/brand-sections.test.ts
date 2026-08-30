import { describe, expect, it } from "vitest";
import {
  BRAND_SECTIONS,
  DEFAULT_BRAND_SECTION,
  resolveBrandSection,
} from "./brand-sections";

/*
  The section registry is the only routing logic on the /brand page that is
  testable without a DOM — the URL segment resolves here, so pin the behaviour
  that keeps a stale/garbage link usable instead of a 404.
*/
describe("resolveBrandSection", () => {
  it("returns the default section for bare /brand (no segment)", () => {
    expect(resolveBrandSection(undefined)).toBe(DEFAULT_BRAND_SECTION);
  });

  it("resolves a known slug to its section", () => {
    for (const section of BRAND_SECTIONS) {
      expect(resolveBrandSection(section.slug)).toBe(section);
    }
  });

  it("falls back to the default for an unknown slug rather than throwing", () => {
    expect(resolveBrandSection("not-a-section")).toBe(DEFAULT_BRAND_SECTION);
  });

  it("leads with Email Design — the headline of this work", () => {
    expect(DEFAULT_BRAND_SECTION.id).toBe("email-design");
  });

  it("uses matching id and slug so there is one string to reason about", () => {
    for (const section of BRAND_SECTIONS) {
      expect(section.slug).toBe(section.id);
    }
  });
});
