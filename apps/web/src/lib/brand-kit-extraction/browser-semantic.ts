/*
  Bounded semantic copy from Chromium's accessibility tree. This is an optional
  enhancement: extraction failures return an unusable empty result.
*/

export interface BrowserSemanticEvidence {
  headings?: Array<{ level: number | null; text: string }>;
  lists?: string[][];
  headline: string | null;
  firstParagraph: string | null;
  ctaLabels: string[];
  landmarks: string[];
  text: string[];
  controlLabels: string[];
  imageDescriptions: string[];
  isUsable: boolean;
}

interface AccessibilityValue {
  value?: string | number | boolean;
}

export interface BrowserSemanticAXNode {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  value?: AccessibilityValue;
  childIds?: string[];
  properties?: Array<{ name?: string; value?: AccessibilityValue }>;
  ignoredReasons?: Array<{ name?: string }>;
}

interface AccessibilityTreeResult {
  nodes?: BrowserSemanticAXNode[];
}

export interface BrowserSemanticSession {
  send(method: "Page.getFrameTree"): Promise<{ frameTree?: { frame?: { id?: string } } }>;
  send(method: "Accessibility.getFullAXTree", params: { frameId: string }): Promise<AccessibilityTreeResult>;
  detach(): Promise<void>;
}

export interface BrowserSemanticPage {
  createCDPSession(): Promise<BrowserSemanticSession>;
}

const MAX_TREE_NODES = 2_000;
const MAX_TEXT_ITEMS = 30;
const MAX_HEADINGS = 12;
const MAX_LISTS = 8;
const MAX_LIST_ITEMS = 8;
const MAX_TEXT_CHARS = 400;
const MAX_SHORT_LABEL_CHARS = 100;
const MIN_USABLE_CHARS = 24;
const GENERIC_NAMES = new Set(["button", "link", "image", "graphic", "text", "group"]);
const BLOCKING_IGNORED_ANCESTOR_REASONS = new Set([
  "ariaHiddenSubtree",
  "inertElement",
  "notRendered",
  "notVisible",
  "invisible",
]);

function readNodeValue(value: AccessibilityValue | undefined): string {
  return typeof value?.value === "string" ? value.value.replace(/\s+/g, " ").trim() : "";
}

function addUnique({ target, value, maxChars }: { target: string[]; value: string; maxChars: number }): void {
  const text = value.trim().slice(0, maxChars);
  if (text.length > 0 && !target.some((item) => item.toLowerCase() === text.toLowerCase())) {
    target.push(text);
  }
}

function createEmptyEvidence(): BrowserSemanticEvidence {
  return {
    headline: null,
    headings: [],
    lists: [],
    firstParagraph: null,
    ctaLabels: [],
    landmarks: [],
    text: [],
    controlLabels: [],
    imageDescriptions: [],
    isUsable: false,
  };
}

function collectTreeEvidence(nodes: BrowserSemanticAXNode[]): BrowserSemanticEvidence {
  const evidence = createEmptyEvidence();
  const boundedNodes = nodes.slice(0, MAX_TREE_NODES);
  const nodeById = new Map(boundedNodes.map((node) => [node.nodeId, node]));
  const seenText = new Set<string>();
  let meaningfulContentChars = 0;
  let headlinePriority = 0;
  const hasMainLandmark = boundedNodes.some((node) => readNodeValue(node.role).toLowerCase() === "main");
  const hasIgnoredAncestor = (node: BrowserSemanticAXNode): boolean => {
    let ancestorId = node.parentId;
    const seen = new Set<string>();
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      const ancestor = nodeById.get(ancestorId);
      if (!ancestor || isBlockingIgnoredAncestor(ancestor)) {
        return true;
      }
      ancestorId = ancestor.parentId;
    }
    return false;
  };
  const isWithinMain = (node: BrowserSemanticAXNode): boolean => {
    let ancestorId = node.parentId;
    const seen = new Set<string>();
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      const ancestor = nodeById.get(ancestorId);
      if (!ancestor || isBlockingIgnoredAncestor(ancestor)) {
        return false;
      }
      if (readNodeValue(ancestor.role).toLowerCase() === "main") {
        return true;
      }
      ancestorId = ancestor.parentId;
    }
    return false;
  };
  const isBlockingIgnoredAncestor = (node: BrowserSemanticAXNode): boolean =>
    node.ignored === true &&
    (node.ignoredReasons ?? []).some((reason) => BLOCKING_IGNORED_ANCESTOR_REASONS.has(reason.name ?? ""));
  const getChildText = (node: BrowserSemanticAXNode): string =>
    (node.childIds ?? [])
      .map((childId) => nodeById.get(childId))
      .filter((child): child is BrowserSemanticAXNode => Boolean(child) && !child?.ignored)
      .map((child) => readNodeValue(child.name))
      .filter(Boolean)
      .join(" ");
  const readHeadingLevel = (node: BrowserSemanticAXNode): number | null => {
    const rawLevel = node.properties?.find((property) => property.name === "level")?.value?.value;
    return typeof rawLevel === "number" && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : null;
  };
  const listItemsByNode = new Map<string, string[]>();
  for (const node of boundedNodes) {
    if (readNodeValue(node.role).toLowerCase() === "list") {
      listItemsByNode.set(node.nodeId ?? "", []);
    }
  }

  for (const node of boundedNodes) {
    if (node.ignored || hasIgnoredAncestor(node)) {
      continue;
    }
    const role = readNodeValue(node.role).toLowerCase();
    const name = readNodeValue(node.name);
    const description = name || getChildText(node);
    const isGenericName = GENERIC_NAMES.has(description.toLowerCase());

    if (role === "heading" && description && (readHeadingLevel(node) === 1 || isWithinMain(node) || !hasMainLandmark)) {
      const text = description.slice(0, 160);
      const level = readHeadingLevel(node);
      if (evidence.headings!.length < MAX_HEADINGS && !evidence.headings!.some((heading) => heading.text.toLowerCase() === text.toLowerCase())) {
        evidence.headings!.push({ level, text });
        meaningfulContentChars += text.length;
      }
      const currentPriority = level === 1 ? 2 : isWithinMain(node) || !hasMainLandmark ? 1 : 0;
      if (currentPriority > headlinePriority) {
        evidence.headline = text;
        headlinePriority = currentPriority;
      }
    } else if (role === "paragraph" && description.length >= 40 && !evidence.firstParagraph && (isWithinMain(node) || !hasMainLandmark)) {
      evidence.firstParagraph = description.slice(0, MAX_TEXT_CHARS);
      meaningfulContentChars += evidence.firstParagraph.length;
    } else if (role === "listitem" && description) {
      let parentId = node.parentId;
      while (parentId && !listItemsByNode.has(parentId)) {
        parentId = nodeById.get(parentId)?.parentId;
      }
      if (parentId) {
        const items = listItemsByNode.get(parentId)!;
        if (items.length < MAX_LIST_ITEMS) {
          addUnique({ target: items, value: description, maxChars: MAX_TEXT_CHARS });
        }
      }
    } else if (["button", "link", "tab"].includes(role) && name && !isGenericName) {
      if (evidence.controlLabels.length < 20) {
        addUnique({ target: evidence.controlLabels, value: name, maxChars: MAX_SHORT_LABEL_CHARS });
      }
      if (evidence.ctaLabels.length < 8) {
        addUnique({ target: evidence.ctaLabels, value: name, maxChars: 40 });
      }
    } else if (["banner", "main", "navigation", "contentinfo", "complementary", "region"].includes(role)) {
      if (name) {
        if (evidence.landmarks.length < 12) {
          addUnique({ target: evidence.landmarks, value: name, maxChars: MAX_SHORT_LABEL_CHARS });
        }
      }
    } else if (["img", "image"].includes(role) && name && !isGenericName) {
      if (evidence.imageDescriptions.length < 20) {
        addUnique({ target: evidence.imageDescriptions, value: name, maxChars: MAX_SHORT_LABEL_CHARS });
      }
    } else if (role === "statictext" && name) {
      let parentId = node.parentId;
      let parentRole = "";
      while (parentId) {
        const parent = nodeById.get(parentId);
        parentRole = readNodeValue(parent?.role).toLowerCase();
        if (["paragraph", "heading", "link", "button", "tab", "listitem"].includes(parentRole)) {
          break;
        }
        parentId = parent?.parentId;
      }
      const isChildOfSemanticCopy = ["paragraph", "heading", "link", "button", "tab", "listitem"].includes(parentRole);
      const key = name.toLowerCase();
      if (!isChildOfSemanticCopy && !seenText.has(key) && evidence.text.length < MAX_TEXT_ITEMS) {
        seenText.add(key);
        addUnique({ target: evidence.text, value: name, maxChars: MAX_TEXT_CHARS });
      }
    }
  }

  evidence.lists = [...listItemsByNode.values()]
    .filter((items) => items.length > 0)
    .slice(0, MAX_LISTS);
  evidence.ctaLabels = evidence.ctaLabels.slice(0, 8);
  evidence.controlLabels = evidence.controlLabels.slice(0, 20);
  evidence.landmarks = evidence.landmarks.slice(0, 12);
  evidence.imageDescriptions = evidence.imageDescriptions.slice(0, 20);
  evidence.isUsable = meaningfulContentChars >= MIN_USABLE_CHARS && Boolean(
    evidence.headline || evidence.firstParagraph,
  );
  return evidence;
}

export function describeBrowserSemanticEvidence(evidence: BrowserSemanticEvidence): string | null {
  if (!evidence.isUsable) {
    return null;
  }
  const lines = [
    `Headings: ${(evidence.headings ?? []).map((heading) => `H${heading.level ?? "?"} ${heading.text}`).join(" | ") || "(none)"}`,
    `Paragraph: ${evidence.firstParagraph ?? "(none)"}`,
    `Lists: ${(evidence.lists ?? []).map((items) => items.join("; ")).join(" | ") || "(none)"}`,
    `Controls: ${evidence.controlLabels.slice(0, 20).join(" | ") || "(none)"}`,
    `Landmarks: ${evidence.landmarks.slice(0, 12).join(" | ") || "(none)"}`,
    `Images: ${evidence.imageDescriptions.slice(0, 20).join(" | ") || "(none)"}`,
    `Other text: ${evidence.text.slice(0, MAX_TEXT_ITEMS).join(" | ") || "(none)"}`,
  ];
  return lines.join("\n").slice(0, 8_000);
}

export async function collectBrowserSemanticEvidence(
  page: BrowserSemanticPage,
): Promise<BrowserSemanticEvidence> {
  let session: BrowserSemanticSession | undefined;
  try {
    session = await page.createCDPSession();
    const frameTree = await session.send("Page.getFrameTree");
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) {
      return createEmptyEvidence();
    }
    const result = await session.send("Accessibility.getFullAXTree", { frameId });
    return collectTreeEvidence(Array.isArray(result.nodes) ? result.nodes : []);
  } catch {
    return createEmptyEvidence();
  } finally {
    if (session) {
      try {
        await session.detach();
      } catch {
        /*
          A detach failure does not invalidate the copy already collected.
        */
      }
    }
  }
}
