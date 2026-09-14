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
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
]);

const SAFE_TEXT_STYLE_PROPERTIES = new Set(["color", "font-family", "font-size"]);

type BlockType = "section" | "row" | "column" | "text" | "button" | "image" | "divider" | "link";

export type HtmlImportWarningCode =
  | "active-content-removed"
  | "unsupported-feature"
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

interface IdFactory {
  next(type: BlockType): string;
}

interface ConversionContext {
  document: EmailDocument;
  ids: IdFactory;
  report: MutableReport;
  baseUrl: string | null;
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
    if (name === "a") {
      const href = safeUrl(node.attribs.href, context);
      if (href !== null) marks = addTextMark(marks, { type: "link", attrs: { href } });
    }
    if (name === "span") {
      const styles = readStyles(node, SAFE_TEXT_STYLE_PROPERTIES);
      const attrs = {
        ...(styles.color !== undefined ? { color: styles.color } : {}),
        ...(styles["font-family"] !== undefined ? { fontFamily: styles["font-family"] } : {}),
        ...(styles["font-size"] !== undefined ? { fontSize: styles["font-size"] } : {}),
      };
      if (Object.keys(attrs).length > 0) marks = addTextMark(marks, { type: "textStyle", attrs });
    }
    output.push(...inlineNodes(node.children, context, marks));
  }
  return output;
}

function textBlockFromElement(element: Element, context: ConversionContext, level?: 1 | 2 | 3): string | null {
  const content = inlineNodes(element.children, context);
  if (content.length === 0) return null;
  const styles = readStyles(element);
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
      ...(styles["background-color"] !== undefined ? { backgroundColor: styles["background-color"] } : {}),
    },
  } as never;
  return blockId;
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
      properties: { src, alt: element.attribs.alt ?? "", ...(width === undefined ? {} : { width }) },
    } as never;
    return imageId;
  }
  if (name === "hr") {
    const dividerId = context.ids.next("divider");
    context.document[dividerId] = { id: dividerId, type: "divider", parentId, childrenIds: [], properties: {} } as never;
    return dividerId;
  }
  if (name === "a") {
    const href = safeUrl(element.attribs.href, context);
    const label = textContent(element.children);
    if (href === null || label.length === 0) return null;
    const styles = readStyles(element);
    const isButton = styles["background-color"] !== undefined || /\b(button|cta|primary)\b/i.test(element.attribs.class ?? "");
    const blockId = context.ids.next(isButton ? "button" : "link");
    context.document[blockId] = isButton
      ? { id: blockId, type: "button", parentId, childrenIds: [], properties: { label, href, ...(styles["background-color"] === undefined ? {} : { backgroundColor: styles["background-color"] }) } }
      : { id: blockId, type: "link", parentId, childrenIds: [], properties: { text: label, href } };
    return blockId;
  }
  const headingMatch = /^h([1-6])$/.exec(name);
  if (headingMatch !== null) {
    return textBlockFromElement(element, context, Math.min(3, Number(headingMatch[1])) as 1 | 2 | 3);
  }
  if (["p", "li", "div", "span", "td", "th"].includes(name)) return textBlockFromElement(element, context);
  if (UNSUPPORTED_LAYOUT_TAGS.has(name)) {
    context.report.unsupportedFeatures.add(name);
    warn(context.report, "unsupported-feature", `<${name}> was flattened into supported content.`);
    return null;
  }
  return null;
}

function convertSimpleChildren(nodes: ChildNode[], parentId: string, context: ConversionContext): void {
  for (const node of nodes) {
    if (node.type !== "tag") continue;
    const name = node.name.toLowerCase();
    if (ACTIVE_TAGS.has(name)) {
      context.report.unsupportedFeatures.add(name);
      warn(context.report, "active-content-removed", `<${name}> was removed from the import.`);
      continue;
    }
    const blockId = addLeaf(node, parentId, context);
    if (blockId !== null) {
      appendChild(parentId, blockId, context);
      continue;
    }
    if (!["img", "hr", "a", "p", "li", "div", "span", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"].includes(name)) {
      convertSimpleChildren(node.children, parentId, context);
    }
  }
}

function convertTable(element: Element, context: ConversionContext): string {
  const sectionId = context.ids.next("section");
  context.document[sectionId] = { id: sectionId, type: "section", parentId: "root", childrenIds: [], properties: {} } as never;
  const rows = element.children.filter((child): child is Element => child.type === "tag" && child.name.toLowerCase() === "tr");
  const nestedRows = rows.length > 0 ? rows : element.children.flatMap((child) => child.type === "tag" ? child.children.filter((nested): nested is Element => nested.type === "tag" && nested.name.toLowerCase() === "tr") : []);
  for (const rowElement of nestedRows) {
    const rowId = context.ids.next("row");
    context.document[rowId] = { id: rowId, type: "row", parentId: sectionId, childrenIds: [], properties: {} } as never;
    appendChild(sectionId, rowId, context);
    const cells = rowElement.children.filter((child): child is Element => child.type === "tag" && ["td", "th"].includes(child.name.toLowerCase()));
    for (const cell of cells) {
      const columnId = context.ids.next("column");
      context.document[columnId] = { id: columnId, type: "column", parentId: rowId, childrenIds: [], properties: { widthPercent: 100 / Math.max(cells.length, 1) } } as never;
      appendChild(rowId, columnId, context);
      convertSimpleChildren(cell.children, columnId, context);
    }
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
    const style = sanitizeStyle(node.attribs.style, SAFE_STYLE_PROPERTIES);
    if (style.length > 0) attributes.push(`style="${escapeAttribute(style)}"`);
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
  const context: ConversionContext = { document: { root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: { globals: {} } } }, ids: createIdFactory(), report, baseUrl: baseUrl ?? null };
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
      (context.document.root as { childrenIds: string[] }).childrenIds.push(sectionId);
      continue;
    }
    const sectionId = context.ids.next("section");
    context.document[sectionId] = { id: sectionId, type: "section", parentId: "root", childrenIds: [], properties: {} } as never;
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

/* eslint-enable max-params */
