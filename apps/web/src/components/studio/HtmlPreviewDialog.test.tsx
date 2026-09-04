import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  PreviewDialogColumns,
  PreviewViewPanel,
  type RenderState,
} from "./HtmlPreviewDialog";
import { PREVIEW_VIEWS, selectCopyText } from "./html-preview-client";

/*
  Which email the preview panel actually puts on screen for each tab.

  `html-preview-client.test.ts` pins the DECISIONS — which views exist, and
  which string each view's Copy button lifts. What it cannot see is whether
  the panel honours them: `prettyHtml` and `plainText` arrive in one object,
  so a transposed pair would keep every clipboard test green while the Plain
  text tab rendered HTML. That wiring is what this file holds down.

  There is no DOM here (vitest.config.ts pins `environment: "node"`), so the
  panel is called as a plain function over its props and the element tree it
  returns is walked. Scroll behaviour, monospace and the tab strip's
  appearance are CSS and belong to the browser pass.
*/

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
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
    /*
      Base UI composes a control by taking it as a `render` PROP rather than
      as a child, so a children-only walker would report present controls as
      absent — see DemoRunPanel.test.tsx for the full note.
    */
    visit(element.props.render as ReactNode);
  };
  visit(node);
  return found;
}

function findByTestId(node: ReactNode, testId: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["data-testid"] === testId);
}

function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (current: ReactNode): void => {
    if (typeof current === "string" || typeof current === "number") {
      parts.push(String(current));
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    visit((current as ElementWithProps).props.children as ReactNode);
  };
  visit(node);
  return parts.join(" ");
}

/*
  Three deliberately distinct strings: any test that passes by reading the
  wrong field of this object is reading text it can be caught holding.
*/
const RENDER = {
  html: "<html><body>minified send html</body></html>",
  prettyHtml: "<html>\n  <body>pretty source</body>\n</html>",
  plainText: "WELCOME\n\nRead the docs https://example.com/docs",
};

const OK_STATE: RenderState = { status: "ok", render: RENDER };

describe("the preview panel", () => {
  it("keeps the send form in the left column and the full-height preview in the right", () => {
    const tree = PreviewDialogColumns({
      form: <div data-testid="form-marker">Send test form</div>,
      preview: <div data-testid="preview-marker">Rendered preview</div>,
    });
    const formColumn = findByTestId(tree, "html-preview-form-column");
    const previewColumn = findByTestId(tree, "html-preview-preview-column");

    expect(formColumn?.props.className).toContain("overflow-y-auto");
    expect(previewColumn?.props.className).toContain("min-h-0");
    expect(previewColumn?.props.className).toContain("flex");
    expect(findByTestId(formColumn?.props.children as ReactNode, "form-marker")).toBeDefined();
    expect(
      findByTestId(previewColumn?.props.children as ReactNode, "preview-marker"),
    ).toBeDefined();
  });

  it("shows the rendered email in a sandboxed iframe, from the minified send-HTML", () => {
    const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: "preview" });
    const iframe = findByTestId(tree, "html-preview-iframe");

    expect(iframe?.props.srcDoc).toBe(RENDER.html);
    expect(iframe?.props.scrolling).toBe("yes");
    /*
      An empty sandbox is the whole reason arbitrary rendered email is safe to
      put on screen; losing it would not fail any other assertion here.
    */
    expect(iframe?.props.sandbox).toBe("");
  });

  it("gives the rendered preview a full-height, vertically scrollable viewport", () => {
    const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: "preview" });
    const viewport = findByTestId(tree, "html-preview-rendered-viewport");
    const panel = findByTestId(tree, "html-preview-panel");
    const iframe = findByTestId(tree, "html-preview-iframe");

    expect(panel?.props.className).toContain("flex-1");
    expect(viewport?.props.className).toContain("flex-1");
    expect(viewport?.props.className).toContain("overflow-y-auto");
    expect(iframe?.props.className).toContain("h-full");
    expect(iframe?.props.className).toContain("min-h-");
  });

  it("exposes accessible desktop/mobile controls and preserves the selected viewport", () => {
    let selectedViewport = "desktop";
    const tree = PreviewViewPanel({
      renderState: OK_STATE,
      activeViewId: "preview",
      viewport: "mobile",
      onViewportChange: (viewport) => {
        selectedViewport = viewport;
      },
    });
    const desktop = findByTestId(tree, "html-preview-viewport-desktop");
    const mobile = findByTestId(tree, "html-preview-viewport-mobile");
    const renderedViewport = findByTestId(tree, "html-preview-rendered-viewport");
    const renderedSurface = findByTestId(tree, "html-preview-rendered-surface");

    expect(desktop?.props["aria-pressed"]).toBe(false);
    expect(mobile?.props["aria-pressed"]).toBe(true);
    expect(desktop?.props["aria-label"]).toBe("Desktop email viewport");
    expect(mobile?.props["aria-label"]).toBe("Mobile email viewport");
    expect(renderedViewport?.props["data-viewport"]).toBe("mobile");
    expect(renderedSurface?.props.className).toContain("w-[390px]");

    const selectDesktopViewport = desktop?.props.onClick;
    expect(typeof selectDesktopViewport).toBe("function");
    if (typeof selectDesktopViewport === "function") {
      selectDesktopViewport();
    }
    expect(selectedViewport).toBe("desktop");
  });

  it("uses the preview-pane width for the desktop viewport", () => {
    const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: "preview" });
    const renderedViewport = findByTestId(tree, "html-preview-rendered-viewport");
    const renderedSurface = findByTestId(tree, "html-preview-rendered-surface");

    expect(renderedViewport?.props["data-viewport"]).toBe("desktop");
    expect(renderedSurface?.props.className).toContain("w-full");
  });

  it("shows the pretty source — not the minified string — on the HTML view", () => {
    const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: "html" });

    expect(visibleText(findByTestId(tree, "html-preview-source"))).toBe(RENDER.prettyHtml);
    expect(findByTestId(tree, "html-preview-plain-text")).toBeUndefined();
  });

  it("shows the plain text on the Plain text view, and no HTML alongside it", () => {
    const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: "text" });

    expect(visibleText(findByTestId(tree, "html-preview-plain-text"))).toBe(RENDER.plainText);
    expect(findByTestId(tree, "html-preview-source")).toBeUndefined();
    expect(findByTestId(tree, "html-preview-iframe")).toBeUndefined();
  });

  it("renders exactly one view at a time, whichever tab is selected", () => {
    for (const view of PREVIEW_VIEWS) {
      const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: view.id });
      const shown = [
        "html-preview-iframe",
        "html-preview-source",
        "html-preview-plain-text",
      ].filter((testId) => findByTestId(tree, testId) !== undefined);

      expect(shown).toHaveLength(1);
    }
  });

  it("gives Copy the text the user is looking at, for every view that offers it", () => {
    /*
      The bug this guards is a transposition: Copy lifting the OTHER view's
      string still copies something, so only comparing against what is on
      screen catches it.
    */
    for (const view of PREVIEW_VIEWS) {
      const copyText = selectCopyText({ view: view.id, render: RENDER });
      if (copyText === null) {
        continue;
      }
      const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: view.id });
      const panelTestId = view.id === "html" ? "html-preview-source" : "html-preview-plain-text";
      const shown = findByTestId(tree, panelTestId);

      expect(visibleText(shown)).toBe(copyText);
    }
  });

  it("shows the failure instead of an empty tab when the render did not come back", () => {
    const tree = PreviewViewPanel({
      renderState: { status: "error", message: "Couldn't reach the renderer." },
      activeViewId: "text",
    });

    expect(visibleText(findByTestId(tree, "html-preview-error"))).toBe(
      "Couldn't reach the renderer.",
    );
    expect(findByTestId(tree, "html-preview-plain-text")).toBeUndefined();
  });

  it("keeps the tab panel addressable by the tab strip that controls it", () => {
    /*
      The tabs carry aria-controls="html-preview-panel"; a renamed id here
      would break the association silently for screen readers.
    */
    const tree = PreviewViewPanel({ renderState: OK_STATE, activeViewId: "text" });
    const panel = collectElements(tree)[0];

    expect(panel.props.id).toBe("html-preview-panel");
    expect(panel.props.role).toBe("tabpanel");
  });
});
