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

/**
 * Size cap on a persona's markdown (~8 KB). Mirrors the server-side cap in
 * convex/personas.ts (updatePersonaMarkdown) — the client checks first for a
 * friendly inline message; the mutation is the trust boundary.
 */
export const MAX_PERSONA_MARKDOWN_LENGTH = 8192;

/**
 * Pre-save validation for the in-app persona editor. Returns a friendly
 * error message, or null when the markdown is saveable. Deliberately the
 * same checks as the mutation: non-empty, size-capped, and — when the text
 * opens with a frontmatter fence — a closed fence with a non-empty behavior
 * body below it (the body is the persona's actual prompt layer).
 */
export function validatePersonaMarkdown(personaMarkdown: string): string | null {
  const trimmed = personaMarkdown.trim();
  if (trimmed.length === 0) {
    return "The persona definition cannot be empty.";
  }
  if (personaMarkdown.length > MAX_PERSONA_MARKDOWN_LENGTH) {
    return `This definition is too long (${personaMarkdown.length.toLocaleString()} characters — the limit is ${MAX_PERSONA_MARKDOWN_LENGTH.toLocaleString()}).`;
  }
  if (trimmed.startsWith(FRONTMATTER_FENCE)) {
    const closeIndex = trimmed.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
    if (closeIndex === -1) {
      // User-facing copy (persona editor): "settings header", never the
      // internal term "frontmatter".
      return "The settings header starts with --- but is never closed with a matching --- line.";
    }
    const body = trimmed.slice(closeIndex + 1 + FRONTMATTER_FENCE.length).trim();
    if (body.length === 0) {
      return "Add behavior text below the settings header — it's what shapes the persona.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Structured form view over the markdown (the in-app persona editor)
// ---------------------------------------------------------------------------
//
// The owner's editing model: users edit LABELED FORM FIELDS, never raw
// markdown — but markdown stays the storage/interchange format (marketplace
// portability, §4.5). So the form is a pure VIEW: parsePersonaMarkdownToForm
// maps markdown → fields, serializePersonaForm maps fields → markdown, and
// the pair is byte-lossless for the seeded built-ins (unit-tested), because
// persona markdown is a prompt-cache layer — an untouched form must not
// re-serialize to different bytes. Content the form can't map degrades
// gracefully: unknown frontmatter lines ride along verbatim (the "Advanced"
// field), and structurally unparseable markdown falls back to raw editing.

/** One labeled behavior section ("What you watch for:" + its lines). */
export interface PersonaBodySection {
  /** Heading text WITHOUT the trailing colon ("What you watch for"). */
  heading: string;
  /** The section's text below the heading (blank-edge trimmed). */
  content: string;
}

/** The form's model — a lossless structured view over one persona markdown. */
export interface PersonaFormModel {
  /** Frontmatter display name, or null when the markdown carries none. */
  name: string | null;
  /** Frontmatter accent color (quotes stripped), or null. */
  color: string | null;
  /** Frontmatter cooldown seconds, or null. */
  cooldownSeconds: number | null;
  /** Frontmatter one-line description, or null. */
  description: string | null;
  /** Behavior text before the first labeled section ("Behavior guidelines"). */
  intro: string;
  /** Labeled behavior sections, in document order. */
  sections: PersonaBodySection[];
  /** Frontmatter lines the form can't map — round-tripped verbatim. */
  unmappedFrontmatterLines: string[];
  /** Whether the source markdown had a frontmatter block at all. */
  hasFrontmatter: boolean;
  /** False ⇒ structurally unparseable; edit rawMarkdown directly instead. */
  isStructured: boolean;
  /** The original markdown (the fallback editing surface). */
  rawMarkdown: string;
}

/** Frontmatter keys the form maps to dedicated fields. */
const KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "color",
  "capabilities",
  "cooldownSeconds",
  "description",
]);

function stripEdgeQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/**
 * A body line opens a labeled section when it sits at column 0 (not a list
 * item or wrapped continuation — those are indented or dash-prefixed), ends
 * with a colon, and follows a blank line (or opens the body). This is the
 * built-ins' own convention ("What you watch for:", "How you respond:").
 */
function checkIsSectionHeading({ lines, index }: { lines: string[]; index: number }): boolean {
  const line = lines[index]!;
  if (!/^[^\s-].{0,78}:$/.test(line)) {
    return false;
  }
  return index === 0 || lines[index - 1]!.trim().length === 0;
}

function trimBlankEdges(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1]!.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end).join("\n");
}

/** Parse persona markdown into the structured form model (never throws). */
export function parsePersonaMarkdownToForm(personaMarkdown: string): PersonaFormModel {
  const model: PersonaFormModel = {
    name: null,
    color: null,
    cooldownSeconds: null,
    description: null,
    intro: "",
    sections: [],
    unmappedFrontmatterLines: [],
    hasFrontmatter: false,
    isStructured: false,
    rawMarkdown: personaMarkdown,
  };

  const trimmed = personaMarkdown.trim();
  let body = trimmed;

  if (trimmed.startsWith(FRONTMATTER_FENCE)) {
    const closeIndex = trimmed.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
    if (closeIndex === -1) {
      // Unclosed fence: structurally unparseable — raw fallback only.
      return model;
    }
    model.hasFrontmatter = true;
    const frontmatterLines = trimmed
      .slice(FRONTMATTER_FENCE.length, closeIndex)
      .split("\n")
      .filter((line) => line.trim().length > 0);
    for (const line of frontmatterLines) {
      const match = /^(\w+):\s*(.*)$/.exec(line);
      const key = match?.[1];
      const value = match?.[2]?.trim() ?? "";
      if (key === undefined || !KNOWN_FRONTMATTER_KEYS.has(key)) {
        model.unmappedFrontmatterLines.push(line);
        continue;
      }
      if (key === "name") {
        model.name = stripEdgeQuotes(value);
      } else if (key === "color") {
        model.color = stripEdgeQuotes(value);
      } else if (key === "description") {
        model.description = stripEdgeQuotes(value);
      } else if (key === "cooldownSeconds") {
        const parsedSeconds = Number.parseInt(value, 10);
        if (Number.isNaN(parsedSeconds)) {
          model.unmappedFrontmatterLines.push(line);
        } else {
          model.cooldownSeconds = parsedSeconds;
        }
      } else if (key === "capabilities" && value !== "advisory") {
        // Canonical serialization always re-emits `capabilities: advisory`
        // (the schema literal) — preserve a divergent line rather than eat it.
        model.unmappedFrontmatterLines.push(line);
      }
    }
    body = trimmed.slice(closeIndex + 1 + FRONTMATTER_FENCE.length).trim();
  }

  const lines = body.split("\n");
  const headingIndexes = lines
    .map((_, index) => index)
    .filter((index) => checkIsSectionHeading({ lines, index }));
  const firstHeadingIndex = headingIndexes[0] ?? lines.length;
  model.intro = trimBlankEdges(lines.slice(0, firstHeadingIndex));
  model.sections = headingIndexes.map((headingIndex, position) => {
    const nextHeadingIndex = headingIndexes[position + 1] ?? lines.length;
    return {
      heading: lines[headingIndex]!.slice(0, -1),
      content: trimBlankEdges(lines.slice(headingIndex + 1, nextHeadingIndex)),
    };
  });
  model.isStructured = true;
  return model;
}

/**
 * Serialize the form model back to canonical persona markdown. Deterministic
 * and byte-stable for unchanged built-ins: fixed frontmatter field order
 * (name, color, capabilities, cooldownSeconds, description, then unmapped
 * lines), one blank line between blocks. Unstructured models pass their raw
 * markdown through untouched.
 */
export function serializePersonaForm(model: PersonaFormModel): string {
  if (!model.isStructured) {
    return model.rawMarkdown;
  }
  const bodyBlocks = [
    model.intro.trim(),
    ...model.sections.map((section) => {
      const heading = `${section.heading.trim()}:`;
      const content = section.content.trim();
      return content.length === 0 ? heading : `${heading}\n${content}`;
    }),
  ].filter((block) => block.length > 0);
  const body = bodyBlocks.join("\n\n");

  const shouldEmitFrontmatter =
    model.hasFrontmatter ||
    model.name !== null ||
    model.color !== null ||
    model.cooldownSeconds !== null ||
    model.description !== null ||
    model.unmappedFrontmatterLines.length > 0;
  if (!shouldEmitFrontmatter) {
    return body;
  }

  const frontmatterLines = [FRONTMATTER_FENCE];
  if (model.name !== null) {
    frontmatterLines.push(`name: ${model.name}`);
  }
  if (model.color !== null) {
    frontmatterLines.push(`color: "${model.color}"`);
  }
  frontmatterLines.push("capabilities: advisory");
  if (model.cooldownSeconds !== null) {
    frontmatterLines.push(`cooldownSeconds: ${model.cooldownSeconds}`);
  }
  if (model.description !== null) {
    frontmatterLines.push(`description: ${model.description}`);
  }
  frontmatterLines.push(...model.unmappedFrontmatterLines);
  frontmatterLines.push(FRONTMATTER_FENCE);
  return `${frontmatterLines.join("\n")}\n\n${body}`;
}
