import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "../schema/globals";
import type {
  ButtonBlock,
  ColumnBlock,
  DividerBlock,
  ImageBlock,
  RootBlock,
  RowBlock,
  SectionBlock,
  TextBlock,
} from "../schema/blocks";
import { resolveBlockStyles, resolveGlobalStyles, resolveRootBlockStyles } from "./styles";
import { createTextDoc } from "../schema/text";

const rootBlock = (globals?: GlobalStyles): RootBlock => ({
  id: "root",
  type: "root",
  parentId: null,
  childrenIds: [],
  properties: globals === undefined ? {} : { globals },
});

const sectionBlock = (properties: SectionBlock["properties"] = {}): SectionBlock => ({
  id: "sec_a1b2",
  type: "section",
  parentId: "root",
  childrenIds: [],
  properties,
});

const rowBlock = (properties: RowBlock["properties"] = {}): RowBlock => ({
  id: "row_a1b2",
  type: "row",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties,
});

const columnBlock = (properties: ColumnBlock["properties"] = {}): ColumnBlock => ({
  id: "col_a1b2",
  type: "column",
  parentId: "row_a1b2",
  childrenIds: [],
  properties,
});

const textBlock = (properties: Partial<TextBlock["properties"]> = {}): TextBlock => ({
  id: "txt_a1b2",
  type: "text",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties: { text: createTextDoc("hi"), ...properties },
});

const buttonBlock = (
  properties: Partial<Omit<ButtonBlock["properties"], "label" | "href">> = {},
): ButtonBlock => ({
  id: "btn_a1b2",
  type: "button",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties: { label: "Go", href: "https://example.com", ...properties },
});

const imageBlock = (
  properties: Partial<Omit<ImageBlock["properties"], "src" | "alt">> = {},
): ImageBlock => ({
  id: "img_a1b2",
  type: "image",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties: { src: "https://example.com/a.png", alt: "a", ...properties },
});

const dividerBlock = (properties: DividerBlock["properties"] = {}): DividerBlock => ({
  id: "div_a1b2",
  type: "divider",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties,
});

describe("resolveGlobalStyles", () => {
  it("returns the renderer defaults when globals are absent", () => {
    expect(resolveGlobalStyles(undefined)).toEqual(DEFAULT_GLOBAL_STYLES);
    expect(resolveGlobalStyles({})).toEqual(DEFAULT_GLOBAL_STYLES);
  });

  it("layers document globals over the defaults", () => {
    const resolved = resolveGlobalStyles({ buttonBackgroundColor: "#123456", contentWidth: 720 });
    expect(resolved.buttonBackgroundColor).toBe("#123456");
    expect(resolved.contentWidth).toBe(720);
    expect(resolved.buttonTextColor).toBe(DEFAULT_GLOBAL_STYLES.buttonTextColor);
  });

  it("ignores explicitly-undefined global values", () => {
    const resolved = resolveGlobalStyles({ buttonBackgroundColor: undefined });
    expect(resolved.buttonBackgroundColor).toBe(DEFAULT_GLOBAL_STYLES.buttonBackgroundColor);
  });
});

describe("resolveBlockStyles precedence (defaults → globals → block overrides)", () => {
  it("buttons: renderer default when nothing is set", () => {
    const resolved = resolveBlockStyles(undefined, buttonBlock());
    expect(resolved.backgroundColor).toBe(DEFAULT_GLOBAL_STYLES.buttonBackgroundColor);
    expect(resolved.borderRadius).toBe(DEFAULT_GLOBAL_STYLES.buttonBorderRadius);
    expect(resolved.align).toBe("left");
  });

  it("buttons: globals beat defaults, block overrides beat globals", () => {
    const globals: GlobalStyles = {
      buttonBackgroundColor: "#111111",
      buttonTextColor: "#eeeeee",
      buttonBorderRadius: 10,
    };
    const fromGlobals = resolveBlockStyles(globals, buttonBlock());
    expect(fromGlobals.backgroundColor).toBe("#111111");
    expect(fromGlobals.textColor).toBe("#eeeeee");
    expect(fromGlobals.borderRadius).toBe(10);

    const fromOverrides = resolveBlockStyles(
      globals,
      buttonBlock({ backgroundColor: "#ff0000", borderRadius: 0 }),
    );
    expect(fromOverrides.backgroundColor).toBe("#ff0000");
    expect(fromOverrides.borderRadius).toBe(0); // falsy override still wins
    expect(fromOverrides.textColor).toBe("#eeeeee"); // untouched fields keep globals
  });

  it("sections: inner/outer backgrounds chain from content/email background globals", () => {
    const resolved = resolveBlockStyles(
      { contentBackgroundColor: "#fafafa", emailBackgroundColor: "#101010" },
      sectionBlock(),
    );
    expect(resolved.innerBackgroundColor).toBe("#fafafa");
    expect(resolved.outerBackgroundColor).toBe("#101010");
  });

  it("sections: explicit inner/outer overrides win over the chained globals", () => {
    const resolved = resolveBlockStyles(
      { contentBackgroundColor: "#fafafa", emailBackgroundColor: "#101010" },
      sectionBlock({ innerBackgroundColor: "#ffffff", outerBackgroundColor: "#222222" }),
    );
    expect(resolved.innerBackgroundColor).toBe("#ffffff");
    expect(resolved.outerBackgroundColor).toBe("#222222");
  });

  it("sections: padding defaults derive from baseSpacing, and carry contentWidth", () => {
    const resolved = resolveBlockStyles({ baseSpacing: 30, contentWidth: 700 }, sectionBlock());
    expect(resolved.paddingTop).toBe(30);
    expect(resolved.paddingBottom).toBe(0);
    expect(resolved.paddingLeft).toBe(30);
    expect(resolved.paddingRight).toBe(30);
    expect(resolved.contentWidth).toBe(700);

    const overridden = resolveBlockStyles(
      { baseSpacing: 30 },
      sectionBlock({ paddingTop: 0, paddingLeft: 4 }),
    );
    expect(overridden.paddingTop).toBe(0);
    expect(overridden.paddingLeft).toBe(4);
    expect(overridden.paddingRight).toBe(30);
  });

  it("text: heading globals are picked per level and paragraphs use paragraph globals", () => {
    const resolved = resolveBlockStyles(
      {
        heading1TextColor: "#100000",
        heading2TextColor: "#200000",
        heading3TextColor: "#300000",
        heading2TextAlign: "center",
        paragraphTextColor: "#400000",
        paragraphFontFamily: "Georgia, serif",
        linkTextColor: "#0000ff",
      },
      textBlock(),
    );
    expect(resolved.heading1.textColor).toBe("#100000");
    expect(resolved.heading2.textColor).toBe("#200000");
    expect(resolved.heading2.textAlign).toBe("center");
    expect(resolved.heading3.textColor).toBe("#300000");
    expect(resolved.paragraph.textColor).toBe("#400000");
    expect(resolved.paragraph.fontFamily).toBe("Georgia, serif");
    expect(resolved.linkTextColor).toBe("#0000ff");
  });

  it("text: block textColor/textAlign override every node scope", () => {
    const resolved = resolveBlockStyles(
      { heading1TextColor: "#100000", paragraphTextColor: "#400000", heading1TextAlign: "center" },
      textBlock({ textColor: "#ff00ff", textAlign: "right" }),
    );
    for (const scope of [
      resolved.heading1,
      resolved.heading2,
      resolved.heading3,
      resolved.paragraph,
    ]) {
      expect(scope.textColor).toBe("#ff00ff");
      expect(scope.textAlign).toBe("right");
    }
    // fontFamily is not overridable at block level; globals still apply.
    expect(resolved.heading1.fontFamily).toBe(DEFAULT_GLOBAL_STYLES.heading1FontFamily);
  });

  it("leaves: paddingBottom defaults to baseSpacing (space between blocks)", () => {
    const resolved = resolveBlockStyles({ baseSpacing: 18 }, textBlock());
    expect(resolved.paddingTop).toBe(0);
    expect(resolved.paddingBottom).toBe(18);
    const overridden = resolveBlockStyles({ baseSpacing: 18 }, textBlock({ paddingBottom: 2 }));
    expect(overridden.paddingBottom).toBe(2);
  });

  it("dividers: color chains from globals.dividerColor; thickness defaults to 1", () => {
    expect(resolveBlockStyles(undefined, dividerBlock())).toMatchObject({
      color: DEFAULT_GLOBAL_STYLES.dividerColor,
      thickness: 1,
    });
    expect(
      resolveBlockStyles({ dividerColor: "#abcabc" }, dividerBlock({ thickness: 3 })),
    ).toMatchObject({ color: "#abcabc", thickness: 3 });
    expect(
      resolveBlockStyles({ dividerColor: "#abcabc" }, dividerBlock({ color: "#001122" })),
    ).toMatchObject({ color: "#001122" });
  });

  it("images: align defaults to center; columns: verticalAlign defaults to top", () => {
    expect(resolveBlockStyles(undefined, imageBlock()).align).toBe("center");
    expect(resolveBlockStyles(undefined, imageBlock({ align: "left" })).align).toBe("left");
    const column = resolveBlockStyles(undefined, columnBlock());
    expect(column.verticalAlign).toBe("top");
    expect(column.widthPercent).toBeUndefined();
    expect(column.backgroundColor).toBeUndefined();
  });

  it("rows: vertical padding defaults to 0", () => {
    expect(resolveBlockStyles(undefined, rowBlock())).toEqual({ paddingTop: 0, paddingBottom: 0 });
    expect(resolveBlockStyles(undefined, rowBlock({ paddingTop: 6 })).paddingTop).toBe(6);
  });

  it("root: canvas values resolve through the same chain", () => {
    const resolved = resolveBlockStyles({ emailBackgroundColor: "#050505" }, rootBlock());
    expect(resolved.emailBackgroundColor).toBe("#050505");
    expect(resolved.contentWidth).toBe(DEFAULT_GLOBAL_STYLES.contentWidth);

    const viaHelper = resolveRootBlockStyles(rootBlock({ contentWidth: 480 }));
    expect(viaHelper.contentWidth).toBe(480);
    expect(viaHelper.baseSpacing).toBe(DEFAULT_GLOBAL_STYLES.baseSpacing);
  });
});
