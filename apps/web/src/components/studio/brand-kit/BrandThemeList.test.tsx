import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MOCK_BRAND_KIT, type BrandColor, type ThemeVariation } from "@/lib/brand-kit";
import { getThemeColorRoles } from "@/lib/brand-theme-builder";

/**
 * The theme list and the shared role picker, checked the way this app checks
 * components: there is no DOM here (vitest.config.ts pins `environment:
 * "node"`), so a component is called as a plain function and the element tree
 * it returns is walked. Layout is CSS and belongs to a browser pass; what this
 * suite can prove is everything that would be a real bug:
 *
 * - the EDIT form offers only combinations that already pass contrast, and
 *   always offers the theme's own colors — filter-before-offering, applied to
 *   an edit exactly as it is applied to an add;
 * - deleting is behind a confirmation and never offered for the last theme;
 * - a soft-deleted theme appears only in the Restore list, never among the
 *   themes the kit has.
 *
 * `useState`/`useMemo` are stubbed to their initial values, which is precisely
 * a first render — the tree a person sees when the panel opens.
 */

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: <Value,>(initial: Value | (() => Value)) => [
      typeof initial === "function" ? (initial as () => Value)() : initial,
      () => {},
    ],
    useMemo: <Value,>(factory: () => Value) => factory(),
  };
});

import { BrandThemeList } from "./BrandThemeList";
import { ThemeRolePicker } from "./ThemeRolePicker";

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

/*
  The colors one role select is offering.

  Read off the `ColorRoleSelect` ELEMENT's props rather than by rendering it:
  the walker sees element trees, not the output of nested components, and the
  option list is a prop by design — the whole filter-before-offering rule is
  that the eligible set IS what the control is handed.
*/
function readSelectOptions(node: ReactNode, testId: string): string[] {
  const select = collectElements(node).find((element) => element.props.testId === testId);
  if (select === undefined) {
    throw new Error(`no role select with testId "${testId}"`);
  }
  return select.props.options as string[];
}

const CLASSIC = MOCK_BRAND_KIT.variations[0]!;
const WARM_SAND = MOCK_BRAND_KIT.variations[1]!;

/** A palette holding NONE of Warm Sand's colors — the scraped-theme situation. */
const UNRELATED_PALETTE: BrandColor[] = [
  { id: "a", hex: "#ffffff", name: "White", category: "primary", orderIndex: 0, origin: "user" },
  { id: "b", hex: "#000000", name: "Black", category: "primary", orderIndex: 1, origin: "user" },
];

function renderList({
  variations = [CLASSIC, WARM_SAND],
  deletedVariations = [],
}: {
  variations?: ThemeVariation[];
  deletedVariations?: ThemeVariation[];
} = {}): ReactNode {
  return BrandThemeList({
    variations,
    deletedVariations,
    colors: UNRELATED_PALETTE,
    fonts: MOCK_BRAND_KIT.fonts,
    isBusy: false,
    onSaveEdit: () => {},
    onSetDeleted: () => {},
  });
}

describe("ThemeRolePicker — the edit form's contrast filter", () => {
  it("offers the theme's own colors even when the palette has none of them", () => {
    /*
      A scraped theme's heading color is usually a contrast-repaired shade the
      authored palette never had. A select whose options exclude its current
      value shows the wrong color selected and silently changes the theme the
      instant the form is submitted, which is the reject-after-choosing failure
      inverted into something worse.
    */
    const roles = getThemeColorRoles(WARM_SAND);
    const tree = ThemeRolePicker({
      roles,
      paletteHexes: [
        "#ffffff",
        "#000000",
        roles.contentBackground,
        roles.headingText,
        roles.paragraphText,
        roles.accent,
      ],
      colors: UNRELATED_PALETTE,
      isBusy: false,
      idPrefix: "edit",
      onRolesChange: () => {},
    });
    expect(readSelectOptions(tree, "edit-background")).toContain(roles.contentBackground);
    expect(readSelectOptions(tree, "edit-heading-text")).toContain(roles.headingText);
    expect(readSelectOptions(tree, "edit-paragraph-text")).toContain(roles.paragraphText);
    expect(readSelectOptions(tree, "edit-accent")).toContain(roles.accent);
  });

  it("never offers a text color that would fail contrast on the chosen background", () => {
    /*
      THE guarantee. On Warm Sand's near-white content background, white is
      unreadable and must not be an option — the point is that a combination
      the server would refuse is never on screen to be chosen.
    */
    const roles = getThemeColorRoles(WARM_SAND);
    const tree = ThemeRolePicker({
      roles,
      paletteHexes: ["#ffffff", "#000000", roles.contentBackground, roles.headingText, roles.accent],
      colors: UNRELATED_PALETTE,
      isBusy: false,
      idPrefix: "edit",
      onRolesChange: () => {},
    });
    expect(readSelectOptions(tree, "edit-heading-text")).not.toContain("#ffffff");
    expect(readSelectOptions(tree, "edit-heading-text")).toContain("#000000");
  });

  it("never offers the background as its own text color", () => {
    const roles = getThemeColorRoles(CLASSIC);
    const tree = ThemeRolePicker({
      roles,
      paletteHexes: ["#ffffff", "#000000", roles.contentBackground, roles.headingText],
      colors: UNRELATED_PALETTE,
      isBusy: false,
      idPrefix: "edit",
      onRolesChange: () => {},
    });
    expect(readSelectOptions(tree, "edit-heading-text")).not.toContain(roles.contentBackground);
    expect(readSelectOptions(tree, "edit-accent")).not.toContain(roles.contentBackground);
  });
});

describe("BrandThemeList", () => {
  it("gives every theme an edit and a delete control", () => {
    const tree = renderList();
    expect(findByTestId(tree, `brand-theme-edit-${CLASSIC.id}`)).toBeDefined();
    expect(findByTestId(tree, `brand-theme-delete-${CLASSIC.id}`)).toBeDefined();
    expect(findByTestId(tree, `brand-theme-row-${WARM_SAND.id}`)).toBeDefined();
  });

  it("does not open the delete dialog until the user asks for it", () => {
    /*
      Destructive actions go through the house confirmation (DraftSelector's
      dialog is the precedent). On first render nothing is pending, so the
      dialog is closed.
    */
    const tree = renderList();
    const dialog = collectElements(tree).find(
      (element) => typeof element.props.open === "boolean" && element.props.open === false,
    );
    expect(dialog).toBeDefined();
  });

  it("refuses to offer deletion of the kit's last theme", () => {
    /*
      The contract requires at least one theme, so the refusal belongs on a
      disabled control rather than in a server error the user has to read.
    */
    const tree = renderList({ variations: [CLASSIC] });
    expect(findByTestId(tree, `brand-theme-delete-${CLASSIC.id}`)?.props.disabled).toBe(true);
    const twoThemes = renderList();
    expect(findByTestId(twoThemes, `brand-theme-delete-${CLASSIC.id}`)?.props.disabled).toBe(false);
  });

  it("lists a soft-deleted theme only under Restore, never among the kit's themes", () => {
    const tree = renderList({ variations: [CLASSIC], deletedVariations: [WARM_SAND] });
    expect(findByTestId(tree, `brand-theme-row-${WARM_SAND.id}`)).toBeUndefined();
    expect(findByTestId(tree, `brand-theme-deleted-${WARM_SAND.id}`)).toBeDefined();
    expect(findByTestId(tree, `brand-theme-restore-${WARM_SAND.id}`)).toBeDefined();
  });

  it("shows no Restore section when nothing has been deleted", () => {
    expect(findByTestId(renderList(), "brand-theme-deleted-list")).toBeUndefined();
  });
});
