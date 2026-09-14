import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BrandSourceReferences } from "./BrandSourceReferences";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  function visit(current: ReactNode): void {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
  }
  visit(node);
  return found;
}

function findByAccessibleLabel(node: ReactNode, label: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["aria-label"] === label);
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => textContent(child as ReactNode)).join("");
  }
  if (!isValidElement(node)) {
    return "";
  }
  return textContent((node as ElementWithProps).props.children as ReactNode);
}

const SOURCE_SCREENSHOT = {
  dataUrl: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
  mediaType: "image/jpeg" as const,
  width: 1280,
  height: 1800,
  byteLength: 10,
};

describe("BrandSourceReferences", () => {
  it("labels the screenshot and limits the representative image strip to five unique sources", () => {
    const onEnlarge = vi.fn();
    const tree = BrandSourceReferences({
      sourceUrl: "https://sprioleau.dev/work",
      sourceScreenshot: SOURCE_SCREENSHOT,
      sourceImages: [
        { url: "https://sprioleau.dev/one.jpg", alt: "Portrait" },
        { url: "https://sprioleau.dev/one.jpg", alt: "Duplicate portrait" },
        { url: "https://sprioleau.dev/two.jpg" },
        { url: "https://sprioleau.dev/three.jpg" },
        { url: "https://sprioleau.dev/four.jpg" },
        { url: "https://sprioleau.dev/five.jpg" },
        { url: "https://sprioleau.dev/six.jpg" },
      ],
      onEnlarge,
    });

    expect(textContent(tree)).toContain("Source references");
    expect(findByAccessibleLabel(tree, "Source references")).toBeDefined();
    expect(textContent(tree)).toContain("Visuals captured from sprioleau.dev");
    expect(findByAccessibleLabel(tree, "View page screenshot of sprioleau.dev larger")).toBeDefined();
    expect(findByAccessibleLabel(tree, "View source image 1 larger")).toBeDefined();
    expect(findByAccessibleLabel(tree, "View source image 5 larger")).toBeDefined();
    expect(findByAccessibleLabel(tree, "View source image 6 larger")).toBeUndefined();

    const images = collectElements(tree).filter((element) => element.type === "img");
    expect(images).toHaveLength(6);
    expect(images[0]?.props.alt).toBe("Page screenshot of sprioleau.dev");
    expect(images[1]?.props.alt).toBe("Portrait");
    expect(images[2]?.props.alt).toBe("Source image 2 from sprioleau.dev");

    const screenshotButton = findByAccessibleLabel(
      tree,
      "View page screenshot of sprioleau.dev larger",
    );
    if (screenshotButton === undefined) {
      throw new Error("Expected an accessible screenshot button.");
    }
    (screenshotButton.props.onClick as () => void)();
    expect(onEnlarge).toHaveBeenCalledWith({
      url: SOURCE_SCREENSHOT.dataUrl,
      label: "Page screenshot of sprioleau.dev",
    });
  });

  it("renders the persisted source images without a transient screenshot", () => {
    const tree = BrandSourceReferences({
      sourceUrl: "https://example.com",
      sourceImages: [{ url: "https://example.com/hero.jpg" }],
      onEnlarge: () => {},
    });

    expect(textContent(tree)).toContain("Source references");
    expect(findByAccessibleLabel(tree, "View source image 1 larger")).toBeDefined();
    expect(collectElements(tree).some((element) => element.props.alt === "Page screenshot of example.com"))
      .toBe(false);
  });

  it("stays absent for older kits that have no source references", () => {
    expect(
      BrandSourceReferences({
        sourceUrl: "https://legacy.example",
        onEnlarge: () => {},
      }),
    ).toBeNull();
  });
});
