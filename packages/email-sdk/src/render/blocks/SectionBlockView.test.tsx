import { describe, expect, it } from "vitest";
import { render } from "react-email";
import type { SectionBlock } from "../../schema/blocks";
import { resolveBlockStyles } from "../styles";
import { SectionBlockView } from "./SectionBlockView";

function sectionBlock(properties: SectionBlock["properties"] = {}): SectionBlock {
  return {
    id: "sec_a1b2",
    type: "section",
    parentId: "root",
    childrenIds: [],
    properties,
  };
}

describe("SectionBlockView", () => {
  it("renders a section background image on the content container with a color fallback", async () => {
    const block = sectionBlock({
      innerBackgroundColor: "#f8f7f2",
      outerBackgroundColor: "#101010",
      backgroundImageUrl: "https://cdn.example.com/hero.jpg",
      backgroundSize: "cover",
      backgroundPosition: "top center",
      backgroundRepeat: "no-repeat",
    });
    const html = await render(
      <SectionBlockView block={block} resolvedStyles={resolveBlockStyles(undefined, block)} />,
    );
    expect(html).toContain("background-color:#101010");
    expect(html).toContain("background-color:#f8f7f2");
    expect(html).toContain("background-image:url(&quot;https://cdn.example.com/hero.jpg&quot;)");
    expect(html).toContain("background-size:cover");
    expect(html).toContain("background-position:top center");
    expect(html).toContain("background-repeat:no-repeat");
  });
});
