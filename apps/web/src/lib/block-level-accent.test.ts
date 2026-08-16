import { describe, expect, it } from "vitest";
import type { BlockType } from "@flock/email-sdk";
import { BLOCK_TYPE_LABELS } from "./block-display-label";
import {
  getBlockLevel,
  getBlockLevelAccent,
  listBlockLevelAccents,
  type BlockLevel,
  type BlockLevelAccent,
} from "./block-level-accent";

/*
  The whole point of this module is that the four nesting levels are told
  apart BY COLOUR, and that the outline the canvas draws and the chip the
  breadcrumb draws are never two different colours for the same block. Those
  two properties are what these tests hold; the pixel placement is CSS and
  belongs to the browser pass.
*/

/*
  The accent functions read the discriminant and nothing else, so a bare
  `{ type }` satisfies them — no fabricated Block, and no cast.
*/
function accentFor(type: BlockType): BlockLevelAccent {
  return getBlockLevelAccent({ block: { type } });
}

/*
  Every Tailwind palette family named anywhere in a class string. The token
  is always preceded by a hyphen (`after:border-sky-500`, `dark:bg-sky-400`),
  a colon, whitespace, or the start of the string — the hyphen sits LAST in
  the character class so it stays literal rather than opening a range.
*/
function huesIn(className: string): Set<string> {
  return new Set(
    [...className.matchAll(/(?:^|[\s:-])(sky|violet|orange|fuchsia|purple|pink|blue|amber)-\d+/g)]
      .map((match) => match[1])
      .filter((hue): hue is string => hue !== undefined),
  );
}

describe("the hue scanner these tests depend on", () => {
  it("finds hues in every shape a class string uses them", () => {
    /*
      A scanner that silently matched nothing would make the "same hue"
      assertions below vacuously pass, so it is pinned first.
    */
    expect(huesIn("after:border-sky-500")).toEqual(new Set(["sky"]));
    expect(huesIn("dark:bg-fuchsia-400")).toEqual(new Set(["fuchsia"]));
    expect(huesIn("border-violet-500/60")).toEqual(new Set(["violet"]));
    expect(huesIn("bg-orange-50 text-white")).toEqual(new Set(["orange"]));
    expect(huesIn("after:border-2 after:border-solid")).toEqual(new Set());
  });

  it("reports BOTH families when a string mixes them", () => {
    expect(huesIn("bg-sky-700 text-orange-200")).toEqual(new Set(["sky", "orange"]));
  });
});

describe("levels", () => {
  it("gives sections, rows, columns and content four SEPARATE levels", () => {
    expect(getBlockLevel({ block: { type: "section" } })).toBe("section");
    expect(getBlockLevel({ block: { type: "row" } })).toBe("row");
    expect(getBlockLevel({ block: { type: "column" } })).toBe("column");
    /* A row is not folded in with columns: each layout level owns a hue. */
    expect(getBlockLevel({ block: { type: "row" } })).not.toBe(
      getBlockLevel({ block: { type: "column" } }),
    );
  });

  it("puts every leaf type on the ONE content level", () => {
    const leafTypes: BlockType[] = ["text", "button", "image", "divider", "link", "code", "spacer"];
    for (const type of leafTypes) {
      expect(getBlockLevel({ block: { type } })).toBe("content");
    }
  });

  it("classifies every block type the SDK has — no block renders without a colour", () => {
    for (const type of Object.keys(BLOCK_TYPE_LABELS) as BlockType[]) {
      expect(getBlockLevel({ block: { type } })).toBeDefined();
    }
  });
});

describe("the four accents", () => {
  it("uses a DISTINCT palette family per level", () => {
    const hues = listBlockLevelAccents().map((accent) => accent.hue);
    expect(hues).toHaveLength(4);
    expect(new Set(hues).size).toBe(4);
  });

  it("keeps content on the existing sky blue the canvas has always used", () => {
    expect(accentFor("text").hue).toBe("sky");
    expect(accentFor("text").selectedOutlineClassName).toContain("after:border-sky-500");
  });

  it("draws no two levels with the same class strings", () => {
    for (const key of [
      "selectedOutlineClassName",
      "hoverPreviewOutlineClassName",
      "selectedChipClassName",
      "ancestorChipClassName",
    ] as const) {
      const values = listBlockLevelAccents().map((accent) => accent[key]);
      expect(new Set(values).size).toBe(4);
    }
  });

  it("paints the chip and the outline of a level in the SAME hue", () => {
    /*
      The owner's requirement in one assertion: the section pill must be the
      colour of the section outline it points at, and so for every level.
    */
    for (const accent of listBlockLevelAccents()) {
      for (const className of [
        accent.selectedOutlineClassName,
        accent.hoverPreviewOutlineClassName,
        accent.pointerOutlineClassName,
        accent.selectedChipClassName,
        accent.ancestorChipClassName,
      ]) {
        expect([...huesIn(className)]).toEqual([accent.hue]);
      }
    }
  });

  it("emits complete literal class names — Tailwind cannot see assembled ones", () => {
    for (const accent of listBlockLevelAccents()) {
      /*
        A stray `${` or a bare hue token would mean a class Tailwind never
        generates, i.e. an invisible outline in production only.
      */
      expect(accent.selectedChipClassName).not.toMatch(/\$\{|\bbg-\s|\bborder-\s/);
      expect(accent.selectedOutlineClassName).toMatch(/after:border-[a-z]+-\d+/);
    }
  });
});

describe("selected vs previewed", () => {
  it("is SOLID when selected and DASHED when a chip is only previewing it", () => {
    for (const accent of listBlockLevelAccents()) {
      expect(accent.selectedOutlineClassName).toContain("after:border-solid");
      expect(accent.selectedOutlineClassName).not.toContain("after:border-dashed");
      expect(accent.hoverPreviewOutlineClassName).toContain("after:border-dashed");
    }
  });

  it("changes ONLY the stroke style between the two — clicking must not shift the colour", () => {
    for (const accent of listBlockLevelAccents()) {
      const asSolid = accent.hoverPreviewOutlineClassName.replace("dashed", "solid");
      expect(asSolid).toBe(accent.selectedOutlineClassName);
    }
  });

  it("weighs both preview and selection at 2px, so nothing jumps on click", () => {
    for (const accent of listBlockLevelAccents()) {
      expect(accent.selectedOutlineClassName).toContain("after:border-2");
      expect(accent.hoverPreviewOutlineClassName).toContain("after:border-2");
    }
  });
});

describe("light and dark", () => {
  it("gives every chip a dark-mode fill AND a dark-mode text colour", () => {
    /*
      Chips sit in the studio gutter, which follows the app theme; a fill
      swapped without its text colour is how these go unreadable in dark.
    */
    for (const accent of listBlockLevelAccents()) {
      for (const chip of [accent.selectedChipClassName, accent.ancestorChipClassName]) {
        expect(chip).toMatch(/dark:bg-/);
        expect(chip).toMatch(/dark:text-/);
      }
    }
  });

  it("leaves the OUTLINES theme-independent — they are painted on email pixels", () => {
    /*
      EditorCanvas: email pixels come from document inline styles and never
      react to the app theme, so a `dark:` stroke would lighten the outline
      against a still-white email.
    */
    for (const accent of listBlockLevelAccents()) {
      expect(accent.selectedOutlineClassName).not.toContain("dark:");
      expect(accent.hoverPreviewOutlineClassName).not.toContain("dark:");
      expect(accent.pointerOutlineClassName).not.toContain("dark:");
    }
  });

  it("fills selected chips darker than ancestor chips in light mode", () => {
    /*
      The selected chip is the loudest thing in the stack; ancestors are a
      tint of the same hue so the stack still reads as a hierarchy.
    */
    for (const accent of listBlockLevelAccents()) {
      expect(accent.selectedChipClassName).toContain(`bg-${accent.hue}-700`);
      expect(accent.selectedChipClassName).toContain("text-white");
      expect(accent.ancestorChipClassName).toContain(`bg-${accent.hue}-50`);
      expect(accent.ancestorChipClassName).toContain(`text-${accent.hue}-700`);
    }
  });
});

describe("against the drag-and-drop highlight", () => {
  it("never reuses the drop-container's own sky-300 stroke for a level outline", () => {
    /*
      BlockShell paints a valid drop container `bg-sky-400/10` +
      `after:border-sky-300`. A level outline that landed on the same shade
      would make "you can drop here" indistinguishable from "this is a row".
    */
    const levelStrokes = listBlockLevelAccents().flatMap((accent) => [
      accent.selectedOutlineClassName,
      accent.hoverPreviewOutlineClassName,
    ]);
    for (const stroke of levelStrokes) {
      expect(stroke).not.toContain("after:border-sky-300");
    }
  });

  it("keeps the row hue clear of the sky family the drop highlight owns", () => {
    /*
      Rows and columns are the drop containers that light up, so these are
      the pairs that have to stay legible side by side.
    */
    expect(accentFor("row").hue).toBe("orange");
    expect(accentFor("row").selectedOutlineClassName).not.toContain("sky");
    expect(accentFor("column").selectedOutlineClassName).not.toContain("sky");
  });
});

describe("the level union", () => {
  it("has an accent for each member — a new level cannot ship uncoloured", () => {
    const levels: BlockLevel[] = ["content", "column", "row", "section"];
    expect(listBlockLevelAccents().map((accent) => accent.level).sort()).toEqual([...levels].sort());
  });
});
