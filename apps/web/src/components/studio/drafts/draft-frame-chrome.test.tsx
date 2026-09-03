import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "@convex/_generated/dataModel";

vi.mock("convex/react", () => ({
  useConvex: () => ({ mutation: vi.fn() }),
  useQuery: () => undefined,
}));

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: { canvasId: null }) => unknown) => selector({ canvasId: null }),
}));

import { DraftFrameLabel } from "./draft-frame-chrome";
import type { DraftListEntry } from "./use-canvas-drafts";

const DRAFT = {
  _id: "draft_1" as Id<"documents">,
  canvasId: "canvas_1" as Id<"canvases">,
  name: "Launch note",
  orderIndex: 0,
  headVersion: 1,
} as DraftListEntry;

function renderLabel(isActive: boolean): string {
  return renderToStaticMarkup(<DraftFrameLabel draft={DRAFT} isActive={isActive} />);
}

describe("draft frame selection chrome", () => {
  it("gives only the selected draft an explicit outlined state", () => {
    const selected = renderLabel(true);
    const unselected = renderLabel(false);

    expect(selected).toContain('data-draft-selected="true"');
    expect(selected).toContain("outline-primary");
    expect(unselected).toContain('data-draft-selected="false"');
    expect(unselected).not.toContain("outline-primary");
  });

  it("does not put subject, preview, or comma-separated audience inputs above a draft", () => {
    const markup = renderLabel(true);

    expect(markup).not.toContain("Subject for Launch note");
    expect(markup).not.toContain("Preview text for Launch note");
    expect(markup).not.toContain("Audience for Launch note");
    expect(markup).not.toContain("Audience emails, comma-separated");
  });
});
