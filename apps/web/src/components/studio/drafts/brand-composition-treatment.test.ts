import { describe, expect, it } from "vitest";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";
import { deriveBrandCompositionTreatment } from "./brand-composition-treatment";

describe("deriveBrandCompositionTreatment", () => {
  it("selects only known email-safe treatments from the bound brand documents", () => {
    expect(
      deriveBrandCompositionTreatment({
        ...MOCK_BRAND_KIT,
        emailDesignDoc: {
          origin: "scraped",
          markdown: "Use a bordered CTA button and a hairline rule after each content section.",
        },
        imageStyleDoc: {
          origin: "scraped",
          markdown: "Give every image a crisp outlined frame.",
        },
      }),
    ).toEqual({
      shouldOutlineButtons: true,
      shouldFrameImages: true,
      shouldSeparateSections: true,
    });
  });

  it("does not invent a treatment when the documents provide no matching direction", () => {
    expect(
      deriveBrandCompositionTreatment({
        ...MOCK_BRAND_KIT,
        emailDesignDoc: { origin: "user", markdown: "Keep the voice warm and concise." },
      }),
    ).toBeNull();
  });
});
