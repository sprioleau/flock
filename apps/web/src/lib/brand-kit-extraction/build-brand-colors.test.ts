/**
 * The scrape's authored palette (brand-kit-user-control §3): the owner's
 * `--banana` idea end to end — the harvester already captured the declaring
 * CSS custom property, and this is where it finally becomes a NAME the user
 * can see and edit.
 *
 * The two properties that matter: faithfulness (the model names colors, it
 * never introduces one) and termination (there is always a palette and every
 * entry always has a name, however unhelpful the model was).
 */
import { describe, expect, it } from "vitest";
import { buildBrandColors } from "./build-brand-colors";
import type { RankedColor } from "./harvest";

function ranked({
  color,
  count = 10,
  variableName = null,
}: {
  color: string;
  count?: number;
  variableName?: string | null;
}): RankedColor {
  return { color, count, variableName };
}

const HARVESTED: RankedColor[] = [
  ranked({ color: "#0b1120", count: 120, variableName: "--ink" }),
  ranked({ color: "#ffc400", count: 41, variableName: "--banana" }),
  ranked({ color: "#3730a3", count: 30, variableName: "--c-4" }),
  ranked({ color: "#8899aa", count: 12 }),
];
const ACCENTS: RankedColor[] = [ranked({ color: "#ffc400", count: 41, variableName: "--banana" })];

describe("buildBrandColors", () => {
  it("keeps the model's names and categories, and carries the harvest provenance", () => {
    const colors = buildBrandColors({
      modelColors: [
        { hex: "#ffc400", name: "Banana", category: "accent" },
        { hex: "#0b1120", name: "Ink", category: "primary" },
      ],
      rankedColors: HARVESTED,
      accentCandidates: ACCENTS,
    });
    const banana = colors.find((entry) => entry.hex === "#ffc400")!;
    expect(banana.name).toBe("Banana");
    expect(banana.category).toBe("accent");
    expect(banana.origin).toBe("agent");
    // Provenance persists — this is the thing the pipeline used to discard.
    expect(banana.sourceVariableName).toBe("--banana");
    expect(banana.sourceUsageCount).toBe(41);
  });

  it("DROPS a color the model invented (faithfulness, same rule as the logo)", () => {
    const colors = buildBrandColors({
      modelColors: [
        { hex: "#ff00ff", name: "Magic", category: "accent" }, // never harvested
        { hex: "#ffc400", name: "Banana", category: "accent" },
      ],
      rankedColors: HARVESTED,
      accentCandidates: ACCENTS,
    });
    expect(colors.some((entry) => entry.hex === "#ff00ff")).toBe(false);
    expect(colors.some((entry) => entry.hex === "#ffc400")).toBe(true);
  });

  it("falls back to the declared variable name when the model returned nothing", () => {
    const colors = buildBrandColors({
      modelColors: [],
      rankedColors: HARVESTED,
      accentCandidates: ACCENTS,
    });
    expect(colors.find((entry) => entry.hex === "#ffc400")?.name).toBe("Banana");
    expect(colors.find((entry) => entry.hex === "#0b1120")?.name).toBe("Ink");
    // A meaningless variable name gets a description of the color instead.
    expect(colors.find((entry) => entry.hex === "#3730a3")?.name).toBe("Blue");
    expect(colors.every((entry) => entry.origin === "scraped")).toBe(true);
  });

  it("puts the harvester's high-chroma candidates in the accent group", () => {
    const colors = buildBrandColors({
      modelColors: [],
      rankedColors: HARVESTED,
      accentCandidates: ACCENTS,
    });
    expect(colors.find((entry) => entry.hex === "#ffc400")?.category).toBe("accent");
    expect(colors.find((entry) => entry.hex === "#0b1120")?.category).toBe("primary");
  });

  it("stops early rather than padding a thin palette (§3.3: a shape, not a cardinality)", () => {
    const colors = buildBrandColors({
      modelColors: [],
      rankedColors: [ranked({ color: "#0b1120", variableName: "--ink" })],
      accentCandidates: [],
    });
    expect(colors).toHaveLength(1);
    expect(colors[0]?.category).toBe("primary");
  });

  it("aims for two per category and no more", () => {
    const manyNeutrals = Array.from({ length: 9 }, (_, index) =>
      ranked({ color: `#${(index + 1).toString(16).repeat(6)}`, count: 20 - index }),
    );
    const colors = buildBrandColors({
      modelColors: [],
      rankedColors: manyNeutrals,
      accentCandidates: [],
    });
    expect(colors.filter((entry) => entry.category === "primary")).toHaveLength(2);
    expect(colors.filter((entry) => entry.category === "secondary")).toHaveLength(2);
  });

  it("never emits the same color twice, whichever pass proposed it", () => {
    const colors = buildBrandColors({
      modelColors: [
        { hex: "#ffc400", name: "Banana", category: "accent" },
        { hex: "#FFC400", name: "Banana Again", category: "primary" },
      ],
      rankedColors: HARVESTED,
      accentCandidates: ACCENTS,
    });
    expect(colors.filter((entry) => entry.hex === "#ffc400")).toHaveLength(1);
    expect(new Set(colors.map((entry) => entry.id)).size).toBe(colors.length);
  });

  it("gives every entry a dense order within its category", () => {
    const colors = buildBrandColors({
      modelColors: [],
      rankedColors: HARVESTED,
      accentCandidates: ACCENTS,
    });
    const primaries = colors.filter((entry) => entry.category === "primary");
    expect(primaries.map((entry) => entry.orderIndex)).toEqual(
      primaries.map((_, index) => index),
    );
  });
});
