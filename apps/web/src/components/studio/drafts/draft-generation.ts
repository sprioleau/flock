import type { EmailDocument } from "@tandem/email-sdk";

/**
 * Prompt construction for the drafts menu's AI generation actions ("Ideate
 * with AI" / "Add design variation") — pure and unit-testable. The flow
 * itself lives in DraftSelector: create an EMPTY draft, activate it, then
 * submit one of these prompts through the chat panel's own send path
 * (composer-handoff SEND) so the user sees the request land in the thread and
 * the sections stream in — the same transparency contract as slash-summon,
 * and NO second pipeline.
 *
 * Both prompts deliberately contain the phrase "complete email": the live
 * model reads it as plain intent, and the deterministic mock model's
 * full-email compose script keys off it (mock-model.ts COMPOSE_EMAIL_REGEX),
 * so tests exercise the real per-section streaming pipeline.
 *
 * The SOURCE draft's outline rides inside the prompt text — the request body
 * only carries the NEW (blank) draft, so the prompt is the only channel the
 * source content can reach the model through. Block ids never appear here:
 * the outline describes content the way a user would.
 */

/** Longest text snippet quoted per block (prompts stay skimmable). */
const MAX_SNIPPET_LENGTH = 70;
/** Most content entries listed per section. */
const MAX_ENTRIES_PER_SECTION = 6;
/** Most sections listed per outline. */
const MAX_OUTLINE_SECTIONS = 12;

/** Depth-first plain text of a Tiptap-style rich-text node tree. */
function extractPlainText(node: unknown): string {
  if (typeof node !== "object" || node === null) {
    return "";
  }
  const candidate = node as { text?: unknown; content?: unknown };
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  if (Array.isArray(candidate.content)) {
    return candidate.content.map(extractPlainText).join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function truncateSnippet(text: string): string {
  return text.length <= MAX_SNIPPET_LENGTH ? text : `${text.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

/** One human-readable descriptor per content leaf ("" = nothing to say). */
function describeBlock(doc: EmailDocument, blockId: string): string {
  const block = doc[blockId];
  if (block === undefined) {
    return "";
  }
  const properties = block.properties as Record<string, unknown>;
  switch (block.type) {
    case "text": {
      const text = extractPlainText(properties.text);
      return text.length > 0 ? `text "${truncateSnippet(text)}"` : "";
    }
    case "button":
      return typeof properties.label === "string" ? `button "${properties.label}"` : "button";
    case "link":
      return typeof properties.text === "string" ? `link "${properties.text}"` : "link";
    case "image":
      return typeof properties.alt === "string" && properties.alt.length > 0
        ? `image (${truncateSnippet(properties.alt)})`
        : "image";
    case "code":
      return "code snippet";
    // Structural and purely visual blocks say nothing about the content.
    default:
      return "";
  }
}

/** Descriptors for a section's whole subtree, in reading order. */
function collectSectionEntries(doc: EmailDocument, sectionId: string): string[] {
  const entries: string[] = [];
  const walk = (blockId: string): void => {
    const descriptor = describeBlock(doc, blockId);
    if (descriptor.length > 0) {
      entries.push(descriptor);
    }
    for (const childId of doc[blockId]?.childrenIds ?? []) {
      walk(childId);
    }
  };
  for (const childId of doc[sectionId]?.childrenIds ?? []) {
    walk(childId);
  }
  return entries;
}

/**
 * A compact numbered content outline of `doc`, one line per top-level
 * section ("" when the document has no sections — a blank draft).
 */
export function buildDraftOutline(doc: EmailDocument): string {
  const sectionIds = doc.root?.childrenIds ?? [];
  const lines = sectionIds.slice(0, MAX_OUTLINE_SECTIONS).map((sectionId, index) => {
    const entries = collectSectionEntries(doc, sectionId);
    const overflowCount = entries.length - MAX_ENTRIES_PER_SECTION;
    const shownEntries =
      overflowCount > 0
        ? [...entries.slice(0, MAX_ENTRIES_PER_SECTION), `+${overflowCount} more`]
        : entries;
    const summary = shownEntries.length > 0 ? shownEntries.join("; ") : "(empty section)";
    return `${index + 1}. ${summary}`;
  });
  if (sectionIds.length > MAX_OUTLINE_SECTIONS) {
    lines.push(`…and ${sectionIds.length - MAX_OUTLINE_SECTIONS} more sections.`);
  }
  return lines.join("\n");
}

/**
 * "Ideate with AI": a fresh concept for this canvas. The source outline is
 * inspiration — subject matter and audience — not a layout to copy.
 */
export function buildIdeateDraftPrompt({
  sourceDraftName,
  sourceOutline,
}: {
  sourceDraftName: string;
  sourceOutline: string;
}): string {
  const contextBlock =
    sourceOutline.length > 0
      ? `For context, here is a content outline of "${sourceDraftName}", another draft on this canvas:\n\n${sourceOutline}\n\n`
      : "";
  return (
    `Design a complete email from scratch in this blank draft. ` +
    `${contextBlock}` +
    `Treat that as inspiration for the subject matter and audience — come up with a fresh concept and layout rather than copying it, ` +
    `and feel free to try a different theme or visual feel. Build the email section by section.`
  );
}

/**
 * "Add design variation": the same story as the source draft, redesigned.
 * The outline is the source material to preserve; the theme is free.
 */
export function buildDesignVariationPrompt({
  sourceDraftName,
  sourceOutline,
}: {
  sourceDraftName: string;
  sourceOutline: string;
}): string {
  const contextBlock =
    sourceOutline.length > 0
      ? `Here is the source draft's content outline:\n\n${sourceOutline}\n\n`
      : "";
  return (
    `Design a complete email in this blank draft as a new take on "${sourceDraftName}" — same content and intent, different design. ` +
    `${contextBlock}` +
    `Keep the message and calls to action, but rework the layout and feel free to try a different theme or visual feel. ` +
    `Build the email section by section.`
  );
}
