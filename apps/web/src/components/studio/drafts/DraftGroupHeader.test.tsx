import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DraftGroupHeader,
  isDraftGroupActivationKey,
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
        onCreateDraft={vi.fn()}
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
    expect(markup).toContain('aria-label="Edit Dark theme"');
    expect(markup).toContain('aria-label="Create draft in Dark theme"');
    expect(markup).toContain('aria-label="Delete group Dark theme"');
    expect(markup).toContain('aria-label="Move Dark theme up"');
    expect(markup).toContain('aria-label="Move Dark theme down"');
  });

  it("treats Enter and Space as group activation keys but not other keys", () => {
    expect(isDraftGroupActivationKey({ key: "Enter" })).toBe(true);
    expect(isDraftGroupActivationKey({ key: " " })).toBe(true);
    expect(isDraftGroupActivationKey({ key: "ArrowRight" })).toBe(false);
    expect(isDraftGroupActivationKey({ key: "Escape" })).toBe(false);
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
