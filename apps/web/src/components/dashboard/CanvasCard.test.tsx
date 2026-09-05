import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterDocument } from "@flock/email-sdk";
import type { Id } from "@convex/_generated/dataModel";

const useQuery = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({ useQuery }));
vi.mock("../studio/history/ReadOnlyEmailPreview", () => ({
  ReadOnlyEmailPreview: function ReadOnlyEmailPreview() {
    return null;
  },
}));

import { CanvasCard, CanvasThumbnail } from "./CanvasCard";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      current.forEach((child) => visit(child));
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
  };
  visit(node);
  return found;
}

const firstDocument = {
  documentId: "doc_first" as Id<"documents">,
  name: "First draft",
  doc: createStarterDocument(),
};
const secondDocument = {
  documentId: "doc_second" as Id<"documents">,
  name: "Second draft",
  doc: createStarterDocument(),
};

beforeEach(() => {
  useQuery.mockReset();
  useQuery.mockReturnValue([firstDocument, secondDocument]);
});

describe("CanvasThumbnail", () => {
  it("renders every returned draft as a real read-only preview tile", () => {
    const tree = CanvasThumbnail({
      documents: [firstDocument, secondDocument],
      draftCount: 2,
    });
    const elements = collectElements(tree);
    const thumbnail = elements.find(
      (element) => element.props["data-testid"] === "canvas-card-thumbnail",
    );
    const draftTiles = elements.filter((element) => element.props["data-draft-id"] !== undefined);

    expect(thumbnail?.props["aria-hidden"]).toBe("true");
    expect(thumbnail?.props.inert).toBe(true);
    expect(draftTiles.map((element) => element.props["data-draft-id"])).toEqual([
      "doc_first",
      "doc_second",
    ]);
    expect(draftTiles.every((element) => String(element.props.className).includes("h-full"))).toBe(
      true,
    );
  });
});

describe("CanvasCard", () => {
  it("keeps card geometry fixed while the thumbnail data changes", () => {
    const tree = CanvasCard({
      entry: {
        canvasId: "canvas_one" as Id<"canvases">,
        title: "Launch email",
        isTitleDerived: false,
        draftCount: 2,
        entryDocumentId: firstDocument.documentId,
        draftPreviews: [firstDocument, secondDocument],
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      nowMs: 0,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      sessionId: "session-owner",
    });
    const card = collectElements(tree).find((element) => element.props["data-testid"] === "canvas-card");

    expect(card?.props.className).toContain("h-[26rem]");
    expect(card?.props.className).toContain("min-w-0");
    expect(useQuery).toHaveBeenCalledWith(expect.anything(), {
      canvasId: "canvas_one",
      sessionId: "session-owner",
    });
  });
});
