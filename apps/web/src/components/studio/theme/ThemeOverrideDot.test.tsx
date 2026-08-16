import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Block } from "@flock/email-sdk";
import type { Id } from "@convex/_generated/dataModel";

/**
 * The override indicator's WIRING, checked the way this app checks components:
 * there is no DOM here (vitest.config.ts pins `environment: "node"`), so the
 * component is called as a plain function over stubbed hooks and the element
 * tree it returns is walked. The appearance RULE itself is a pure function with
 * its own suite (lib/brand-theme-link.test.ts); what only this file can prove is
 * the composition that rule depends on:
 *
 * - the dot is silent for a draft with no parent theme, and for a parent with
 *   nothing overridden — "not super in their face" is the whole brief;
 * - it appears for an overridden GLOBAL, which the server query supplies;
 * - it appears for a per-section background override, which the server query
 *   deliberately does NOT know about and the editor store supplies locally.
 *   That second layer is the part a refactor would silently drop.
 */

const DOCUMENT_ID = "doc_theme_dot" as Id<"documents">;

interface StatusDraft {
  documentId: Id<"documents">;
  name: string;
  state: string;
  parentVariation: { id: string; name: string } | null;
  overriddenGlobalKeys: string[];
}

const statusRef: { current: { drafts: StatusDraft[] } | undefined } = { current: undefined };
const docRef: { current: Record<string, Block> } = { current: {} };

vi.mock("convex/react", () => ({
  useQuery: () => statusRef.current,
}));

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: unknown) => unknown) =>
    selector({ canvasId: "canvas_1", doc: docRef.current }),
}));

import { ThemeOverrideDot } from "./ThemeOverrideDot";

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
    visit(element.props.render as ReactNode);
  };
  visit(node);
  return found;
}

/** The dot's own element, found by the test id it carries, or undefined. */
function findDot(node: ReactNode): ElementWithProps | undefined {
  return collectElements(node).find(
    (element) => element.props["data-testid"] === `theme-override-dot-${DOCUMENT_ID}`,
  );
}

function renderDot({
  parentVariation,
  overriddenGlobalKeys,
  sectionProperties,
}: {
  parentVariation: { id: string; name: string } | null;
  overriddenGlobalKeys: string[];
  sectionProperties?: Record<string, unknown>;
}): ReactNode {
  statusRef.current = {
    drafts: [
      {
        documentId: DOCUMENT_ID,
        name: "Draft 1",
        state: "overridden",
        parentVariation,
        overriddenGlobalKeys,
      },
    ],
  };
  docRef.current =
    sectionProperties === undefined
      ? {}
      : ({ sec_a: { id: "sec_a", type: "section", properties: sectionProperties } } as unknown as Record<
          string,
          Block
        >);
  return ThemeOverrideDot({ documentId: DOCUMENT_ID });
}

describe("ThemeOverrideDot", () => {
  it("renders nothing for a draft with no parent theme", () => {
    const tree = renderDot({ parentVariation: null, overriddenGlobalKeys: [] });
    expect(tree).toBeNull();
  });

  it("renders nothing for a parent theme with nothing overridden", () => {
    const tree = renderDot({
      parentVariation: { id: "midnight", name: "Midnight" },
      overriddenGlobalKeys: [],
    });
    expect(tree).toBeNull();
  });

  it("appears for an overridden global, naming the theme and the reset in its label", () => {
    const tree = renderDot({
      parentVariation: { id: "midnight", name: "Midnight" },
      overriddenGlobalKeys: ["buttonBackgroundColor"],
    });
    const dot = findDot(tree);
    expect(dot).toBeDefined();
    /* Announced to screen readers: the dot itself is pure color. */
    expect(dot?.props["aria-label"]).toContain("Midnight");
    expect(dot?.props["aria-label"]).toContain("1 local change");
    expect(dot?.props["aria-label"]).toContain("Pick the theme again to reset");
  });

  it("appears for a per-section background override alone — the layer the query cannot see", () => {
    const tree = renderDot({
      parentVariation: { id: "midnight", name: "Midnight" },
      overriddenGlobalKeys: [],
      sectionProperties: { innerBackgroundColor: "#101820" },
    });
    expect(findDot(tree)).toBeDefined();
  });

  it("ignores a section carrying no theme-scoped background", () => {
    const tree = renderDot({
      parentVariation: { id: "midnight", name: "Midnight" },
      overriddenGlobalKeys: [],
      sectionProperties: { paddingTop: 12 },
    });
    expect(tree).toBeNull();
  });
});
