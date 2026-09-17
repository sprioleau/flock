import { parseDocument } from "htmlparser2";
import type { EmailDocument } from "@flock/email-sdk";
import { checkDocumentIntegrity, emailDocumentSchema } from "@flock/email-sdk";

/* eslint-disable max-params */

interface ParsedTextNode {
  type: "text";
  data: string;
}

interface ParsedElement {
  type: "tag" | "script" | "style";
  name: string;
  attribs: Record<string, string>;
  children: ParsedNode[];
}

interface ParsedOtherNode {
  type: "comment" | "directive" | "cdata";
}

type ParsedNode = ParsedTextNode | ParsedElement | ParsedOtherNode;
type ChildNode = ParsedNode;
type Element = ParsedElement;

/*
  Preview-only HTML email importer. The returned document is the only value
  that may enter the editor; sanitizedHtml is retained for side-by-side
  comparison and provenance, never rendered as editor content.
*/

export const MAX_HTML_IMPORT_BYTES = 512 * 1024;

const SAFE_SOURCE_TAGS = new Set([
  "a",
  "b",
  "body",
  "br",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "html",
  "img",
  "i",
  "li",
  "ol",
  "p",
  "span",
  "strong",
  "s",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const ACTIVE_TAGS = new Set([
  "audio",
  "embed",
  "form",
  "iframe",
  "object",
  "script",
  "style",
  "svg",
  "video",
]);

const UNSUPPORTED_LAYOUT_TAGS = new Set(["center", "font", "marquee", "noscript", "picture", "source"]);

const SAFE_STYLE_PROPERTIES = new Set([
  "background-color",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-transform",
]);

const SAFE_TEXT_STYLE_PROPERTIES = new Set(["color", "font-family", "font-size"]);

const SAFE_CSS_PROPERTIES = new Set([
  ...SAFE_STYLE_PROPERTIES,
  "background",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
]);

const INHERITED_CSS_PROPERTIES = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "text-transform",
]);

const MAX_STYLESHEET_RULES = 256;
const MAX_STYLESHEET_DECLARATIONS = 2048;
const UNREPRESENTED_CSS_PROPERTIES = new Set([
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "text-transform",
]);

type BlockType = "section" | "row" | "column" | "text" | "button" | "image" | "divider" | "link";

export type HtmlImportWarningCode =
  | "active-content-removed"
  | "unsupported-feature"
  | "background-image-removed"
  | "unsafe-url-removed"
  | "relative-url-removed"
  | "tracking-pixel-removed"
  | "source-too-large";

export interface HtmlImportWarning {
  code: HtmlImportWarningCode;
  detail: string;
}

export interface HtmlImportReport {
  importerVersion: "1";
  warnings: HtmlImportWarning[];
  unsupportedFeatures: string[];
  blockCount: number;
}

export interface HtmlEmailImportResult {
  document: EmailDocument;
  report: HtmlImportReport;
  sanitizedHtml: string;
}

export class HtmlEmailImportError extends Error {
  readonly code: "empty" | "too-large" | "invalid-document";

  constructor(code: "empty" | "too-large" | "invalid-document", message: string) {
    super(message);
    this.name = "HtmlEmailImportError";
    this.code = code;
  }
}

interface MutableReport {
  warnings: HtmlImportWarning[];
  unsupportedFeatures: Set<string>;
}

interface StyleMap {
  [property: string]: string;
}

interface StyleRule {
  selector: string;
  declarations: StyleMap;
  specificity: number;
  order: number;
}

interface IdFactory {
  next(type: BlockType): string;
}

interface ConversionContext {
  document: EmailDocument;
  ids: IdFactory;
  report: MutableReport;
  baseUrl: string | null;
  computedStyles: WeakMap<Element, StyleMap>;
}

function createIdFactory(): IdFactory {
  const counts = new Map<BlockType, number>();
  return {
    next(type) {
      const nextCount = (counts.get(type) ?? 0) + 1;
      counts.set(type, nextCount);
      const suffix = nextCount.toString(36).padStart(4, "0").slice(-4);
      return `${type === "section" ? "sec" : type === "row" ? "row" : type === "column" ? "col" : type === "text" ? "txt" : type === "button" ? "btn" : type === "image" ? "img" : type === "divider" ? "div" : "lnk"}_${suffix}`;
    },
  };
}

function warn(report: MutableReport, code: HtmlImportWarningCode, detail: string): void {
  if (report.warnings.some((warning) => warning.code === code && warning.detail === detail)) {
    return;
  }
  report.warnings.push({ code, detail });
}

function elementName(node: ChildNode): string | null {
  return node.type === "tag" || node.type === "script" || node.type === "style" ? node.name.toLowerCase() : null;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll("'", "&#39;");
}

function sanitizeStyle(rawStyle: string, allowedProperties: Set<string>): string {
  const declarations: string[] = [];
  for (const declaration of rawStyle.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!allowedProperties.has(property) || value.length === 0) continue;
    if (/[{}<>]|url\s*\(|expression\s*\(|@import/i.test(value)) continue;
    if (property === "text-align" && !/^(left|center|right)$/i.test(value)) continue;
    if (property === "font-size" && !/^\d+(?:\.\d+)?px$/i.test(value)) continue;
    if (property.startsWith("padding-") && !/^\d+(?:\.\d+)?px$/i.test(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  return declarations.join(";");
}

function styleDeclarations(rawStyle: string): StyleMap {
  const declarations: StyleMap = {};
  for (const declaration of rawStyle.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (property.length > 0 && value.length > 0) declarations[property] = value;
  }
  return declarations;
}

function cssTextContent(nodes: ChildNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.data;
      if (node.type === "tag" || node.type === "style") return cssTextContent(node.children);
      return "";
    })
    .join("");
}

function safeFontFamily(value: string): string | undefined {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 200 ||
    /[{}<>;:]|url\s*\(|expression\s*\(|@import/i.test(normalized) ||
    !/^[a-z\d\s,'"._-]+$/i.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function safeCssLength(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!/^\d+(?:\.\d+)?px$/.test(normalized)) return undefined;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1600 ? normalized : undefined;
}

function safeCssValue(property: string, value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512 || /[{}<>]|expression\s*\(|@import/i.test(normalized)) return undefined;
  if (property === "color" || property === "background-color") return safeColor(normalized);
  if (property === "font-family") return safeFontFamily(normalized);
  if (property === "font-size") {
    return /^\d+px$/i.test(normalized) && safeCssLength(normalized) !== undefined
      ? normalized.toLowerCase()
      : undefined;
  }
  if (property === "font-weight") return /^(normal|bold|bolder|lighter|[1-9]00)$/i.test(normalized) ? normalized.toLowerCase() : undefined;
  if (property === "line-height") return /^(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?px)$/i.test(normalized) ? normalized : undefined;
  if (property === "text-transform") return /^(none|uppercase|lowercase|capitalize)$/i.test(normalized) ? normalized.toLowerCase() : undefined;
  if (property === "text-align") return /^(left|center|right)$/i.test(normalized) ? normalized.toLowerCase() : undefined;
  if (property.startsWith("padding") || property.startsWith("margin")) {
    if (property === "padding" || property === "margin") {
      const values = normalized.split(/\s+/);
      return values.length >= 1 && values.length <= 4 && values.every((item) => safeCssLength(item) !== undefined)
        ? values.join(" ")
        : undefined;
    }
    return safeCssLength(normalized);
  }
  if (property === "background-size") return safeBackgroundSize(normalized);
  if (property === "background-position") return safeBackgroundPosition(normalized);
  if (property === "background-repeat") return safeBackgroundRepeat(normalized);
  if (property === "background" || property === "background-image") {
    if (/gradient\s*\(|,|url\s*\([^)]*url\s*\(/i.test(normalized)) return undefined;
    return normalized;
  }
  return undefined;
}

function sanitizedCssDeclarations(rawStyle: string, report: MutableReport): StyleMap {
  const declarations: StyleMap = {};
  for (const [property, value] of Object.entries(styleDeclarations(rawStyle))) {
    if (!SAFE_CSS_PROPERTIES.has(property)) {
      report.unsupportedFeatures.add("stylesheet");
      warn(report, "unsupported-feature", `The stylesheet property ${property} was omitted.`);
      continue;
    }
    const safeValue = safeCssValue(property, value);
    if (safeValue === undefined) {
      report.unsupportedFeatures.add("stylesheet");
      warn(report, "unsupported-feature", `An unsafe or unsupported value for ${property} was omitted.`);
      continue;
    }
    if (UNREPRESENTED_CSS_PROPERTIES.has(property)) {
      report.unsupportedFeatures.add("stylesheet");
      warn(report, "unsupported-feature", `The stylesheet property ${property} was omitted because the editor cannot represent it.`);
      continue;
    }
    declarations[property] = safeValue;
  }
  return declarations;
}

function safeInlineDeclarations(rawStyle: string, report: MutableReport): StyleMap {
  const declarations: StyleMap = {};
  for (const [property, value] of Object.entries(styleDeclarations(rawStyle))) {
    if (!SAFE_CSS_PROPERTIES.has(property)) continue;
    const safeValue = safeCssValue(property, value);
    if (safeValue === undefined) continue;
    if (UNREPRESENTED_CSS_PROPERTIES.has(property)) {
      report.unsupportedFeatures.add("stylesheet");
      warn(report, "unsupported-feature", `The inline style property ${property} was omitted because the editor cannot represent it.`);
      continue;
    }
    declarations[property] = safeValue;
  }
  return declarations;
}

function selectorSpecificity(selector: string): number | null {
  if (!/^(?:[a-z][a-z\d_-]*)?(?:#[a-z\d_-]+)?(?:\.[a-z\d_-]+)*$/i.test(selector)) return null;
  return (selector.match(/#/g)?.length ?? 0) * 100 + (selector.match(/\./g)?.length ?? 0) * 10 + (/^[a-z]/i.test(selector) ? 1 : 0);
}

function selectorMatches(selector: string, element: Element): boolean {
  const tagMatch = /^([a-z][a-z\d_-]*)/i.exec(selector);
  if (tagMatch !== null && tagMatch[1].toLowerCase() !== element.name.toLowerCase()) return false;
  const idMatch = /#([a-z\d_-]+)/i.exec(selector);
  if (idMatch !== null && idMatch[1] !== (element.attribs.id ?? "")) return false;
  const expectedClasses = [...selector.matchAll(/\.([a-z\d_-]+)/gi)].map((match) => match[1]);
  const classes = new Set((element.attribs.class ?? "").split(/\s+/).filter(Boolean));
  return expectedClasses.every((className) => classes.has(className));
}

function parseStylesheetRules(nodes: ChildNode[], report: MutableReport): StyleRule[] {
  const rules: StyleRule[] = [];
  let order = 0;

  function balancedCssBlocks(css: string): Array<{ header: string; body: string }> {
    const blocks: Array<{ header: string; body: string }> = [];
    let cursor = 0;
    while (cursor < css.length) {
      const openBrace = css.indexOf("{", cursor);
      if (openBrace === -1) break;
      let depth = 1;
      let quote: string | null = null;
      let index = openBrace + 1;
      for (; index < css.length && depth > 0; index += 1) {
        const character = css[index];
        if (quote !== null) {
          if (character === quote && css[index - 1] !== "\\") quote = null;
          continue;
        }
        if (character === "\"" || character === "'") {
          quote = character;
        } else if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
      }
      if (depth !== 0) break;
      blocks.push({ header: css.slice(cursor, openBrace).trim(), body: css.slice(openBrace + 1, index - 1) });
      cursor = index;
    }
    return blocks;
  }

  function visit(children: ChildNode[]): void {
    for (const node of children) {
      if (node.type === "style") {
        const css = cssTextContent(node.children)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/@(import|charset|namespace)\b[^;{}]*(?:;|$)/gi, () => {
            report.unsupportedFeatures.add("stylesheet");
            warn(report, "unsupported-feature", "At-rules were omitted from the stylesheet.");
            return "";
          });
        for (const block of balancedCssBlocks(css)) {
          if (rules.length >= MAX_STYLESHEET_RULES) {
            report.unsupportedFeatures.add("stylesheet");
            warn(report, "unsupported-feature", "Stylesheet rule limit reached; remaining rules were omitted.");
            break;
          }
          const rawSelector = block.header;
          if (rawSelector.startsWith("@")) {
            report.unsupportedFeatures.add("stylesheet");
            warn(report, "unsupported-feature", "At-rules were omitted from the stylesheet.");
            continue;
          }
          const selectors = rawSelector.split(",").map((selector) => selector.trim()).filter(Boolean);
          const declarations = sanitizedCssDeclarations(block.body, report);
          if (Object.keys(declarations).length === 0) continue;
          if (order + Object.keys(declarations).length > MAX_STYLESHEET_DECLARATIONS) {
            report.unsupportedFeatures.add("stylesheet");
            warn(report, "unsupported-feature", "Stylesheet declaration limit reached; remaining declarations were omitted.");
            continue;
          }
          order += Object.keys(declarations).length;
          for (const selector of selectors) {
            const specificity = selectorSpecificity(selector);
            if (specificity === null) {
              report.unsupportedFeatures.add("stylesheet");
              warn(report, "unsupported-feature", `The stylesheet selector ${selector} was omitted.`);
              continue;
            }
            rules.push({ selector, declarations, specificity, order });
          }
        }
      }
      if (node.type === "tag" || node.type === "script" || node.type === "style") visit(node.children);
    }
  }
  visit(nodes);
  return rules;
}

function expandSpacing(declarations: StyleMap, property: "padding" | "margin"): StyleMap {
  const expanded: StyleMap = {};
  const shorthand = declarations[property];
  if (shorthand !== undefined) {
    const values = shorthand.split(/\s+/);
    const [top, right, bottom, left] = values.length === 1
      ? [values[0], values[0], values[0], values[0]]
      : values.length === 2
        ? [values[0], values[1], values[0], values[1]]
        : values.length === 3
          ? [values[0], values[1], values[2], values[1]]
          : [values[0], values[1], values[2], values[3]];
    expanded[`${property}-top`] = top;
    expanded[`${property}-right`] = right;
    expanded[`${property}-bottom`] = bottom;
    expanded[`${property}-left`] = left;
  }
  for (const side of ["top", "right", "bottom", "left"]) {
    const key = `${property}-${side}`;
    if (declarations[key] !== undefined) expanded[key] = declarations[key];
  }
  return expanded;
}

function safeColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 100 ||
    /[{}<>"']|url\s*\(|expression\s*\(|@import|;|:/i.test(normalized)
  ) {
    return undefined;
  }
  return /^[#a-z\d(),.%\s+-]+$/i.test(normalized) ? normalized : undefined;
}

function buildComputedStyles(nodes: ChildNode[], rules: StyleRule[], report: MutableReport): WeakMap<Element, StyleMap> {
  const computedStyles = new WeakMap<Element, StyleMap>();
  function visit(children: ChildNode[], inherited: StyleMap): void {
    for (const node of children) {
      if (node.type !== "tag") continue;
      const matchedRules = rules
        .filter((rule) => selectorMatches(rule.selector, node))
        .sort((left, right) => left.specificity - right.specificity || left.order - right.order);
      const declarations: StyleMap = { ...inherited };
      for (const rule of matchedRules) Object.assign(declarations, rule.declarations);
      const inlineDeclarations = safeInlineDeclarations(node.attribs.style ?? "", report);
      Object.assign(declarations, inlineDeclarations);
      const computed = { ...declarations, ...expandSpacing(declarations, "padding") };
      computedStyles.set(node, computed);
      const nextInherited: StyleMap = {};
      for (const property of INHERITED_CSS_PROPERTIES) {
        if (computed[property] !== undefined) nextInherited[property] = computed[property];
      }
      visit(node.children, nextInherited);
    }
  }
  visit(nodes, {});
  return computedStyles;
}

function backgroundWarning(context: ConversionContext, detail: string): void {
  warn(context.report, "background-image-removed", detail);
}

function extractCssUrl(rawValue: string, isExact: boolean): string | null {
  const value = rawValue.trim();
  const match = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/i.exec(value);
  if (match === null) return null;
  if (isExact && match[0].trim() !== value) return null;
  if ((value.match(/url\s*\(/gi) ?? []).length !== 1) return null;
  if (/[,]|gradient\s*\(/i.test(value)) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function safeBackgroundUrl(rawValue: string | undefined, context: ConversionContext, isCssValue = false): string | null {
  if (rawValue === undefined) return null;
  const value = rawValue.trim();
  if (value.length === 0 || /[{}]|\*\||\|\*/.test(value)) {
    backgroundWarning(context, "A merge-tag background image was omitted.");
    return null;
  }
  const urlValue = isCssValue ? extractCssUrl(value, false) : value;
  if (urlValue === null || /[,]|gradient\s*\(|url\s*\(/i.test(isCssValue ? value.replace(/url\([^)]*\)/i, "") : value)) {
    context.report.unsupportedFeatures.add("background-image");
    backgroundWarning(context, "A gradient or multilayer background image was omitted.");
    warn(context.report, "unsupported-feature", "A gradient or multilayer background image was omitted.");
    return null;
  }
  if (urlValue.length > 2048 || /[\u0000-\u001f\u007f"'\\]/.test(urlValue)) {
    backgroundWarning(context, "An oversized or malformed background image URL was omitted.");
    warn(context.report, "unsafe-url-removed", "A malformed URL was omitted.");
    return null;
  }
  const resolved = safeUrl(urlValue, context);
  if (resolved === null) backgroundWarning(context, "An unsafe background image was omitted.");
  return resolved;
}

function safeBackgroundSize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return /^(cover|contain|auto)$/.test(normalized) ? normalized : undefined;
}

function safeBackgroundPosition(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "center top": "top center",
    "left top": "top left",
    "right top": "top right",
    "left center": "center left",
    "right center": "center right",
    "left bottom": "bottom left",
    "center bottom": "bottom center",
    "right bottom": "bottom right",
  };
  const canonical = aliases[normalized] ?? normalized;
  return /^(center|top|right|bottom|left|top left|top center|top right|center left|center center|center right|bottom left|bottom center|bottom right)$/.test(canonical)
    ? canonical
    : undefined;
}

function safeBackgroundRepeat(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return /^(repeat|repeat-x|repeat-y|no-repeat)$/.test(normalized) ? normalized : undefined;
}

function readBackgroundProperties(element: Element, context: ConversionContext): Record<string, unknown> {
  const declarations = readComputedStyles(element, context, SAFE_CSS_PROPERTIES);
  const rawImage = declarations["background-image"] ?? declarations.background ?? element.attribs.background;
  const backgroundImageUrl = safeBackgroundUrl(rawImage, context, declarations["background-image"] !== undefined || declarations.background !== undefined);
  const backgroundSize = safeBackgroundSize(declarations["background-size"]);
  const backgroundPosition = safeBackgroundPosition(declarations["background-position"]);
  const backgroundRepeat = safeBackgroundRepeat(declarations["background-repeat"]);
  if (declarations["background-size"] !== undefined && backgroundSize === undefined) {
    backgroundWarning(context, "An unsupported background size was omitted.");
  }
  if (declarations["background-position"] !== undefined && backgroundPosition === undefined) {
    backgroundWarning(context, "An unsupported background position was omitted.");
  }
  if (declarations["background-repeat"] !== undefined && backgroundRepeat === undefined) {
    backgroundWarning(context, "An unsupported background repeat value was omitted.");
  }
  if (backgroundImageUrl === null) return {};
  return {
    backgroundImageUrl,
    ...(backgroundSize === undefined ? {} : { backgroundSize }),
    ...(backgroundPosition === undefined ? {} : { backgroundPosition }),
    ...(backgroundRepeat === undefined ? {} : { backgroundRepeat }),
  };
}

function readBackgroundColor(element: Element, context?: ConversionContext): string | undefined {
  const styles = context === undefined ? styleDeclarations(element.attribs.style ?? "") : readComputedStyles(element, context, SAFE_CSS_PROPERTIES);
  return safeColor(styles["background-color"] ?? element.attribs.bgcolor);
}

function readStyles(element: Element, allowedProperties = SAFE_STYLE_PROPERTIES): StyleMap {
  const rawStyle = element.attribs.style ?? "";
  const sanitized = sanitizeStyle(rawStyle, allowedProperties);
  return Object.fromEntries(
    sanitized
      .split(";")
      .filter(Boolean)
      .map((declaration) => {
        const separator = declaration.indexOf(":");
        return [declaration.slice(0, separator), declaration.slice(separator + 1)];
      }),
  );
}

function readComputedStyles(element: Element, context: ConversionContext, allowedProperties = SAFE_STYLE_PROPERTIES): StyleMap {
  const styles = context.computedStyles.get(element) ?? {};
  return Object.fromEntries(Object.entries(styles).filter(([property]) => allowedProperties.has(property)));
}

function readBlockSpacing(element: Element, context: ConversionContext): Record<string, number> {
  const styles = readComputedStyles(element, context, SAFE_CSS_PROPERTIES);
  const spacing = expandSpacing(styles, "padding");
  const entries = Object.entries(spacing).flatMap(([property, rawValue]) => {
    const value = Number.parseFloat(rawValue);
    if (!Number.isFinite(value) || value < 0 || value > 1600) return [];
    return [[
      `padding${property.slice("padding-".length, "padding-".length + 1).toUpperCase()}${property.slice("padding-".length + 1)}`,
      value,
    ] as const];
  });
  return Object.fromEntries(entries);
}

function readPaddingValues(element: Element, context: ConversionContext): Record<string, number> {
  const styles = readComputedStyles(element, context, SAFE_CSS_PROPERTIES);
  const spacing = expandSpacing(styles, "padding");
  return Object.fromEntries(
    Object.entries(spacing).flatMap(([property, rawValue]) => {
      const value = Number.parseFloat(rawValue);
      return Number.isFinite(value) && value >= 0 && value <= 1600
        ? [[property.slice("padding-".length), value]]
        : [];
    }),
  );
}

function readButtonPadding(element: Element, context: ConversionContext): Record<string, number> {
  const values = readPaddingValues(element, context);
  const top = values.top;
  const right = values.right;
  const bottom = values.bottom;
  const left = values.left;
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) return {};
  if (top !== bottom || right !== left) {
    warn(context.report, "unsupported-feature", "Asymmetric anchor padding was reduced to the button's vertical and horizontal padding.");
  }
  return { verticalPadding: top, horizontalPadding: left };
}

function safeUrl(rawUrl: string | undefined, context: ConversionContext): string | null {
  if (rawUrl === undefined) return null;
  const value = rawUrl.trim();
  if (/^\*\|[^|]+\|\*$/.test(value) || /^mailto:/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    warn(context.report, "unsafe-url-removed", "A non-web URL was omitted.");
    return null;
  }
  if (context.baseUrl === null && !/^https?:\/\//i.test(value)) {
    warn(context.report, "relative-url-removed", "A relative URL was omitted because no source URL was supplied.");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, context.baseUrl ?? undefined);
  } catch {
    warn(context.report, "unsafe-url-removed", "A malformed URL was omitted.");
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warn(context.report, "unsafe-url-removed", `A ${parsed.protocol} URL was omitted.`);
    return null;
  }
  return parsed.toString();
}

function safeDimension(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(?:\.\d+)?(?:px)?$/i.test(value.trim())) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1600 ? parsed : undefined;
}

function textContent(nodes: ChildNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.data;
      if (node.type === "tag" && node.name.toLowerCase() === "br") return "\n";
      return node.type === "tag" ? textContent(node.children) : "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function addTextMark(marks: Array<Record<string, unknown>>, mark: Record<string, unknown>): Array<Record<string, unknown>> {
  return marks.some((existing) => JSON.stringify(existing) === JSON.stringify(mark)) ? marks : [...marks, mark];
}

function addTextStyleMark(marks: Array<Record<string, unknown>>, attrs: Record<string, string>): Array<Record<string, unknown>> {
  if (Object.keys(attrs).length === 0) return marks;
  const existingIndex = marks.findIndex((mark) => mark.type === "textStyle");
  if (existingIndex === -1) return [...marks, { type: "textStyle", attrs }];
  const nextMarks = [...marks];
  nextMarks[existingIndex] = {
    type: "textStyle",
    attrs: { ...(nextMarks[existingIndex].attrs as Record<string, string> | undefined), ...attrs },
  };
  return nextMarks;
}

function typographyMarks(styles: StyleMap): Record<string, string> {
  return {
    ...(styles.color === undefined ? {} : { color: styles.color }),
    ...(styles["font-family"] === undefined ? {} : { fontFamily: styles["font-family"] }),
    ...(styles["font-size"] === undefined ? {} : { fontSize: styles["font-size"] }),
  };
}

function inlineNodes(nodes: ChildNode[], context: ConversionContext, inheritedMarks: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const value = node.data.replace(/\s+/g, " ");
      if (value.trim().length > 0) output.push({ type: "text", text: value, ...(inheritedMarks.length > 0 ? { marks: inheritedMarks } : {}) });
      continue;
    }
    const name = elementName(node);
    if (node.type !== "tag" || name === null) continue;
    if (name === "br") {
      output.push({ type: "hardBreak" });
      continue;
    }
    if (ACTIVE_TAGS.has(name)) {
      warn(context.report, "active-content-removed", `<${name}> was removed from the import.`);
      continue;
    }
    let marks = inheritedMarks;
    if (name === "strong" || name === "b") marks = addTextMark(marks, { type: "bold" });
    if (name === "em" || name === "i") marks = addTextMark(marks, { type: "italic" });
    if (name === "u") marks = addTextMark(marks, { type: "underline" });
    if (name === "s") marks = addTextMark(marks, { type: "strike" });
    marks = addTextStyleMark(marks, typographyMarks(context.computedStyles.get(node) ?? {}));
    if (/^(?:bold|bolder|[6-9]00)$/i.test(context.computedStyles.get(node)?.["font-weight"] ?? "")) {
      marks = addTextMark(marks, { type: "bold" });
    }
    if (name === "a") {
      const href = safeUrl(node.attribs.href, context);
      if (href !== null) marks = addTextMark(marks, { type: "link", attrs: { href } });
    }
    if (name === "span") {
      marks = addTextStyleMark(marks, typographyMarks(readComputedStyles(node, context, SAFE_TEXT_STYLE_PROPERTIES)));
    }
    output.push(...inlineNodes(node.children, context, marks));
  }
  return output;
}

function textBlockFromElement(element: Element, context: ConversionContext, level?: 1 | 2 | 3): string | null {
  let inheritedMarks: Array<Record<string, unknown>> = [];
  inheritedMarks = addTextStyleMark(inheritedMarks, typographyMarks(readComputedStyles(element, context, SAFE_TEXT_STYLE_PROPERTIES)));
  if (/^(?:bold|bolder|[6-9]00)$/i.test(readComputedStyles(element, context, SAFE_CSS_PROPERTIES)["font-weight"] ?? "")) {
    inheritedMarks = addTextMark(inheritedMarks, { type: "bold" });
  }
  const content = inlineNodes(element.children, context, inheritedMarks);
  if (content.length === 0) return null;
  const styles = readComputedStyles(element, context, SAFE_CSS_PROPERTIES);
  const paragraph = level === undefined
    ? { type: "paragraph", content }
    : { type: "heading", attrs: { level }, content };
  const blockId = context.ids.next("text");
  context.document[blockId] = {
    id: blockId,
    type: "text",
    parentId: "pending",
    childrenIds: [],
    properties: {
      text: { type: "doc", content: [paragraph] },
      ...(styles["text-align"] === "left" || styles["text-align"] === "center" || styles["text-align"] === "right"
        ? { textAlign: styles["text-align"] }
        : {}),
      ...(styles.color !== undefined ? { textColor: styles.color } : {}),
      ...(readBackgroundColor(element, context) === undefined ? {} : { backgroundColor: readBackgroundColor(element, context) }),
      ...readBlockSpacing(element, context),
    },
  } as never;
  return blockId;
}

function hasStructuralDescendant(element: Element): boolean {
  return element.children.some((child) => {
    if (child.type !== "tag") return false;
    const name = child.name.toLowerCase();
    return name === "table" || name === "img" || name === "hr" || hasStructuralDescendant(child);
  });
}

function shouldConvertCellAsRichText(element: Element): boolean {
  const hasDirectText = element.children.some(
    (child) => child.type === "text" && child.data.trim().length > 0,
  );
  if (!hasDirectText) {
    return false;
  }
  return !element.children.some(
    (child) =>
      child.type === "tag" &&
      /^(?:div|h[1-6]|hr|img|ol|p|table|ul)$/i.test(child.name),
  );
}

function imageDescendants(element: Element): Element[] {
  return element.children.flatMap((child) => {
    if (child.type !== "tag") return [];
    return child.name.toLowerCase() === "img" ? [child] : imageDescendants(child);
  });
}

function appendChild(parentId: string, childId: string, context: ConversionContext): void {
  const parent = context.document[parentId] as { childrenIds: string[] } | undefined;
  if (parent === undefined) return;
  parent.childrenIds.push(childId);
  const child = context.document[childId] as { parentId: string } | undefined;
  if (child !== undefined) child.parentId = parentId;
}

function addLeaf(element: Element, parentId: string, context: ConversionContext): string | null {
  const name = element.name.toLowerCase();
  if (name === "img") {
    const width = safeDimension(element.attribs.width) ?? safeDimension(readStyles(element).width);
    const height = safeDimension(element.attribs.height);
    if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2)) {
      warn(context.report, "tracking-pixel-removed", "A one- or two-pixel image was treated as a tracking pixel and removed.");
      return null;
    }
    const src = safeUrl(element.attribs.src, context);
    if (src === null) return null;
    const imageId = context.ids.next("image");
    context.document[imageId] = {
      id: imageId,
      type: "image",
      parentId,
      childrenIds: [],
      properties: {
        src,
        alt: element.attribs.alt ?? "",
        ...(width === undefined ? {} : { width }),
      },
    } as never;
    return imageId;
  }
  if (name === "hr") {
    const dividerId = context.ids.next("divider");
    context.document[dividerId] = { id: dividerId, type: "divider", parentId, childrenIds: [], properties: {} } as never;
    return dividerId;
  }
  if (name === "a") {
    const linkedImages = imageDescendants(element);
    if (linkedImages.length === 1 && textContent(element.children).length === 0) {
      const linkedImage = linkedImages[0];
      const width = safeDimension(linkedImage.attribs.width) ?? safeDimension(readStyles(linkedImage).width);
      const height = safeDimension(linkedImage.attribs.height);
      if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2)) {
        warn(context.report, "tracking-pixel-removed", "A one- or two-pixel image was treated as a tracking pixel and removed.");
        return null;
      }
      const src = safeUrl(linkedImage.attribs.src, context);
      if (src === null) return null;
      const href = safeUrl(element.attribs.href, context);
      const imageId = context.ids.next("image");
      context.document[imageId] = {
        id: imageId,
        type: "image",
        parentId,
        childrenIds: [],
        properties: {
          src,
          alt: linkedImage.attribs.alt ?? "",
          ...(width === undefined ? {} : { width }),
          ...(href === null ? {} : { href }),
        },
      } as never;
      return imageId;
    }
    const href = safeUrl(element.attribs.href, context);
    const label = textContent(element.children);
    if (href === null || label.length === 0) return null;
    const styles = readComputedStyles(element, context, SAFE_CSS_PROPERTIES);
    const isButton = styles["background-color"] !== undefined || /\b(button|cta|primary)\b/i.test(element.attribs.class ?? "");
    const blockId = context.ids.next(isButton ? "button" : "link");
    context.document[blockId] = isButton
      ? {
          id: blockId,
          type: "button",
          parentId,
          childrenIds: [],
          properties: {
            label,
            href,
            ...(styles["background-color"] === undefined ? {} : { backgroundColor: styles["background-color"] }),
            ...(styles.color === undefined ? {} : { textColor: styles.color }),
            ...(styles["font-family"] === undefined ? {} : { fontFamily: styles["font-family"] }),
            ...readButtonPadding(element, context),
          },
        }
      : {
          id: blockId,
          type: "link",
          parentId,
          childrenIds: [],
          properties: {
            text: label,
            href,
            ...(styles.color === undefined ? {} : { textColor: styles.color }),
            ...(styles["font-family"] === undefined ? {} : { fontFamily: styles["font-family"] }),
            ...(styles["font-size"] === undefined ? {} : { fontSize: Number.parseFloat(styles["font-size"]) }),
            ...(styles["text-align"] === "left" ||
            styles["text-align"] === "center" ||
            styles["text-align"] === "right"
              ? { align: styles["text-align"] }
              : {}),
            ...readBlockSpacing(element, context),
          },
        };
    return blockId;
  }
  const headingMatch = /^h([1-6])$/.exec(name);
  if (headingMatch !== null) {
    return textBlockFromElement(element, context, Math.min(3, Number(headingMatch[1])) as 1 | 2 | 3);
  }
  if (["p", "li", "div", "span", "td", "th"].includes(name)) {
    if (hasStructuralDescendant(element)) return null;
    return textBlockFromElement(element, context);
  }
  if (UNSUPPORTED_LAYOUT_TAGS.has(name)) {
    context.report.unsupportedFeatures.add(name);
    warn(context.report, "unsupported-feature", `<${name}> was flattened into supported content.`);
    return null;
  }
  return null;
}

function convertSimpleChildren(
  nodes: ChildNode[],
  parentId: string,
  context: ConversionContext,
  shouldFlattenNestedTables = false,
): void {
  for (const node of nodes) {
    if (node.type !== "tag") continue;
    const name = node.name.toLowerCase();
    if (ACTIVE_TAGS.has(name)) {
      context.report.unsupportedFeatures.add(name);
      warn(context.report, "active-content-removed", `<${name}> was removed from the import.`);
      continue;
    }
    if (name === "table") {
      if (shouldFlattenNestedTables) {
        convertSimpleChildren(node.children, parentId, context, true);
        continue;
      }
      const nestedSectionId = convertTable(node, context);
      if (nestedSectionId !== null) {
        (context.document.root as { childrenIds: string[] }).childrenIds.push(nestedSectionId);
      }
      continue;
    }
    const blockId = addLeaf(node, parentId, context);
    if (blockId !== null) {
      appendChild(parentId, blockId, context);
      continue;
    }
    if (!["img", "hr"].includes(name)) {
      convertSimpleChildren(node.children, parentId, context, shouldFlattenNestedTables);
    }
  }
}

function deleteBlockSubtree(blockId: string, context: ConversionContext): void {
  const block = context.document[blockId] as { childrenIds?: string[] } | undefined;
  for (const childId of block?.childrenIds ?? []) {
    deleteBlockSubtree(childId, context);
  }
  delete context.document[blockId];
}

function hasLeafDescendant(blockId: string, context: ConversionContext): boolean {
  const block = context.document[blockId] as { type?: string; childrenIds?: string[] } | undefined;
  if (block === undefined) return false;
  if (!["section", "row", "column"].includes(block.type ?? "")) return true;
  return (block.childrenIds ?? []).some((childId) => hasLeafDescendant(childId, context));
}

function backgroundPropertiesInSubtree(
  blockId: string,
  context: ConversionContext,
): Record<string, unknown> | null {
  const block = context.document[blockId] as {
    properties?: Record<string, unknown>;
    childrenIds?: string[];
  } | undefined;
  if (block === undefined) return null;
  const properties = block.properties ?? {};
  if (typeof properties.backgroundImageUrl === "string") {
    return {
      backgroundImageUrl: properties.backgroundImageUrl,
      ...(properties.backgroundSize === undefined ? {} : { backgroundSize: properties.backgroundSize }),
      ...(properties.backgroundPosition === undefined ? {} : { backgroundPosition: properties.backgroundPosition }),
      ...(properties.backgroundRepeat === undefined ? {} : { backgroundRepeat: properties.backgroundRepeat }),
      ...(properties.backgroundColor === undefined
        ? properties.innerBackgroundColor === undefined
          ? {}
          : { innerBackgroundColor: properties.innerBackgroundColor }
        : { innerBackgroundColor: properties.backgroundColor }),
    };
  }
  for (const childId of block.childrenIds ?? []) {
    const nested = backgroundPropertiesInSubtree(childId, context);
    if (nested !== null) return nested;
  }
  return null;
}

function convertTable(element: Element, context: ConversionContext): string | null {
  const root = context.document.root as { childrenIds: string[] };
  const nestedSectionStart = root.childrenIds.length;
  const sectionId = context.ids.next("section");
  const sectionBackgroundColor = readBackgroundColor(element, context);
  context.document[sectionId] = {
    id: sectionId,
    type: "section",
    parentId: "root",
    childrenIds: [],
    properties: {
      ...readBackgroundProperties(element, context),
      ...readBlockSpacing(element, context),
      ...(sectionBackgroundColor === undefined ? {} : { innerBackgroundColor: sectionBackgroundColor }),
    },
  } as never;
  const rows = element.children.filter((child): child is Element => child.type === "tag" && child.name.toLowerCase() === "tr");
  const nestedRows = rows.length > 0 ? rows : element.children.flatMap((child) => child.type === "tag" ? child.children.filter((nested): nested is Element => nested.type === "tag" && nested.name.toLowerCase() === "tr") : []);
  for (const rowElement of nestedRows) {
    const rowId = context.ids.next("row");
    const rowBackgroundColor = readBackgroundColor(rowElement, context);
    context.document[rowId] = {
      id: rowId,
      type: "row",
      parentId: sectionId,
      childrenIds: [],
      properties: {
        ...readBackgroundProperties(rowElement, context),
        ...readBlockSpacing(rowElement, context),
        ...(rowBackgroundColor === undefined ? {} : { backgroundColor: rowBackgroundColor }),
      },
    } as never;
    appendChild(sectionId, rowId, context);
    const cells = rowElement.children.filter((child): child is Element => child.type === "tag" && ["td", "th"].includes(child.name.toLowerCase()));
    for (const cell of cells) {
      const columnId = context.ids.next("column");
      const columnBackgroundColor = readBackgroundColor(cell, context);
      const columnBackgroundProperties = readBackgroundProperties(cell, context);
      context.document[columnId] = {
        id: columnId,
        type: "column",
        parentId: rowId,
        childrenIds: [],
        properties: {
          widthPercent: 100 / Math.max(cells.length, 1),
          ...columnBackgroundProperties,
          ...readBlockSpacing(cell, context),
          ...(columnBackgroundColor === undefined ? {} : { backgroundColor: columnBackgroundColor }),
        },
      } as never;
      appendChild(rowId, columnId, context);
      if (shouldConvertCellAsRichText(cell)) {
        const textBlockId = textBlockFromElement(cell, context);
        if (textBlockId !== null) {
          appendChild(columnId, textBlockId, context);
          continue;
        }
      }
      convertSimpleChildren(
        cell.children,
        columnId,
        context,
        typeof columnBackgroundProperties.backgroundImageUrl === "string",
      );
    }
  }
  if (!hasLeafDescendant(sectionId, context)) {
    const backgroundProperties = backgroundPropertiesInSubtree(sectionId, context);
    const firstNestedSectionId = root.childrenIds[nestedSectionStart];
    if (backgroundProperties !== null && firstNestedSectionId !== undefined) {
      const nestedSection = context.document[firstNestedSectionId] as {
        properties: Record<string, unknown>;
      } | undefined;
      if (nestedSection !== undefined && nestedSection.properties.backgroundImageUrl === undefined) {
        nestedSection.properties = { ...nestedSection.properties, ...backgroundProperties };
      }
    }
    deleteBlockSubtree(sectionId, context);
    return null;
  }
  return sectionId;
}

function serializeNode(node: ChildNode, context: ConversionContext): string {
  if (node.type === "text") return escapeHtml(node.data);
  if (node.type === "script" || node.type === "style") {
    context.report.unsupportedFeatures.add(node.type);
    warn(context.report, "active-content-removed", `<${node.type}> was removed from the import.`);
    return "";
  }
  if (node.type !== "tag") return "";
  const name = node.name.toLowerCase();
  if (ACTIVE_TAGS.has(name)) {
    context.report.unsupportedFeatures.add(name);
    return "";
  }
  const children = node.children.map((child) => serializeNode(child, context)).join("");
  if (!SAFE_SOURCE_TAGS.has(name)) return children;
  const attributes: string[] = [];
  if (name === "a") {
    const href = safeUrl(node.attribs.href, context);
    if (href !== null) attributes.push(`href="${escapeAttribute(href)}"`);
  }
  if (name === "img") {
    const width = safeDimension(node.attribs.width);
    const height = safeDimension(node.attribs.height);
    if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2)) return "";
    const src = safeUrl(node.attribs.src, context);
    if (src === null) return "";
    attributes.push(`src="${escapeAttribute(src)}"`);
    attributes.push(`alt="${escapeAttribute(node.attribs.alt ?? "")}"`);
  }
  if (node.attribs.style !== undefined) {
    const styleParts = sanitizeStyle(node.attribs.style, SAFE_STYLE_PROPERTIES)
      .split(";")
      .filter(Boolean);
    const declarations = styleDeclarations(node.attribs.style);
    const backgroundImageUrl = safeBackgroundUrl(
      declarations["background-image"] ?? declarations.background,
      context,
      declarations["background-image"] !== undefined || declarations.background !== undefined,
    );
    if (backgroundImageUrl !== null) styleParts.push(`background-image:url(${backgroundImageUrl})`);
    const backgroundSize = safeBackgroundSize(declarations["background-size"]);
    const backgroundPosition = safeBackgroundPosition(declarations["background-position"]);
    const backgroundRepeat = safeBackgroundRepeat(declarations["background-repeat"]);
    if (backgroundSize !== undefined) styleParts.push(`background-size:${backgroundSize}`);
    if (backgroundPosition !== undefined) styleParts.push(`background-position:${backgroundPosition}`);
    if (backgroundRepeat !== undefined) styleParts.push(`background-repeat:${backgroundRepeat}`);
    if (styleParts.length > 0) attributes.push(`style="${escapeAttribute(styleParts.join(";"))}"`);
  }
  if (node.attribs.background !== undefined) {
    const backgroundImageUrl = safeBackgroundUrl(node.attribs.background, context);
    if (backgroundImageUrl !== null) attributes.push(`background="${escapeAttribute(backgroundImageUrl)}"`);
  }
  if (node.attribs.width !== undefined && safeDimension(node.attribs.width) !== undefined) attributes.push(`width="${safeDimension(node.attribs.width)}"`);
  if (name === "br" || name === "hr" || name === "img") return `<${name}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`;
  return `<${name}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>${children}</${name}>`;
}

function sourceBody(documentNodes: ChildNode[]): Element | null {
  for (const node of documentNodes) {
    if (node.type !== "tag") continue;
    if (node.name.toLowerCase() === "body") return node;
    const nestedBody = sourceBody(node.children);
    if (nestedBody !== null) return nestedBody;
  }
  return null;
}

function recordActiveNodes(nodes: ChildNode[], report: MutableReport): void {
  for (const node of nodes) {
    const name = elementName(node);
    if (name !== null && ACTIVE_TAGS.has(name)) {
      report.unsupportedFeatures.add(name);
      warn(report, "active-content-removed", `<${name}> was removed from the import.`);
    }
    if (node.type === "tag" || node.type === "script" || node.type === "style") recordActiveNodes(node.children, report);
  }
}

export function importHtmlEmail({ html, baseUrl }: { html: string; baseUrl?: string }): HtmlEmailImportResult {
  const byteLength = new TextEncoder().encode(html).byteLength;
  if (byteLength > MAX_HTML_IMPORT_BYTES) throw new HtmlEmailImportError("too-large", "That HTML file is larger than 512 KB.");
  if (html.trim().length === 0) throw new HtmlEmailImportError("empty", "Paste an HTML email before importing it.");
  const report: MutableReport = { warnings: [], unsupportedFeatures: new Set() };
  const parsed = parseDocument(html, { decodeEntities: true }) as unknown as { children: ParsedNode[] };
  recordActiveNodes(parsed.children, report);
  const stylesheetRules = parseStylesheetRules(parsed.children, report);
  const context: ConversionContext = {
    document: { root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: { globals: {} } } },
    ids: createIdFactory(),
    report,
    baseUrl: baseUrl ?? null,
    computedStyles: buildComputedStyles(parsed.children, stylesheetRules, report),
  };
  const body = sourceBody(parsed.children);
  const nodes = body?.children ?? parsed.children;
  const sourceNodes = parsed.children;
  for (const node of nodes) {
    if (node.type !== "tag") continue;
    const name = node.name.toLowerCase();
    if (ACTIVE_TAGS.has(name)) {
      report.unsupportedFeatures.add(name);
      warn(report, "active-content-removed", `<${name}> was removed from the import.`);
      continue;
    }
    if (name === "table") {
      const sectionId = convertTable(node, context);
      if (sectionId !== null) {
        (context.document.root as { childrenIds: string[] }).childrenIds.push(sectionId);
      }
      continue;
    }
    const sectionId = context.ids.next("section");
    const sectionBackgroundColor = readBackgroundColor(node, context);
    context.document[sectionId] = {
      id: sectionId,
      type: "section",
      parentId: "root",
      childrenIds: [],
    properties: {
      ...readBackgroundProperties(node, context),
      ...readBlockSpacing(node, context),
        ...(node.attribs.background === undefined
          ? {}
          : (() => {
              const backgroundImageUrl = safeBackgroundUrl(node.attribs.background, context);
              return backgroundImageUrl === null ? {} : { backgroundImageUrl };
            })()),
        ...(sectionBackgroundColor === undefined ? {} : { innerBackgroundColor: sectionBackgroundColor }),
      },
    } as never;
    convertSimpleChildren([node], sectionId, context);
    if ((context.document[sectionId] as { childrenIds: string[] }).childrenIds.length > 0) {
      (context.document.root as { childrenIds: string[] }).childrenIds.push(sectionId);
    }
    else delete context.document[sectionId];
  }
  for (const node of parsed.children) {
    const name = elementName(node);
    if (name !== null && !SAFE_SOURCE_TAGS.has(name) && !ACTIVE_TAGS.has(name)) {
      report.unsupportedFeatures.add(name);
      warn(report, "unsupported-feature", `<${name}> was omitted from the sanitized source.`);
    }
  }
  const parsedDocument = emailDocumentSchema.safeParse(context.document);
  if (!parsedDocument.success || !checkDocumentIntegrity(context.document).isValid) {
    throw new HtmlEmailImportError("invalid-document", "The HTML could not be converted into a valid editable email.");
  }
  const sanitizedHtml = sourceNodes.map((node) => serializeNode(node, context)).join("");
  return {
    document: context.document,
    sanitizedHtml,
    report: {
      importerVersion: "1",
      warnings: report.warnings,
      unsupportedFeatures: [...report.unsupportedFeatures],
      blockCount: Object.keys(context.document).length,
    },
  };
}

/*
  Public preview API name. Keep importHtmlEmail as the compatibility name for
  the Phase 1 parser callers while the product surface describes this step as
  parsing an HTML email import.
*/
export function parseHtmlEmailImport({ html, baseUrl }: { html: string; baseUrl?: string }): HtmlEmailImportResult {
  return importHtmlEmail({ html, baseUrl });
}

/* eslint-enable max-params */
