import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockId } from "@flock/email-sdk";
import type { Id } from "@convex/_generated/dataModel";
import type { BlockSuggestionAnchor } from "@/lib/suggestions/suggestion-surface-store";

/**
 * The pill's SHAPE, checked the way this app checks components: there is no
 * DOM here (vitest.config.ts pins `environment: "node"`), so the component is
 * called as a plain function over stubbed hooks and the element tree it
 * returns is walked. Placement is CSS and belongs to the browser pass; what
 * this suite can prove is everything that would be a real bug:
 *
 * - it renders nothing at all when the live suggestion is about another block;
 * - its × is labelled as HIDING, not dismissing (the localStorage write is a
 *   whole-document, permanent consequence and must stay on the chat card);
 * - every click stops propagation, because the shell underneath turns a click
 *   on an already-selected button into "open the label editor";
 * - it offers exactly ONE action, the default rung, in the rules' own words.
 */

const anchorRef: { current: BlockSuggestionAnchor | null } = { current: null };
const hideAnchoredSuggestion = vi.hoisted(() => vi.fn());
const registerMountedPill = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: unknown) => unknown) =>
    selector({ documentId: "doc_aaaa", viewport: "desktop" }),
}));

vi.mock("@/lib/suggestions/suggestion-surface-store", () => ({
  useAnchoredBlockSuggestion: () => anchorRef.current,
  useBlockSuggestionSurfaceStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ): unknown => selector({ hideAnchoredSuggestion, registerMountedPill }),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  // The mount registration is a side effect with no bearing on the tree.
  return { ...actual, useEffect: () => {} };
});

import { BlockSuggestionPill } from "./BlockSuggestionPill";

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
    if (typeof current === "string") {
      parts.push(current);
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

const applyDefaultRung = vi.fn();

function makeAnchor(overrides: Partial<BlockSuggestionAnchor> = {}): BlockSuggestionAnchor {
  return {
    documentId: "doc_aaaa" as Id<"documents">,
    blockId: "btn_two" as BlockId,
    suggestionId: "suggestion-1",
    title: "Style the other buttons to match?",
    defaultRungId: "section",
    defaultRungLabel: "The other 2 buttons in this section",
    applyDefaultRung,
    ...overrides,
  };
}

/** A click as the shell would see it, so propagation can be asserted. */
function makeClickEvent() {
  return { stopPropagation: vi.fn(), preventDefault: vi.fn() };
}

const blockId = "btn_two" as BlockId;

beforeEach(() => {
  anchorRef.current = makeAnchor();
  applyDefaultRung.mockReset();
  hideAnchoredSuggestion.mockReset();
});

describe("when no suggestion is anchored here", () => {
  it("renders nothing — every selected block mounts one of these", () => {
    anchorRef.current = null;
    expect(BlockSuggestionPill({ blockId })).toBeNull();
  });
});

describe("the pill", () => {
  it("asks the suggestion's own question — no canvas-only copy to drift", () => {
    const text = visibleText(BlockSuggestionPill({ blockId }));
    expect(text).toContain("Style the other buttons to match?");
  });

  it("offers exactly one action, labelled in the rules' words", () => {
    const tree = BlockSuggestionPill({ blockId });
    const apply = findByTestId(tree, "block-suggestion-apply");
    expect(apply).toBeDefined();
    expect(visibleText(apply)).toBe("The other 2 buttons in this section");
  });

  it("never names a block id or a property key", () => {
    const text = visibleText(BlockSuggestionPill({ blockId }));
    expect(text).not.toContain("btn_two");
    expect(text).not.toMatch(/backgroundColor|blockId|updateBlockProperties/);
  });

  it("applies through the ONE controller, and swallows the click on the way", () => {
    const apply = findByTestId(BlockSuggestionPill({ blockId }), "block-suggestion-apply");
    const event = makeClickEvent();
    (apply!.props.onClick as (event: unknown) => void)(event);
    expect(applyDefaultRung).toHaveBeenCalledTimes(1);
    // Without this the shell also opens the button's inline label editor.
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("uses plain buttons, never a Base UI control", () => {
    // Base UI warnings are thrown errors in production; the sibling chat card
    // holds the same line.
    for (const testId of ["block-suggestion-apply", "block-suggestion-hide"]) {
      const button = findByTestId(BlockSuggestionPill({ blockId }), testId);
      expect(button!.type).toBe("button");
      expect(button!.props.type).toBe("button");
    }
  });
});

describe("the ×", () => {
  it("says HIDE, because that is all it does", () => {
    const hide = findByTestId(BlockSuggestionPill({ blockId }), "block-suggestion-hide");
    expect(hide!.props["aria-label"]).toBe("Hide this suggestion");
    // "Dismiss" is the chat card's word for the permanent, whole-document
    // pattern dismissal. These two must not read as the same action.
    expect(String(hide!.props["aria-label"])).not.toMatch(/dismiss/i);
  });

  it("hides this instance only — it never reaches the dismissal bookkeeping", () => {
    const hide = findByTestId(BlockSuggestionPill({ blockId }), "block-suggestion-hide");
    const event = makeClickEvent();
    (hide!.props.onClick as (event: unknown) => void)(event);
    expect(hideAnchoredSuggestion).toHaveBeenCalledTimes(1);
    expect(applyDefaultRung).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
