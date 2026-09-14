import { describe, expect, it } from "vitest";

import { buildBrandColors } from "./build-brand-colors";
import { harvestBrandSignals } from "./harvest";

describe("rendered palette evidence", () => {
  it("ranks a computed visible color above a repeated stylesheet-only token and allows it into the kit", async () => {
    const repeatedNoiseRules = Array.from(
      { length: 40 },
      () => "body { border-color: #f6339a; }",
    ).join("\n");
    const signals = await harvestBrandSignals({
      html: `<!doctype html><html><head><style>
        ${repeatedNoiseRules}
        .hero { background-color: #2463eb; }
      </style></head><body><main class="hero">Visible content</main></body></html>`,
      finalUrl: "https://visible.test/",
      fetchCss: null,
      renderedColors: [{ value: "rgb(36, 99, 235)", count: 1 }],
    });

    expect(signals.rankedColors[0]?.color).toBe("#2463eb");
    expect(signals.rankedColors.map((candidate) => candidate.color)).not.toContain("#f6339a");
    expect(signals.accentCandidates.map((candidate) => candidate.color)).not.toContain("#f6339a");

    const colors = buildBrandColors({
      modelColors: [{ hex: "#2463eb", name: "Visible Blue", category: "accent" }],
      rankedColors: signals.rankedColors,
      accentCandidates: signals.accentCandidates,
    });
    expect(colors[0]?.hex).toBe("#2463eb");
    expect(colors.map((color) => color.hex)).not.toContain("#f6339a");
  });

  it("does not promote hidden chromatic tokens when the rendered page is neutral", async () => {
    const signals = await harvestBrandSignals({
      html: `<!doctype html><html><head><style>
        :root { --hidden-accent: #f6339a; }
        body { color: #151515; background: #ffffff; }
      </style></head><body><main>Neutral content</main></body></html>`,
      finalUrl: "https://neutral.test/",
      fetchCss: null,
      renderedColors: [
        { value: "rgb(21, 21, 21)", count: 3 },
        { value: "rgb(255, 255, 255)", count: 2 },
      ],
    });

    expect(signals.rankedColors).toEqual([]);
    expect(signals.accentCandidates).toEqual([]);
  });
});
