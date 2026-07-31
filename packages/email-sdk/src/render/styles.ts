import type {
  Block,
  ButtonBlock,
  CodeBlock,
  ColumnBlock,
  DividerBlock,
  ImageBlock,
  LinkBlock,
  RootBlock,
  RowBlock,
  SectionBlock,
  SpacerBlock,
  TextBlock,
} from "../schema/blocks";
import {
  DEFAULT_GLOBAL_STYLES,
  type GlobalStyles,
  type TextAlign,
} from "../schema/globals";
import type { BlockType } from "../schema/ids";

/**
 * Style resolution — the renderer's single source of final, fully-defaulted
 * style values. Pure and framework-free so it is unit-testable and reusable
 * by the Phase 2 editing canvas.
 *
 * Precedence, lowest to highest:
 *
 *   1. DEFAULT_GLOBAL_STYLES        (the renderer contract in schema/globals)
 *   2. root.properties.globals      (the document-wide theme)
 *   3. block-level property overrides
 *
 * Sections additionally chain their backgrounds off the canvas globals:
 * innerBackgroundColor ← globals.contentBackgroundColor and
 * outerBackgroundColor ← globals.emailBackgroundColor, unless overridden.
 *
 * Padding defaults derive from globals.baseSpacing:
 *   section — top/left/right = baseSpacing, bottom = 0 (the last leaf's own
 *             bottom padding closes the section symmetrically)
 *   leaves  — bottom = baseSpacing (the "space between blocks"), others 0
 *   rows/columns — 0
 */

// ---------------------------------------------------------------------------
// Resolved style shapes
// ---------------------------------------------------------------------------

/** Fully-defaulted box padding, in pixels. */
export interface ResolvedPadding {
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
}

/** Canvas-level values the root traversal needs. */
export interface ResolvedRootStyles {
  emailBackgroundColor: string;
  contentBackgroundColor: string;
  contentWidth: number;
  baseSpacing: number;
}

export interface ResolvedSectionStyles extends ResolvedPadding {
  /** Background of the section's centered content area. */
  innerBackgroundColor: string;
  /** Background of the full-width band behind the content area. */
  outerBackgroundColor: string;
  /** Width of the centered content area, from globals.contentWidth. */
  contentWidth: number;
}

export interface ResolvedRowStyles {
  paddingTop: number;
  paddingBottom: number;
}

export interface ResolvedColumnStyles extends ResolvedPadding {
  /** Undefined means "share the row equally with sibling columns". */
  widthPercent: number | undefined;
  verticalAlign: "top" | "middle" | "bottom";
  /** Undefined means transparent (the section background shows through). */
  backgroundColor: string | undefined;
}

/** Resolved styles for one rich-text node scope (a heading level or paragraph). */
export interface ResolvedTextNodeStyles {
  fontFamily: string;
  textColor: string;
  textAlign: TextAlign;
}

export interface ResolvedTextStyles extends ResolvedPadding {
  heading1: ResolvedTextNodeStyles;
  heading2: ResolvedTextNodeStyles;
  heading3: ResolvedTextNodeStyles;
  paragraph: ResolvedTextNodeStyles;
  linkTextColor: string;
}

export interface ResolvedButtonStyles extends ResolvedPadding {
  backgroundColor: string;
  textColor: string;
  borderRadius: number;
  borderSize: number;
  borderColor: string;
  horizontalPadding: number;
  verticalPadding: number;
  fontFamily: string;
  align: TextAlign;
}

export interface ResolvedImageStyles extends ResolvedPadding {
  align: TextAlign;
  /** Undefined means transparent (the container background shows through). */
  backgroundColor: string | undefined;
}

export interface ResolvedDividerStyles extends ResolvedPadding {
  color: string;
  thickness: number;
}

export interface ResolvedLinkStyles extends ResolvedPadding {
  textColor: string;
  fontFamily: string;
  fontSize: number;
  isUnderlined: boolean;
  align: TextAlign;
}

export interface ResolvedCodeStyles extends ResolvedPadding {
  theme: "light" | "dark";
  shouldShowLineNumbers: boolean;
}

export interface ResolvedSpacerStyles {
  height: number;
}

/** Map from block type to its resolved-styles shape. */
export interface ResolvedStylesByBlockType {
  root: ResolvedRootStyles;
  section: ResolvedSectionStyles;
  row: ResolvedRowStyles;
  column: ResolvedColumnStyles;
  text: ResolvedTextStyles;
  button: ResolvedButtonStyles;
  image: ResolvedImageStyles;
  divider: ResolvedDividerStyles;
  link: ResolvedLinkStyles;
  code: ResolvedCodeStyles;
  spacer: ResolvedSpacerStyles;
}

/** Resolved styles for any block type. */
export type ResolvedBlockStyles = ResolvedStylesByBlockType[BlockType];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Layer the document globals over DEFAULT_GLOBAL_STYLES, ignoring undefined
 * values, so every global field has a concrete value.
 */
export function resolveGlobalStyles(globals: GlobalStyles | undefined): Required<GlobalStyles> {
  const resolved: Required<GlobalStyles> = { ...DEFAULT_GLOBAL_STYLES };
  if (globals !== undefined) {
    for (const [key, value] of Object.entries(globals)) {
      if (value !== undefined) {
        (resolved as Record<string, unknown>)[key] = value;
      }
    }
  }
  return resolved;
}

interface PaddingOverrides {
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
}

function resolvePadding(overrides: PaddingOverrides, defaults: ResolvedPadding): ResolvedPadding {
  return {
    paddingTop: overrides.paddingTop ?? defaults.paddingTop,
    paddingBottom: overrides.paddingBottom ?? defaults.paddingBottom,
    paddingLeft: overrides.paddingLeft ?? defaults.paddingLeft,
    paddingRight: overrides.paddingRight ?? defaults.paddingRight,
  };
}

/** Leaf blocks default to baseSpacing below (the space between blocks). */
function leafPaddingDefaults(baseSpacing: number): ResolvedPadding {
  return { paddingTop: 0, paddingBottom: baseSpacing, paddingLeft: 0, paddingRight: 0 };
}

function resolveRootStyles(globals: Required<GlobalStyles>): ResolvedRootStyles {
  return {
    emailBackgroundColor: globals.emailBackgroundColor,
    contentBackgroundColor: globals.contentBackgroundColor,
    contentWidth: globals.contentWidth,
    baseSpacing: globals.baseSpacing,
  };
}

function resolveSectionStyles(
  globals: Required<GlobalStyles>,
  block: SectionBlock,
): ResolvedSectionStyles {
  const { properties } = block;
  return {
    innerBackgroundColor: properties.innerBackgroundColor ?? globals.contentBackgroundColor,
    outerBackgroundColor: properties.outerBackgroundColor ?? globals.emailBackgroundColor,
    contentWidth: globals.contentWidth,
    ...resolvePadding(properties, {
      paddingTop: globals.baseSpacing,
      paddingBottom: 0,
      paddingLeft: globals.baseSpacing,
      paddingRight: globals.baseSpacing,
    }),
  };
}

function resolveRowStyles(block: RowBlock): ResolvedRowStyles {
  return {
    paddingTop: block.properties.paddingTop ?? 0,
    paddingBottom: block.properties.paddingBottom ?? 0,
  };
}

function resolveColumnStyles(block: ColumnBlock): ResolvedColumnStyles {
  const { properties } = block;
  return {
    widthPercent: properties.widthPercent,
    verticalAlign: properties.verticalAlign ?? "top",
    backgroundColor: properties.backgroundColor,
    ...resolvePadding(properties, {
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
    }),
  };
}

function resolveTextStyles(globals: Required<GlobalStyles>, block: TextBlock): ResolvedTextStyles {
  const { textColor, textAlign } = block.properties;
  const nodeStyles = ({
    fontFamily,
    globalColor,
    globalAlign,
  }: {
    fontFamily: string;
    globalColor: string;
    globalAlign: TextAlign;
  }): ResolvedTextNodeStyles => ({
    fontFamily,
    // Block-level textColor/textAlign override the per-node-type globals for
    // EVERY node in this block.
    textColor: textColor ?? globalColor,
    textAlign: textAlign ?? globalAlign,
  });
  return {
    heading1: nodeStyles({ fontFamily: globals.heading1FontFamily, globalColor: globals.heading1TextColor, globalAlign: globals.heading1TextAlign }),
    heading2: nodeStyles({ fontFamily: globals.heading2FontFamily, globalColor: globals.heading2TextColor, globalAlign: globals.heading2TextAlign }),
    heading3: nodeStyles({ fontFamily: globals.heading3FontFamily, globalColor: globals.heading3TextColor, globalAlign: globals.heading3TextAlign }),
    paragraph: nodeStyles({ fontFamily: globals.paragraphFontFamily, globalColor: globals.paragraphTextColor, globalAlign: globals.paragraphTextAlign }),
    linkTextColor: globals.linkTextColor,
    ...resolvePadding(block.properties, leafPaddingDefaults(globals.baseSpacing)),
  };
}

function resolveButtonStyles(
  globals: Required<GlobalStyles>,
  block: ButtonBlock,
): ResolvedButtonStyles {
  const { properties } = block;
  return {
    backgroundColor: properties.backgroundColor ?? globals.buttonBackgroundColor,
    textColor: properties.textColor ?? globals.buttonTextColor,
    borderRadius: properties.borderRadius ?? globals.buttonBorderRadius,
    borderSize: properties.borderSize ?? globals.buttonBorderSize,
    borderColor: properties.borderColor ?? globals.buttonBorderColor,
    horizontalPadding: properties.horizontalPadding ?? globals.buttonHorizontalPadding,
    verticalPadding: properties.verticalPadding ?? globals.buttonVerticalPadding,
    fontFamily: properties.fontFamily ?? globals.buttonFontFamily,
    align: properties.align ?? "left",
    ...resolvePadding(properties, leafPaddingDefaults(globals.baseSpacing)),
  };
}

function resolveImageStyles(globals: Required<GlobalStyles>, block: ImageBlock): ResolvedImageStyles {
  return {
    align: block.properties.align ?? "center",
    backgroundColor: block.properties.backgroundColor,
    ...resolvePadding(block.properties, leafPaddingDefaults(globals.baseSpacing)),
  };
}

function resolveDividerStyles(
  globals: Required<GlobalStyles>,
  block: DividerBlock,
): ResolvedDividerStyles {
  return {
    color: block.properties.color ?? globals.dividerColor,
    thickness: block.properties.thickness ?? 1,
    ...resolvePadding(block.properties, leafPaddingDefaults(globals.baseSpacing)),
  };
}

/** Renderer default font size for standalone links (matches paragraph text). */
const DEFAULT_LINK_FONT_SIZE = 14;

function resolveLinkStyles(globals: Required<GlobalStyles>, block: LinkBlock): ResolvedLinkStyles {
  const { properties } = block;
  return {
    textColor: properties.textColor ?? globals.linkTextColor,
    fontFamily: properties.fontFamily ?? globals.paragraphFontFamily,
    fontSize: properties.fontSize ?? DEFAULT_LINK_FONT_SIZE,
    isUnderlined: properties.isUnderlined ?? true,
    align: properties.align ?? "left",
    ...resolvePadding(properties, leafPaddingDefaults(globals.baseSpacing)),
  };
}

function resolveCodeStyles(globals: Required<GlobalStyles>, block: CodeBlock): ResolvedCodeStyles {
  return {
    theme: block.properties.theme ?? "dark",
    shouldShowLineNumbers: block.properties.shouldShowLineNumbers ?? false,
    ...resolvePadding(block.properties, leafPaddingDefaults(globals.baseSpacing)),
  };
}

function resolveSpacerStyles(block: SpacerBlock): ResolvedSpacerStyles {
  return { height: block.properties.height };
}

function resolveAnyBlockStyles(
  globals: Required<GlobalStyles>,
  block: Block,
): ResolvedBlockStyles {
  switch (block.type) {
    case "root":
      return resolveRootStyles(globals);
    case "section":
      return resolveSectionStyles(globals, block);
    case "row":
      return resolveRowStyles(block);
    case "column":
      return resolveColumnStyles(block);
    case "text":
      return resolveTextStyles(globals, block);
    case "button":
      return resolveButtonStyles(globals, block);
    case "image":
      return resolveImageStyles(globals, block);
    case "divider":
      return resolveDividerStyles(globals, block);
    case "link":
      return resolveLinkStyles(globals, block);
    case "code":
      return resolveCodeStyles(globals, block);
    case "spacer":
      return resolveSpacerStyles(block);
  }
}

/**
 * Resolve the final styles for one block:
 * DEFAULT_GLOBAL_STYLES → `globals` (root.properties.globals) → block overrides.
 *
 * `globals` is the raw (possibly partial or absent) object from the document
 * root; defaulting is handled here.
 */
export function resolveBlockStyles<TBlock extends Block>(
  globals: GlobalStyles | undefined,
  block: TBlock,
): ResolvedStylesByBlockType[TBlock["type"]] {
  return resolveAnyBlockStyles(resolveGlobalStyles(globals), block) as ResolvedStylesByBlockType[
    TBlock["type"]
  ];
}

/** Cast-free convenience: root styles straight from a root block. */
export function resolveRootBlockStyles(root: RootBlock): ResolvedRootStyles {
  return resolveRootStyles(resolveGlobalStyles(root.properties.globals));
}
