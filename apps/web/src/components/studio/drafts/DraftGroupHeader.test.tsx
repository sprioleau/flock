import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DraftGroupHeader,
  getDraftGroupClickAction,
  getDraftGroupEditExitAction,
  getShouldCommitDraftGroupEditOnBlur,
  isDraftGroupActivationKey,
  isDraftGroupRenameActivationKey,
  normalizeDraftGroupRenameValue,
} from "./DraftGroupHeader";

describe("DraftGroupHeader", () => {
  it("renders a focus target with accessible group metadata and actions", () => {
    const markup = renderToStaticMarkup(
      <DraftGroupHeader
        groupId="group-dark"
        name="Dark theme"
        description="Blog-post variations"
        draftCount={2}
        isFocused
        onFocusGroup={vi.fn()}
        onRenameGroup={vi.fn()}
        onCreateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onMoveGroup={vi.fn()}
      />,
    );

    expect(markup).toContain('data-draft-group-header="true"');
    expect(markup).toContain('data-action="focus-group"');
    expect(markup).toContain('aria-label="Focus group Dark theme"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("Blog-post variations");
    expect(markup).toContain("2 drafts");
    expect(markup).toContain('aria-label="Rename group Dark theme"');
    expect(markup).toContain('aria-label="Create new group"');
    expect(markup).toContain('aria-label="Delete group Dark theme"');
    expect(markup).toContain('aria-label="Move Dark theme up"');
    expect(markup).toContain('aria-label="Move Dark theme down"');
    expect(markup).toContain('data-action="rename-group-from-name"');
    expect(markup).toContain('title="Click to rename Dark theme"');
  });

  it("treats Enter and Space as group activation keys but not other keys", () => {
    expect(isDraftGroupActivationKey({ key: "Enter" })).toBe(true);
    expect(isDraftGroupActivationKey({ key: " " })).toBe(true);
    expect(isDraftGroupActivationKey({ key: "ArrowRight" })).toBe(false);
    expect(isDraftGroupActivationKey({ key: "Escape" })).toBe(false);
  });

  it("supports conventional keyboard rename and edit exit keys without stealing navigation", () => {
    expect(isDraftGroupRenameActivationKey({ key: "F2" })).toBe(true);
    expect(isDraftGroupRenameActivationKey({ key: "Enter" })).toBe(false);
    expect(getDraftGroupEditExitAction({ key: "Enter" })).toBe("commit");
    expect(getDraftGroupEditExitAction({ key: "Escape" })).toBe("cancel");
    expect(getDraftGroupEditExitAction({ key: "ArrowRight" })).toBeNull();
  });

  it("routes a group title click to rename while preserving background focus", () => {
    expect(
      getDraftGroupClickAction({
        isNameTarget: true,
        isInteractiveControl: true,
      }),
    ).toBe("rename");
    expect(
      getDraftGroupClickAction({
        isNameTarget: false,
        isInteractiveControl: false,
      }),
    ).toBe("focus");
    expect(
      getDraftGroupClickAction({
        isNameTarget: false,
        isInteractiveControl: true,
      }),
    ).toBe("ignore");
  });

  it("commits only when focus leaves the complete group editor", () => {
    expect(
      getShouldCommitDraftGroupEditOnBlur({
        isFocusWithinEditor: false,
      }),
    ).toBe(true);
    expect(
      getShouldCommitDraftGroupEditOnBlur({
        isFocusWithinEditor: true,
      }),
    ).toBe(false);
  });

  it("trims editable values and rejects an empty group name", () => {
    expect(
      normalizeDraftGroupRenameValue({
        name: "  Audience angles  ",
        description: "  High-intent readers  ",
      }),
    ).toEqual({ name: "Audience angles", description: "High-intent readers" });
    expect(normalizeDraftGroupRenameValue({ name: "  ", description: "ignored" })).toBeNull();
    expect(normalizeDraftGroupRenameValue({ name: "Theme", description: "  " })).toEqual({
      name: "Theme",
    });
  });
});
