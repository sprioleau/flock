/**
 * Display-side parsing of the persona markdown format: a frontmatter-ish
 * header (--- fenced key: value lines) + freeform behavior text. The Convex
 * row's typed fields are the RUNTIME source of truth (name, color, cooldown);
 * the frontmatter only feeds display strings the row doesn't carry — the
 * picker's one-line `description` — and the body preview. Deliberately not a
 * YAML parser: one failure-proof line scan (proposal §4.5 — frontmatter is
 * the interchange face, never parsed inside mutations).
 */

export interface ParsedPersonaMarkdown {
  /** One-liner for the picker (frontmatter `description:`), or null. */
  description: string | null;
  /** The freeform behavior text below the frontmatter fence. */
  body: string;
}

const FRONTMATTER_FENCE = "---";

export function parsePersonaMarkdown(personaMarkdown: string): ParsedPersonaMarkdown {
  const trimmed = personaMarkdown.trimStart();
  if (!trimmed.startsWith(FRONTMATTER_FENCE)) {
    return { description: null, body: personaMarkdown.trim() };
  }
  const closeIndex = trimmed.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
  if (closeIndex === -1) {
    return { description: null, body: personaMarkdown.trim() };
  }
  const frontmatter = trimmed.slice(FRONTMATTER_FENCE.length, closeIndex);
  const body = trimmed.slice(closeIndex + 1 + FRONTMATTER_FENCE.length).trim();

  let description: string | null = null;
  for (const line of frontmatter.split("\n")) {
    const match = /^description:\s*(.+)$/.exec(line.trim());
    if (match !== null) {
      description = match[1]!.trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { description, body };
}
