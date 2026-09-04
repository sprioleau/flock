import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DraftGroupMoveDraftMenu,
  buildDraftGroupMoveDraftInput,
  getDraftGroupMoveDestinations,
} from "./DraftGroupMoveDraftMenu";

const GROUPS = [
  { groupId: "group-dark", name: "Dark theme" },
  { groupId: "group-light", name: "Light theme" },
  { groupId: "group-plain", name: "Plain language" },
] as const;

describe("DraftGroupMoveDraftMenu", () => {
  it("never offers the draft's current group as a move destination", () => {
    expect(
      getDraftGroupMoveDestinations({ groups: GROUPS, currentGroupId: "group-light" }),
    ).toEqual([
      { groupId: "group-dark", name: "Dark theme" },
      { groupId: "group-plain", name: "Plain language" },
    ]);
  });

  it("builds an explicit move payload for the reusable menu item", () => {
    expect(
      buildDraftGroupMoveDraftInput({
        draftId: "draft-7",
        fromGroupId: "group-dark",
        destination: { groupId: "group-light", name: "Light theme" },
      }),
    ).toEqual({ draftId: "draft-7", fromGroupId: "group-dark", toGroupId: "group-light" });
  });

  it("labels the trigger with the draft identity and renders available groups", () => {
    const markup = renderToStaticMarkup(
      <DraftGroupMoveDraftMenu
        draftId="draft-7"
        draftName="Launch note"
        currentGroupId="group-dark"
        groups={GROUPS}
        onMoveDraft={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Move Launch note to another group"');
    expect(markup).toContain('data-testid="draft-group-move-trigger"');
  });
});
