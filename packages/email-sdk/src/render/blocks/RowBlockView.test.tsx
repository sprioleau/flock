import { describe, expect, it } from "vitest";
import { render } from "react-email";
import type { RowBlock } from "../../schema/blocks";
import { resolveBlockStyles } from "../styles";
import { RowBlockView } from "./RowBlockView";

/*
  The row's padding/background wrapper. A row paints on a wrapping <td>
  because <Row> is a border-collapsed table, which ignores padding and is an
  unreliable background surface in Word-engine Outlook. The wrapper is emitted
  only when there is something to paint, so unstyled rows keep their historic
  markup (the golden snapshots cover that side).
*/

function rowBlock(properties: RowBlock["properties"] = {}): RowBlock {
  return {
    id: "row_a1b2",
    type: "row",
    parentId: "sec_a1b2",
    childrenIds: [],
    properties,
  };
}

async function renderRow(properties: RowBlock["properties"] = {}) {
  const block = rowBlock(properties);
  return render(<RowBlockView block={block} resolvedStyles={resolveBlockStyles(undefined, block)} />);
}

describe("RowBlockView", () => {
  it("renders no wrapper cell when the row carries no padding and no background", async () => {
    const html = await renderRow();
    expect(html).not.toContain("border-collapse:collapse");
    expect(html).not.toContain("background-color");
  });

  it("paints backgroundColor on the wrapping cell", async () => {
    const html = await renderRow({ backgroundColor: "#f4f4f5" });
    expect(html).toMatch(/<td[^>]*background-color:#f4f4f5/);
  });

  it("emits the wrapper for a background alone, with zero padding", async () => {
    const html = await renderRow({ backgroundColor: "#f4f4f5" });
    expect(html).toMatch(/<td[^>]*padding-top:0px/);
    expect(html).toMatch(/<td[^>]*padding-left:0px/);
  });

  it("applies horizontal padding, not only vertical", async () => {
    const html = await renderRow({ paddingLeft: 16, paddingRight: 24 });
    expect(html).toMatch(/<td[^>]*padding-left:16px/);
    expect(html).toMatch(/<td[^>]*padding-right:24px/);
  });

  it("applies padding and background together on one cell", async () => {
    const html = await renderRow({ paddingTop: 8, paddingLeft: 12, backgroundColor: "#111827" });
    expect(html).toMatch(/<td[^>]*padding-top:8px[^>]*background-color:#111827/);
    expect(html).toMatch(/<td[^>]*padding-left:12px/);
  });
});
