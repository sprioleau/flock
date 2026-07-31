import { describe, expect, it } from "vitest";
import {
  MAX_PERSONA_MARKDOWN_LENGTH,
  parsePersonaMarkdown,
  parsePersonaMarkdownToForm,
  serializePersonaForm,
  validatePersonaMarkdown,
} from "./parse-persona-markdown";

/** Byte-exact copies of the seeded built-ins (convex/personas.ts) — the
 * round-trip contract is anchored to these. */
const TONE_POLICE_MARKDOWN = `---
name: Tone Police
color: "#e11d48"
capabilities: advisory
cooldownSeconds: 45
description: Guards the email's tone of voice — flags copy that clashes with the rest and suggests concrete rewrites.
---

You are the Tone Police. Your single job is the email's tone of voice: one
consistent, intentional register from subject line to sign-off.

What you watch for:
- Copy whose register clashes with the rest of the email (a pushy hard-sell
  line inside a warm friendly note; sudden ALL-CAPS urgency; slang in an
  otherwise formal announcement; stiff legalese in a playful promo).
- Mixed person or voice ("we" vs "I"), inconsistent formality, or greetings/
  closings that don't match the body.
- Button labels and headings whose tone contradicts the body copy.

How you respond:
- Quote the exact phrase that clashes (briefly) and say WHY it clashes with
  the surrounding voice.
- Always offer a concrete rewrite the user could paste in — never just
  "consider changing the tone".
- Judge tone against the email's own dominant voice, not a house style you
  invented. If the whole email is consistently brash, that IS its voice —
  stay quiet.
- At most two findings per pass; only the ones a careful editor would
  actually flag.`;

const STYLING_RECOMMENDER_MARKDOWN = `---
name: Styling Recommender
color: "#0d9488"
capabilities: advisory
cooldownSeconds: 45
description: Spots styling inconsistencies and opportunities across blocks — and proposes the exact style change to fix them.
---

You are the Styling Recommender. Your single job is visual consistency and
polish across the email's blocks.

What you watch for:
- Same-purpose blocks that drifted apart: two CTA buttons with different
  background colors, corner radii, or alignment; sibling columns with
  mismatched padding; headings that switch color mid-email for no reason.
- Styling that fights the document's global theme (a one-off color that is
  almost-but-not-quite the accent color).
- Readability problems: low-contrast text on its background, tiny font sizes
  on important lines.

How you respond:
- Name the affected blocks by their VISIBLE content (the button labeled
  "Buy now", the heading "Spring sale"), never by internal ids.
- Whenever the fix is a block property change, propose the exact edit
  (block, property, value) so it can be applied with one click. Prefer
  matching the email's existing dominant style over inventing a new one.
- Do not relitigate deliberate variety: a hero section MAY differ from the
  footer. Flag drift between things that clearly want to match.
- At most two findings per pass; skip nitpicks a designer wouldn't stop for.`;

const VALID_MARKDOWN = `---
name: Test Persona
description: A one-liner for the picker.
---

You are a test persona. Behave accordingly.`;

describe("parsePersonaMarkdown", () => {
  it("extracts the description and body from frontmatter markdown", () => {
    const parsed = parsePersonaMarkdown(VALID_MARKDOWN);
    expect(parsed.description).toBe("A one-liner for the picker.");
    expect(parsed.body).toBe("You are a test persona. Behave accordingly.");
  });

  it("treats fence-less text as body-only", () => {
    const parsed = parsePersonaMarkdown("Just behavior text.");
    expect(parsed.description).toBeNull();
    expect(parsed.body).toBe("Just behavior text.");
  });
});

describe("validatePersonaMarkdown", () => {
  it("accepts well-formed persona markdown", () => {
    expect(validatePersonaMarkdown(VALID_MARKDOWN)).toBeNull();
  });

  it("accepts fence-less behavior text", () => {
    expect(validatePersonaMarkdown("Watch for passive voice.")).toBeNull();
  });

  it("rejects empty and whitespace-only definitions", () => {
    expect(validatePersonaMarkdown("")).toMatch(/empty/);
    expect(validatePersonaMarkdown("   \n\t ")).toMatch(/empty/);
  });

  it("rejects definitions over the size cap", () => {
    const oversized = "x".repeat(MAX_PERSONA_MARKDOWN_LENGTH + 1);
    expect(validatePersonaMarkdown(oversized)).toMatch(/too long/);
  });

  it("rejects an unclosed frontmatter fence", () => {
    const unclosed = "---\nname: Broken\nno closing fence anywhere";
    expect(validatePersonaMarkdown(unclosed)).toMatch(/never closed/);
  });

  it("rejects frontmatter with an empty body", () => {
    const headerOnly = "---\nname: Header Only\n---\n\n   ";
    expect(validatePersonaMarkdown(headerOnly)).toMatch(/behavior text/);
  });
});

describe("parsePersonaMarkdownToForm", () => {
  it("maps the built-in frontmatter to dedicated fields", () => {
    const model = parsePersonaMarkdownToForm(TONE_POLICE_MARKDOWN);
    expect(model.isStructured).toBe(true);
    expect(model.name).toBe("Tone Police");
    expect(model.color).toBe("#e11d48");
    expect(model.cooldownSeconds).toBe(45);
    expect(model.description).toMatch(/Guards the email's tone of voice/);
    expect(model.unmappedFrontmatterLines).toEqual([]);
  });

  it("splits the body into intro and labeled sections", () => {
    const model = parsePersonaMarkdownToForm(TONE_POLICE_MARKDOWN);
    expect(model.intro).toMatch(/^You are the Tone Police\./);
    expect(model.sections.map((section) => section.heading)).toEqual([
      "What you watch for",
      "How you respond",
    ]);
    expect(model.sections[0]!.content).toMatch(/^- Copy whose register clashes/);
  });

  it("routes unknown frontmatter keys to the unmapped remainder", () => {
    const markdown = `---\nname: Custom\nmystery: keep me\n---\n\nBehavior.`;
    const model = parsePersonaMarkdownToForm(markdown);
    expect(model.unmappedFrontmatterLines).toEqual(["mystery: keep me"]);
  });

  it("flags an unclosed fence as unstructured (raw fallback)", () => {
    const model = parsePersonaMarkdownToForm("---\nname: Broken\nnever closes");
    expect(model.isStructured).toBe(false);
    expect(serializePersonaForm(model)).toBe("---\nname: Broken\nnever closes");
  });
});

describe("serializePersonaForm round-trips", () => {
  it("is byte-lossless for the Tone Police built-in", () => {
    const model = parsePersonaMarkdownToForm(TONE_POLICE_MARKDOWN);
    expect(serializePersonaForm(model)).toBe(TONE_POLICE_MARKDOWN);
  });

  it("is byte-lossless for the Styling Recommender built-in", () => {
    const model = parsePersonaMarkdownToForm(STYLING_RECOMMENDER_MARKDOWN);
    expect(serializePersonaForm(model)).toBe(STYLING_RECOMMENDER_MARKDOWN);
  });

  it("is byte-stable for a heading-only section (no dangling newline)", () => {
    const headingOnly = "Intro text.\n\nWhat you watch for:";
    const model = parsePersonaMarkdownToForm(headingOnly);
    expect(model.sections).toEqual([{ heading: "What you watch for", content: "" }]);
    expect(serializePersonaForm(model)).toBe(headingOnly);
  });

  it("is byte-stable for fence-less behavior text", () => {
    const fenceLess = "Watch for passive voice.\n\nHow you respond:\n- Gently.";
    const model = parsePersonaMarkdownToForm(fenceLess);
    expect(serializePersonaForm(model)).toBe(fenceLess);
  });

  it("preserves unmapped frontmatter through a round trip", () => {
    const markdown = `---\nname: Custom\nmystery: keep me\n---\n\nBehavior.`;
    const once = serializePersonaForm(parsePersonaMarkdownToForm(markdown));
    expect(once).toContain("mystery: keep me");
    // Stable from the first canonical serialization onward.
    expect(serializePersonaForm(parsePersonaMarkdownToForm(once))).toBe(once);
  });

  it("reflects field edits in the serialized markdown", () => {
    const model = parsePersonaMarkdownToForm(TONE_POLICE_MARKDOWN);
    model.name = "Tone Cop";
    model.cooldownSeconds = 60;
    model.sections[0] = { ...model.sections[0]!, content: "- Only shouting." };
    const serialized = serializePersonaForm(model);
    expect(serialized).toContain("name: Tone Cop");
    expect(serialized).toContain("cooldownSeconds: 60");
    expect(serialized).toContain("What you watch for:\n- Only shouting.");
    // And the edit round-trips.
    expect(serializePersonaForm(parsePersonaMarkdownToForm(serialized))).toBe(serialized);
  });
});
