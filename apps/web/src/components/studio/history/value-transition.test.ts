import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_STYLES } from "@flock/email-sdk";
import { describeValueTransition, formatTransitionTooltip } from "./value-transition";

/*
  describeValueTransition — the pure before/after glance derivation.
  Direction contract under test throughout: BEFORE comes from the inverse
  payload, AFTER from the op payload; undo entries (whose op IS the original
  inverse) therefore display the reversed pair with no special-casing.
*/

const BUTTON_ID = "btn_a1b2";

/*
  A forward single-property edit as logged: partial op + full-snapshot inverse.
*/
function buttonColorEdit({ from, to }: { from: string; to: string }) {
  return {
    op: {
      name: "updateBlockProperties",
      blockId: BUTTON_ID,
      properties: { backgroundColor: to },
    },
    inverse: {
      name: "replaceBlockProperties",
      blockId: BUTTON_ID,
      properties: { label: "Shop now", backgroundColor: from },
    },
  };
}

describe("describeValueTransition — colors", () => {
  it("shows before → after circles for a single color property change", () => {
    const transition = describeValueTransition(
      buttonColorEdit({ from: "#ff0000", to: "#0000ff" }),
    );
    expect(transition).toEqual({
      kind: "color",
      property: "background color",
      before: "#ff0000",
      after: "#0000ff",
    });
  });

  it("detects colors via value shape when the key is not *Color", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { accent: "rgb(10, 20, 30)" },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { accent: "#ffffff" },
      },
    });
    expect(transition).toMatchObject({ kind: "color", before: "#ffffff", after: "rgb(10, 20, 30)" });
  });

  it("shows the reversed pair on an undo entry (undo of red→blue reads blue→red)", () => {
    /*
      The undo entry's own op is the original inverse (full snapshot with
      red); its own inverse snapshots the pre-undo state (blue).
    */
    const undoEntry = {
      op: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { label: "Shop now", backgroundColor: "#ff0000" },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { label: "Shop now", backgroundColor: "#0000ff" },
      },
    };
    expect(describeValueTransition(undoEntry)).toEqual({
      kind: "color",
      property: "background color",
      before: "#0000ff",
      after: "#ff0000",
    });
  });
});

describe("describeValueTransition — numbers and enums", () => {
  it("shows a px-suffixed number pair for padding", () => {
    const transition = describeValueTransition({
      op: { name: "updateBlockProperties", blockId: BUTTON_ID, properties: { paddingTop: 12 } },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 24 },
      },
    });
    expect(transition).toEqual({
      kind: "number",
      property: "padding",
      before: 24,
      after: 12,
      unit: "px",
    });
  });

  it("uses % for widthPercent", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: "col_x9k3",
        properties: { widthPercent: 30 },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: "col_x9k3",
        properties: { widthPercent: 50 },
      },
    });
    expect(transition).toMatchObject({ kind: "number", before: 50, after: 30, unit: "%" });
  });

  it("shows short enum strings as a text pair", () => {
    const transition = describeValueTransition({
      op: { name: "updateBlockProperties", blockId: BUTTON_ID, properties: { align: "center" } },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { align: "left" },
      },
    });
    expect(transition).toEqual({
      kind: "text",
      property: "alignment",
      before: "left",
      after: "center",
    });
  });

  it("skips strings too long to glance (a URL-sized href)", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { href: "https://example.com/some/very/long/path?with=params" },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { href: "https://example.com/other/very/long/path?with=params" },
      },
    });
    expect(transition).toBeNull();
  });
});

describe("describeValueTransition — multi-property and not-glanceable ops", () => {
  it("returns null when several non-color keys changed (summary label stays)", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 8, paddingBottom: 8, borderRadius: 12 },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 24, paddingBottom: 24, borderRadius: 4 },
      },
    });
    expect(transition).toBeNull();
  });

  it("surfaces the single color pair of a multi-property change", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 8, backgroundColor: "#123456", borderRadius: 12 },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 24, backgroundColor: "#654321", borderRadius: 4 },
      },
    });
    expect(transition).toMatchObject({
      kind: "color",
      before: "#654321",
      after: "#123456",
    });
  });

  it("returns null when two colors changed (ambiguous at a glance)", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { backgroundColor: "#111111", textColor: "#222222" },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { backgroundColor: "#aaaaaa", textColor: "#bbbbbb" },
      },
    });
    expect(transition).toBeNull();
  });

  it("ignores keys whose value did not actually change", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 24, backgroundColor: "#123456" },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { paddingTop: 24, backgroundColor: "#654321" },
      },
    });
    expect(transition).toMatchObject({ kind: "color", before: "#654321", after: "#123456" });
  });

  it("skips a newly-set property with no previous value", () => {
    const transition = describeValueTransition({
      op: {
        name: "updateBlockProperties",
        blockId: BUTTON_ID,
        properties: { backgroundColor: "#123456" },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: BUTTON_ID,
        properties: { label: "Shop now" },
      },
    });
    expect(transition).toBeNull();
  });

  it("returns null for rich-text edits and structural ops", () => {
    expect(
      describeValueTransition({
        op: { name: "updateText", blockId: "txt_a1b2", text: { type: "doc", content: [] } },
        inverse: { name: "updateText", blockId: "txt_a1b2", text: { type: "doc", content: [] } },
      }),
    ).toBeNull();
    expect(
      describeValueTransition({
        op: { name: "removeBlock", blockId: BUTTON_ID },
        inverse: { name: "restoreBlocks", blocks: [], parentId: "sec_a1b2", index: 0 },
      }),
    ).toBeNull();
    expect(describeValueTransition({ op: null, inverse: undefined })).toBeNull();
  });
});

describe("describeValueTransition — document settings (globals)", () => {
  it("diffs a single-key settings merge against the inverse's root snapshot", () => {
    const transition = describeValueTransition({
      op: { name: "updateDocumentSettings", globals: { contentWidth: 520 } },
      inverse: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: { contentWidth: 600, linkTextColor: "#067df7" } },
      },
    });
    expect(transition).toEqual({
      kind: "number",
      property: "content width",
      before: 600,
      after: 520,
      unit: "px",
    });
  });

  it("falls back to the renderer default when the global was previously unset", () => {
    const transition = describeValueTransition({
      op: { name: "updateDocumentSettings", globals: { buttonBackgroundColor: "#ff00ff" } },
      inverse: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: {} },
      },
    });
    expect(transition).toEqual({
      kind: "color",
      property: "button background",
      before: DEFAULT_GLOBAL_STYLES.buttonBackgroundColor,
      after: "#ff00ff",
    });
  });
});

describe("describeValueTransition — themes", () => {
  const previousGlobals = {
    emailBackgroundColor: "#f4f4f4",
    contentBackgroundColor: "#ffffff",
    buttonBackgroundColor: "#000000",
  };
  const midnightGlobals = {
    emailBackgroundColor: "#0b0b1a",
    contentBackgroundColor: "#16213e",
    buttonBackgroundColor: "#e94560",
  };

  it("returns a theme swatch pair for applyTheme (before from the inverse snapshot)", () => {
    const transition = describeValueTransition({
      op: { name: "applyTheme", globals: midnightGlobals },
      inverse: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: previousGlobals },
      },
    });
    expect(transition).toMatchObject({
      kind: "theme",
      before: { emailBackgroundColor: "#f4f4f4", contentBackgroundColor: "#ffffff" },
      after: { emailBackgroundColor: "#0b0b1a", contentBackgroundColor: "#16213e" },
    });
  });

  it("handles an applyTheme inverse (section overrides existed) the same way", () => {
    const transition = describeValueTransition({
      op: { name: "applyTheme", globals: midnightGlobals },
      inverse: { name: "applyTheme", globals: previousGlobals, sectionOverrides: [] },
    });
    expect(transition).toMatchObject({
      kind: "theme",
      before: { emailBackgroundColor: "#f4f4f4" },
      after: { emailBackgroundColor: "#0b0b1a" },
    });
  });

  it("renders an UNDO of a theme apply as the reversed swatch pair", () => {
    /*
      Undo entry: op restores the old root snapshot, inverse holds the theme'd one.
    */
    const transition = describeValueTransition({
      op: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: previousGlobals },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: midnightGlobals },
      },
    });
    expect(transition).toMatchObject({
      kind: "theme",
      before: { emailBackgroundColor: "#0b0b1a" },
      after: { emailBackgroundColor: "#f4f4f4" },
    });
  });

  it("keeps a small root swap scalar (undo of a single settings change)", () => {
    const transition = describeValueTransition({
      op: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: { contentWidth: 600 } },
      },
      inverse: {
        name: "replaceBlockProperties",
        blockId: "root",
        properties: { globals: { contentWidth: 520 } },
      },
    });
    expect(transition).toMatchObject({ kind: "number", before: 520, after: 600, unit: "px" });
  });
});

describe("formatTransitionTooltip", () => {
  it("formats raw values with the property phrase", () => {
    expect(
      formatTransitionTooltip({
        kind: "color",
        property: "background color",
        before: "#ff0000",
        after: "#0000ff",
      }),
    ).toBe("background color: #ff0000 → #0000ff");
    expect(
      formatTransitionTooltip({
        kind: "number",
        property: "padding",
        before: 24,
        after: 12,
        unit: "px",
      }),
    ).toBe("padding: 24px → 12px");
  });
});
