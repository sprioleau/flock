import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftGroupSection } from "./DraftGroupSection";

describe("DraftGroupSection", () => {
  it("lays drafts out as a horizontal list inside a labelled group row", () => {
    const markup = renderToStaticMarkup(
      <DraftGroupSection
        groupId="group-light"
        name="Light theme"
        draftCount={2}
        onFocusGroup={vi.fn()}
      >
        <article role="listitem" data-testid="draft-a">
          Draft A
        </article>
        <article role="listitem" data-testid="draft-b">
          Draft B
        </article>
      </DraftGroupSection>,
    );

    expect(markup).toContain('data-draft-group-section="true"');
    expect(markup).toContain('data-draft-group-drafts="true"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain("flex-row");
    expect(markup).toContain("Draft A");
    expect(markup).toContain("Draft B");
    expect(markup).not.toContain("No drafts in this group yet.");
  });

  it("provides a useful empty-group state without inventing a draft", () => {
    const markup = renderToStaticMarkup(
      <DraftGroupSection
        groupId="group-empty"
        name="Unsorted"
        draftCount={0}
        onFocusGroup={vi.fn()}
        emptyMessage="Add a draft to start exploring this angle."
      />,
    );

    expect(markup).toContain('data-testid="draft-group-empty"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Add a draft to start exploring this angle.");
  });
});
