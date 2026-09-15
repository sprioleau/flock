import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { parseHtmlEmailImport } from "@/lib/html-email-import";
import { HtmlImportPreviewContent, isHtmlImportFile } from "./HtmlEmailImportDialog";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      current.forEach((child) => visit(child as ReactNode));
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
    visit(element.props.render as ReactNode);
  };
  visit(node);
  return found;
}

function findByTestId(node: ReactNode, testId: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["data-testid"] === testId);
}

describe("HtmlImportPreviewContent", () => {
  it("accepts only HTML files within the parser's size limit", () => {
    expect(isHtmlImportFile({ name: "newsletter.html", type: "text/html", size: 20 })).toBe(true);
    expect(isHtmlImportFile({ name: "newsletter.txt", type: "text/plain", size: 20 })).toBe(false);
    expect(isHtmlImportFile({ name: "newsletter.html", type: "text/html", size: 512 * 1024 + 1 })).toBe(false);
  });

  it("exposes converted email, unsupported constructs, sanitized source, and confirmation", () => {
    const result = parseHtmlEmailImport({
      html: `<body><p>Hello</p><iframe src="https://bad.example"></iframe></body>`,
    });
    let hasConfirmed = false;
    const tree = HtmlImportPreviewContent({
      result,
      isSaving: false,
      errorMessage: null,
      onConfirm: () => {
        hasConfirmed = true;
      },
    });
    const source = findByTestId(tree, "html-import-sanitized-source");
    const confirm = collectElements(tree).find((element) => element.props.children === "Import as new draft");

    expect(findByTestId(tree, "html-import-converted-email")).toBeDefined();
    expect(source).toBeDefined();
    expect(String(source?.props.children)).not.toMatch(/iframe|https:\/\/bad/i);
    expect(collectElements(tree).some((element) => element.props["aria-label"] === "HTML import conversion report")).toBe(true);
    expect(confirm).toBeDefined();
    expect(typeof confirm?.props.onClick).toBe("function");
    (confirm?.props.onClick as () => void)();
    expect(hasConfirmed).toBe(true);
  });
});
