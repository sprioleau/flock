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

import {
  DraftFrameLabel,
  DraftFrameSelectionRegion,
  EDITOR_FRAME_DESKTOP_WIDTH_PX,
  PREVIEW_FRAME_WIDTH_PX,
} from "./draft-frame-chrome";
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

function renderLabelWithActions(): string {
  return renderToStaticMarkup(
    <DraftFrameLabel
      draft={DRAFT}
      isActive
      actions={<button type="button">Move draft</button>}
    />,
  );
}

function renderSelectionRegion(isActive: boolean): string {
  return renderToStaticMarkup(
    <DraftFrameSelectionRegion isActive={isActive}>
      <DraftFrameLabel draft={DRAFT} isActive={isActive} />
      <div data-testid="draft-body">Email body</div>
    </DraftFrameSelectionRegion>,
  );
}

describe("draft frame selection chrome", () => {
  it("keeps draft dimensions identical when selection moves between drafts", () => {
    const selectedDraftWidth = EDITOR_FRAME_DESKTOP_WIDTH_PX;
    const previouslySelectedDraftWidth = PREVIEW_FRAME_WIDTH_PX;

    expect(selectedDraftWidth).toBe(previouslySelectedDraftWidth);
  });

  it("uses one selected region for the title and email body", () => {
    const selected = renderSelectionRegion(true);

    expect(selected.match(/data-draft-selection-region/g)).toHaveLength(1);
    expect(selected.match(/data-draft-selected="true"/g)).toHaveLength(1);
    expect(selected).toContain("Launch note");
    expect(selected).toContain("Email body");
    expect(selected.match(/border-primary/g)).toHaveLength(1);
    expect(selected).not.toContain("outline-primary");
  });

  it("does not outline an inactive draft region", () => {
    const unselected = renderSelectionRegion(false);

    expect(unselected).toContain('data-draft-selected="false"');
    expect(unselected).not.toContain("border-primary");
  });

  it("does not put subject, preview, or comma-separated audience inputs above a draft", () => {
    const markup = renderLabel(true);

    expect(markup).not.toContain("Subject for Launch note");
    expect(markup).not.toContain("Preview text for Launch note");
    expect(markup).not.toContain("Audience for Launch note");
    expect(markup).not.toContain("Audience emails, comma-separated");
  });

  it("keeps the title inset from the shared selection outline", () => {
    const markup = renderLabel(true);

    expect(markup).toMatch(/^<div class="shrink-0 px-2 py-1">/);
    expect(markup).not.toMatch(/class="[^"]*(?:border|outline|ring)-primary[^"]*"/);
  });

  it("keeps draft actions in the same inset title row without adding selection chrome", () => {
    const markup = renderLabelWithActions();

    expect(markup).toContain("Launch note");
    expect(markup).toContain("Move draft");
    expect(markup).not.toMatch(/class="[^"]*(?:border|outline|ring)-primary[^"]*"/);
  });
});
