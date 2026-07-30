import { describe, expect, it } from "vitest";
import type { ColumnBlock, RowBlock } from "../schema/blocks";
import type { RandomFn } from "../schema/ids";
import { buildColumns, computeEqualColumnWidths } from "./build-columns";
import { createIdAllocator, type LeafSpec } from "./build-helpers";

/** Deterministic LCG so allocated ids are stable across runs. */
function createSeededRandom(seed = 42): RandomFn {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const textLeaf: LeafSpec = {
  kind: "text",
  text: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] },
};

describe("computeEqualColumnWidths", () => {
  it.each([
    [1, [100]],
    [2, [50, 50]],
    [3, [33.34, 33.33, 33.33]],
    [4, [25, 25, 25, 25]],
  ])("splits %i columns into widths that sum to exactly 100", (count, expected) => {
    const widths = computeEqualColumnWidths(count);
    expect(widths).toEqual(expected);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(100);
  });

  it("rejects non-positive and fractional counts", () => {
    expect(() => computeEqualColumnWidths(0)).toThrow(/invalid column count/);
    expect(() => computeEqualColumnWidths(2.5)).toThrow(/invalid column count/);
  });
});

describe("buildColumns", () => {
  it.each([2, 3, 4])("builds a %i-column row: parentIds wired, widths sum to 100", (count) => {
    const allocateId = createIdAllocator(createSeededRandom());
    const { rowId, blocks } = buildColumns({
      sectionId: "sec_test",
      columns: Array.from({ length: count }, () => ({ leaves: [textLeaf] })),
      allocateId,
    });

    const row = blocks[0] as RowBlock;
    expect(row.id).toBe(rowId);
    expect(row.type).toBe("row");
    expect(row.parentId).toBe("sec_test");

    const columns = blocks.filter((block) => block.type === "column") as ColumnBlock[];
    expect(columns).toHaveLength(count);
    expect(row.childrenIds).toEqual(columns.map((column) => column.id));
    for (const column of columns) {
      expect(column.parentId).toBe(rowId);
      expect(column.childrenIds).toHaveLength(1);
    }
    const widthSum = columns.reduce(
      (total, column) => total + (column.properties.widthPercent ?? 0),
      0,
    );
    expect(widthSum).toBe(100);

    const leaves = blocks.filter((block) => block.type === "text");
    expect(leaves).toHaveLength(count);
    for (const leaf of leaves) {
      expect(columns.some((column) => column.id === leaf.parentId)).toBe(true);
    }

    // Every generated id is unique.
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  });

  it("honors explicit widths that sum to 100 (40/60 header split)", () => {
    const allocateId = createIdAllocator(createSeededRandom());
    const { blocks } = buildColumns({
      sectionId: "sec_test",
      columns: [
        { widthPercent: 40, verticalAlign: "middle", leaves: [textLeaf] },
        { widthPercent: 60, verticalAlign: "middle", leaves: [textLeaf] },
      ],
      allocateId,
    });
    const columns = blocks.filter((block) => block.type === "column") as ColumnBlock[];
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([40, 60]);
    expect(columns.map((column) => column.properties.verticalAlign)).toEqual(["middle", "middle"]);
  });

  it("rejects explicit widths that do not sum to 100", () => {
    const allocateId = createIdAllocator(createSeededRandom());
    expect(() =>
      buildColumns({
        sectionId: "sec_test",
        columns: [
          { widthPercent: 40, leaves: [textLeaf] },
          { widthPercent: 50, leaves: [textLeaf] },
        ],
        allocateId,
      }),
    ).toThrow(/must sum to 100/);
  });

  it("rejects mixed explicit/omitted widths", () => {
    const allocateId = createIdAllocator(createSeededRandom());
    expect(() =>
      buildColumns({
        sectionId: "sec_test",
        columns: [{ widthPercent: 40, leaves: [textLeaf] }, { leaves: [textLeaf] }],
        allocateId,
      }),
    ).toThrow(/every column of a row or on none/);
  });

  it("rejects single-column and five-column rows", () => {
    const allocateId = createIdAllocator(createSeededRandom());
    expect(() =>
      buildColumns({ sectionId: "sec_test", columns: [{ leaves: [textLeaf] }], allocateId }),
    ).toThrow(/2–4 columns/);
    expect(() =>
      buildColumns({
        sectionId: "sec_test",
        columns: Array.from({ length: 5 }, () => ({ leaves: [textLeaf] })),
        allocateId,
      }),
    ).toThrow(/2–4 columns/);
  });
});
