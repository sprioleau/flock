import type { Block, ColumnBlock, RowBlock } from "../schema/blocks";
import { buildLeafBlock, type AllocateBlockId, type LeafSpec } from "./build-helpers";

/*
  `buildColumns` — the shared row/column assembler every multi-column
  template reuses (feature grids, image galleries, stats rows, split
  headers). Owns the widthPercent arithmetic: explicit widths must sum to
  100; omitted widths get an equal split that sums to exactly 100 for 2, 3,
  or 4 columns (33.34/33.33/33.33-style rounding).
*/

export interface ColumnSpec {
  /*
    This column's share of the row width (1–100). Give it on EVERY column of
    the row or on NONE: all-omitted rows get an equal split.
  */
  widthPercent?: number;
  /*
    Vertical alignment relative to sibling columns (structural, theme-free).
  */
  verticalAlign?: "top" | "middle" | "bottom";
  /*
    The column's leaf blocks, top to bottom.
  */
  leaves: LeafSpec[];
}

export interface BuildColumnsInput {
  /*
    Id of the section the new row belongs to.
  */
  sectionId: string;
  /*
    The row's columns, left to right.
  */
  columns: ColumnSpec[];
  allocateId: AllocateBlockId;
}

export interface BuildColumnsResult {
  /*
    The new row's id — append it to the section's childrenIds.
  */
  rowId: string;
  /*
    Row, then columns, then leaves — parentIds wired, root-first order.
  */
  blocks: Block[];
}

/*
  Equal-split percentages that sum to EXACTLY 100: every column gets the
  two-decimal floor of 100/count and the first column absorbs the remainder
  (3 → 33.34 / 33.33 / 33.33).
*/
export function computeEqualColumnWidths(count: number): number[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`computeEqualColumnWidths: invalid column count ${count} — expected a positive integer.`);
  }
  const base = Math.floor(10000 / count) / 100;
  const first = Math.round((100 - base * (count - 1)) * 100) / 100;
  return [first, ...Array.from({ length: count - 1 }, () => base)];
}

const WIDTH_SUM_TOLERANCE = 0.01;

/*
  Resolve the row's per-column widths (explicit-all or equal split).
*/
function resolveColumnWidths(columns: ColumnSpec[]): number[] {
  const explicitWidths = columns.filter((column) => column.widthPercent !== undefined);
  if (explicitWidths.length === 0) {
    return computeEqualColumnWidths(columns.length);
  }
  if (explicitWidths.length !== columns.length) {
    throw new Error(
      "buildColumns: give widthPercent on every column of a row or on none — mixed rows are ambiguous.",
    );
  }
  const widths = columns.map((column) => column.widthPercent as number);
  const sum = widths.reduce((total, width) => total + width, 0);
  if (Math.abs(sum - 100) > WIDTH_SUM_TOLERANCE) {
    throw new Error(
      `buildColumns: explicit column widths must sum to 100, got ${sum} (${widths.join(" + ")}).`,
    );
  }
  return widths;
}

/*
  Build one row of columns: row + column blocks + leaves, parentIds wired.
*/
export function buildColumns({ sectionId, columns, allocateId }: BuildColumnsInput): BuildColumnsResult {
  if (columns.length < 2 || columns.length > 4) {
    throw new Error(
      `buildColumns: a row holds 2–4 columns, got ${columns.length}. Single-column content goes directly in the section.`,
    );
  }
  const widths = resolveColumnWidths(columns);
  const rowId = allocateId("row");
  const columnBlocks: ColumnBlock[] = [];
  const leafBlocks: Block[] = [];

  for (const [index, column] of columns.entries()) {
    const columnId = allocateId("column");
    const leafIds: string[] = [];
    for (const spec of column.leaves) {
      const leaf = buildLeafBlock({ spec, parentId: columnId, allocateId });
      leafIds.push(leaf.id);
      leafBlocks.push(leaf);
    }
    columnBlocks.push({
      id: columnId,
      type: "column",
      parentId: rowId,
      childrenIds: leafIds,
      properties: {
        widthPercent: widths[index] as number,
        ...(column.verticalAlign !== undefined ? { verticalAlign: column.verticalAlign } : {}),
      },
    });
  }

  const row: RowBlock = {
    id: rowId,
    type: "row",
    parentId: sectionId,
    childrenIds: columnBlocks.map((column) => column.id),
    properties: {},
  };

  return { rowId, blocks: [row, ...columnBlocks, ...leafBlocks] };
}
