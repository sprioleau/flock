import { describe, expect, it } from "vitest";
import { render } from "react-email";
import type { ColumnBlock } from "../../schema/blocks";
import { resolveBlockStyles } from "../styles";
import { ColumnBlockView } from "./ColumnBlockView";

function columnBlock(properties: ColumnBlock["properties"] = {}): ColumnBlock {
  return {
    id: "col_a1b2",
    type: "column",
    parentId: "row_a1b2",
    childrenIds: [],
    properties,
  };
}

describe("ColumnBlockView", () => {
  it("renders a column background image and preserves its fallback color", async () => {
    const block = columnBlock({
      backgroundColor: "#eeeeee",
      backgroundImageUrl: "https://cdn.example.com/column.jpg",
      backgroundSize: "contain",
      backgroundPosition: "bottom right",
      backgroundRepeat: "repeat-y",
    });
    const html = await render(
      <ColumnBlockView block={block} resolvedStyles={resolveBlockStyles(undefined, block)} />,
    );
    expect(html).toContain("background-color:#eeeeee");
    expect(html).toContain("background-image:url(&quot;https://cdn.example.com/column.jpg&quot;)");
    expect(html).toContain("background-size:contain");
    expect(html).toContain("background-position:bottom right");
    expect(html).toContain("background-repeat:repeat-y");
  });
});
