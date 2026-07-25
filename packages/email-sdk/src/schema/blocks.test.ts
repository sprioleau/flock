import { describe, expect, it } from "vitest";
import {
  blockSchema,
  buttonBlockSchema,
  columnBlockSchema,
  dividerBlockSchema,
  imageBlockSchema,
  rootBlockSchema,
  rowBlockSchema,
  sectionBlockSchema,
  textBlockSchema,
} from "./blocks";
import { createTextDoc } from "./text";

const validRoot = {
  id: "root",
  type: "root",
  parentId: null,
  childrenIds: ["sec_a1b2"],
  properties: { globals: { contentWidth: 600 } },
};

const validSection = {
  id: "sec_a1b2",
  type: "section",
  parentId: "root",
  childrenIds: ["row_c3d4", "txt_e5f6"],
  properties: { innerBackgroundColor: "#ffffff", paddingTop: 12 },
};

const validRow = {
  id: "row_c3d4",
  type: "row",
  parentId: "sec_a1b2",
  childrenIds: ["col_g7h8"],
  properties: { paddingTop: 8, paddingBottom: 8 },
};

const validColumn = {
  id: "col_g7h8",
  type: "column",
  parentId: "row_c3d4",
  childrenIds: ["btn_i9j0"],
  properties: { widthPercent: 50, verticalAlign: "middle" },
};

const validText = {
  id: "txt_e5f6",
  type: "text",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties: { text: createTextDoc("Hello"), textAlign: "center" },
};

const validButton = {
  id: "btn_i9j0",
  type: "button",
  parentId: "col_g7h8",
  childrenIds: [],
  properties: { label: "Click me", href: "https://example.com" },
};

const validImage = {
  id: "img_k1l2",
  type: "image",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties: { src: "https://example.com/a.png", alt: "An image" },
};

const validDivider = {
  id: "div_m3n4",
  type: "divider",
  parentId: "sec_a1b2",
  childrenIds: [],
  properties: {},
};

describe("rootBlockSchema", () => {
  it("accepts a valid root", () => {
    expect(rootBlockSchema.safeParse(validRoot).success).toBe(true);
  });

  it("accepts a root without globals", () => {
    expect(rootBlockSchema.safeParse({ ...validRoot, properties: {} }).success).toBe(true);
  });

  it('rejects an id other than "root"', () => {
    expect(rootBlockSchema.safeParse({ ...validRoot, id: "root_a1b2" }).success).toBe(false);
  });

  it("rejects a non-null parentId", () => {
    expect(rootBlockSchema.safeParse({ ...validRoot, parentId: "sec_a1b2" }).success).toBe(false);
  });

  it("rejects non-section children ids", () => {
    expect(rootBlockSchema.safeParse({ ...validRoot, childrenIds: ["txt_a1b2"] }).success).toBe(false);
    expect(rootBlockSchema.safeParse({ ...validRoot, childrenIds: ["row_a1b2"] }).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    const root = { ...validRoot, properties: { globals: {}, theme: "dark" } };
    expect(rootBlockSchema.safeParse(root).success).toBe(false);
  });

  it("rejects invalid globals", () => {
    const root = { ...validRoot, properties: { globals: { unknownKey: 1 } } };
    expect(rootBlockSchema.safeParse(root).success).toBe(false);
  });
});

describe("sectionBlockSchema", () => {
  it("accepts a valid section with row and leaf children", () => {
    expect(sectionBlockSchema.safeParse(validSection).success).toBe(true);
  });

  it('rejects a parentId other than "root"', () => {
    expect(sectionBlockSchema.safeParse({ ...validSection, parentId: "sec_x9y8" }).success).toBe(false);
  });

  it("rejects column or section children ids", () => {
    expect(sectionBlockSchema.safeParse({ ...validSection, childrenIds: ["col_a1b2"] }).success).toBe(false);
    expect(sectionBlockSchema.safeParse({ ...validSection, childrenIds: ["sec_z9z9"] }).success).toBe(false);
  });

  it("rejects negative padding", () => {
    const section = { ...validSection, properties: { paddingTop: -1 } };
    expect(sectionBlockSchema.safeParse(section).success).toBe(false);
  });

  it("rejects unknown properties", () => {
    const section = { ...validSection, properties: { label: "Header" } };
    expect(sectionBlockSchema.safeParse(section).success).toBe(false);
  });
});

describe("rowBlockSchema", () => {
  it("accepts a valid row", () => {
    expect(rowBlockSchema.safeParse(validRow).success).toBe(true);
  });

  it("rejects non-column children ids", () => {
    expect(rowBlockSchema.safeParse({ ...validRow, childrenIds: ["txt_a1b2"] }).success).toBe(false);
  });

  it("rejects a non-section parentId", () => {
    expect(rowBlockSchema.safeParse({ ...validRow, parentId: "col_a1b2" }).success).toBe(false);
  });

  it("rejects horizontal padding (rows only pad vertically)", () => {
    const row = { ...validRow, properties: { paddingLeft: 4 } };
    expect(rowBlockSchema.safeParse(row).success).toBe(false);
  });
});

describe("columnBlockSchema", () => {
  it("accepts a valid column", () => {
    expect(columnBlockSchema.safeParse(validColumn).success).toBe(true);
  });

  it("rejects widthPercent outside 1–100", () => {
    expect(
      columnBlockSchema.safeParse({ ...validColumn, properties: { widthPercent: 0 } }).success,
    ).toBe(false);
    expect(
      columnBlockSchema.safeParse({ ...validColumn, properties: { widthPercent: 101 } }).success,
    ).toBe(false);
  });

  it("rejects invalid verticalAlign", () => {
    expect(
      columnBlockSchema.safeParse({ ...validColumn, properties: { verticalAlign: "center" } }).success,
    ).toBe(false);
  });

  it("rejects row or column children ids", () => {
    expect(columnBlockSchema.safeParse({ ...validColumn, childrenIds: ["row_a1b2"] }).success).toBe(false);
    expect(columnBlockSchema.safeParse({ ...validColumn, childrenIds: ["col_a1b2"] }).success).toBe(false);
  });
});

describe("textBlockSchema", () => {
  it("accepts a valid text block", () => {
    expect(textBlockSchema.safeParse(validText).success).toBe(true);
  });

  it("accepts a section or a column as parent", () => {
    expect(textBlockSchema.safeParse({ ...validText, parentId: "col_g7h8" }).success).toBe(true);
    expect(textBlockSchema.safeParse({ ...validText, parentId: "row_c3d4" }).success).toBe(false);
  });

  it("requires properties.text", () => {
    expect(textBlockSchema.safeParse({ ...validText, properties: {} }).success).toBe(false);
  });

  it("rejects an invalid inner rich-text doc", () => {
    const text = { ...validText, properties: { text: { type: "doc", content: [] } } };
    expect(textBlockSchema.safeParse(text).success).toBe(false);
  });

  it("rejects non-empty childrenIds", () => {
    expect(textBlockSchema.safeParse({ ...validText, childrenIds: ["txt_zzzz"] }).success).toBe(false);
  });

  it("rejects invalid textAlign", () => {
    const text = { ...validText, properties: { ...validText.properties, textAlign: "justify" } };
    expect(textBlockSchema.safeParse(text).success).toBe(false);
  });
});

describe("buttonBlockSchema", () => {
  it("accepts a minimal valid button", () => {
    expect(buttonBlockSchema.safeParse(validButton).success).toBe(true);
  });

  it("accepts a fully overridden button", () => {
    const button = {
      ...validButton,
      properties: {
        label: "Go",
        href: "https://example.com",
        backgroundColor: "#ff0000",
        textColor: "#ffffff",
        borderRadius: 8,
        borderSize: 2,
        borderColor: "#00ff00",
        horizontalPadding: 32,
        verticalPadding: 16,
        fontFamily: "Georgia, serif",
        align: "center",
        paddingTop: 12,
      },
    };
    expect(buttonBlockSchema.safeParse(button).success).toBe(true);
  });

  it("requires a non-empty label", () => {
    const button = { ...validButton, properties: { label: "", href: "https://x.com" } };
    expect(buttonBlockSchema.safeParse(button).success).toBe(false);
  });

  it("requires href", () => {
    const button = { ...validButton, properties: { label: "Go" } };
    expect(buttonBlockSchema.safeParse(button).success).toBe(false);
  });

  it("rejects negative border size", () => {
    const button = {
      ...validButton,
      properties: { ...validButton.properties, borderSize: -1 },
    };
    expect(buttonBlockSchema.safeParse(button).success).toBe(false);
  });

  it("rejects non-empty childrenIds", () => {
    expect(buttonBlockSchema.safeParse({ ...validButton, childrenIds: ["txt_a1b2"] }).success).toBe(false);
  });
});

describe("imageBlockSchema", () => {
  it("accepts a minimal valid image", () => {
    expect(imageBlockSchema.safeParse(validImage).success).toBe(true);
  });

  it("accepts an empty alt (decorative image) but requires the field", () => {
    const decorative = { ...validImage, properties: { src: "https://x.com/a.png", alt: "" } };
    expect(imageBlockSchema.safeParse(decorative).success).toBe(true);
    const missingAlt = { ...validImage, properties: { src: "https://x.com/a.png" } };
    expect(imageBlockSchema.safeParse(missingAlt).success).toBe(false);
  });

  it("requires a non-empty src", () => {
    const image = { ...validImage, properties: { src: "", alt: "x" } };
    expect(imageBlockSchema.safeParse(image).success).toBe(false);
  });

  it("rejects a non-positive width", () => {
    const image = { ...validImage, properties: { ...validImage.properties, width: 0 } };
    expect(imageBlockSchema.safeParse(image).success).toBe(false);
  });

  it("rejects invalid align values", () => {
    const image = { ...validImage, properties: { ...validImage.properties, align: "top" } };
    expect(imageBlockSchema.safeParse(image).success).toBe(false);
  });
});

describe("dividerBlockSchema", () => {
  it("accepts a divider with empty properties", () => {
    expect(dividerBlockSchema.safeParse(validDivider).success).toBe(true);
  });

  it("accepts color and thickness overrides", () => {
    const divider = { ...validDivider, properties: { color: "#333333", thickness: 2 } };
    expect(dividerBlockSchema.safeParse(divider).success).toBe(true);
  });

  it("rejects a non-positive thickness", () => {
    const divider = { ...validDivider, properties: { thickness: 0 } };
    expect(dividerBlockSchema.safeParse(divider).success).toBe(false);
  });

  it("rejects an empty-string color", () => {
    const divider = { ...validDivider, properties: { color: "" } };
    expect(dividerBlockSchema.safeParse(divider).success).toBe(false);
  });
});

describe("blockSchema (discriminated union)", () => {
  it.each([
    ["root", validRoot],
    ["section", validSection],
    ["row", validRow],
    ["column", validColumn],
    ["text", validText],
    ["button", validButton],
    ["image", validImage],
    ["divider", validDivider],
  ])("parses a %s block through the union", (expectedType, block) => {
    const result = blockSchema.safeParse(block);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(expectedType);
    }
  });

  it("rejects unknown block types (no spacer/social in this vocabulary)", () => {
    expect(blockSchema.safeParse({ ...validDivider, type: "spacer" }).success).toBe(false);
    expect(blockSchema.safeParse({ ...validDivider, type: "socialFollow" }).success).toBe(false);
  });

  it("rejects a block with no type", () => {
    const { type: _type, ...untyped } = validButton;
    expect(blockSchema.safeParse(untyped).success).toBe(false);
  });

  it("rejects a block whose id prefix does not match its type", () => {
    expect(blockSchema.safeParse({ ...validButton, id: "img_a1b2" }).success).toBe(false);
  });
});
