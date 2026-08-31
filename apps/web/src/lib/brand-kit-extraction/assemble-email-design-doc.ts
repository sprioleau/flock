/*
  Deterministic assembly of the email-design.md guidance doc from STRUCTURED
  per-section content.

  WHY THIS EXISTS. email-design.md is the ceiling that drives every future
  draft, so it must be produced no matter how much a page has to say. The
  model used to author it as one free-form string up to 16000 chars; on a
  content-heavy page that string overran its ceiling (or truncated the JSON
  around it) and failed validation for the WHOLE brand-kit call — a 502 that
  took the palette, fonts and variations down with it.

  The fix moves the length guardrail off the model and into code. The model
  now returns SHORT, bounded prose per section (see the schema in
  generate-brand-kit.ts); this module lays those sections out under a FIXED
  set of canonical headers and clamps each body to a per-section budget whose
  sum, plus the header scaffolding, can never exceed MAX_EMAIL_DESIGN_DOC_LENGTH.

  Two invariants hold by construction:
    - every canonical header is present, verbatim, in a fixed order — a long
      page is summarised, never allowed to drop a header;
    - the assembled document is always <= MAX_EMAIL_DESIGN_DOC_LENGTH.
*/

import { MAX_EMAIL_DESIGN_DOC_LENGTH } from "@/lib/brand-kit";

export interface EmailDesignComponentSections {
  header: string;
  hero: string;
  cta: string;
  card: string;
  divider: string;
  footer: string;
}

export interface EmailDesignSections {
  brandEssence: string;
  signatureMoves: string;
  colorSystem: string;
  typography: string;
  layoutStructure: string;
  components: EmailDesignComponentSections;
  voiceAndTone: string;
}

/*
  Per-section clamp budgets, in characters. These are the deterministic
  CEILINGS the assembler enforces — the prompt asks the model for far less
  (a few sentences), so clamping is a guardrail that rarely fires rather than
  a routine trim. The sum below plus the fixed header scaffolding stays under
  MAX_EMAIL_DESIGN_DOC_LENGTH with headroom, which is what guarantees the
  document can never overrun.
*/
const SECTION_BUDGETS = {
  brandEssence: 1600,
  signatureMoves: 1600,
  colorSystem: 1600,
  typography: 1400,
  layoutStructure: 1800,
  voiceAndTone: 1600,
} as const;

const COMPONENT_BUDGETS = {
  header: 900,
  hero: 1000,
  cta: 800,
  card: 900,
  divider: 600,
  footer: 900,
} as const;

/*
  The six component sub-sections, in the order they render under "## Components".
*/
const COMPONENT_ORDER: ReadonlyArray<{ key: keyof EmailDesignComponentSections; heading: string }> = [
  { key: "header", heading: "Header" },
  { key: "hero", heading: "Hero" },
  { key: "cta", heading: "CTA" },
  { key: "card", heading: "Card" },
  { key: "divider", heading: "Divider" },
  { key: "footer", heading: "Footer" },
];

/*
  Trim prose to a budget at a natural boundary. Prefer a sentence end, fall
  back to a word boundary with an ellipsis, and NEVER exceed the budget (the
  ellipsis is accounted for). A body already within budget is returned as-is.
*/
function clampProse(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) {
    return trimmed;
  }

  const window = trimmed.slice(0, budget);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentenceEnd >= budget * 0.6) {
    return window.slice(0, sentenceEnd + 1).trim();
  }

  /*
    No usable sentence boundary — cut at the last word and mark the trim. Cut
    the window one short first so the appended ellipsis keeps us <= budget.
  */
  const ellipsisWindow = trimmed.slice(0, budget - 1);
  const lastSpace = ellipsisWindow.lastIndexOf(" ");
  const base = lastSpace >= budget * 0.6 ? ellipsisWindow.slice(0, lastSpace) : ellipsisWindow;
  return `${base.trim()}…`;
}

/*
  True when the model returned nothing usable across every section — the same
  honest "no signal, no doc" outcome the pipeline degrades to for tone of
  voice. Assembling in that case would emit a skeleton of empty headers, which
  is worse than no doc at all.
*/
function hasAnyContent(sections: EmailDesignSections): boolean {
  const bodies = [
    sections.brandEssence,
    sections.signatureMoves,
    sections.colorSystem,
    sections.typography,
    sections.layoutStructure,
    sections.voiceAndTone,
    ...Object.values(sections.components),
  ];
  return bodies.some((body) => body.trim().length > 0);
}

/*
  One "## Heading" block, its body clamped to budget. An empty body yields the
  bare header — a header is never dropped, only its prose summarised away.
*/
function sectionBlock({
  heading,
  body,
  budget,
}: {
  heading: string;
  body: string;
  budget: number;
}): string {
  const clamped = clampProse(body, budget);
  return clamped.length > 0 ? `## ${heading}\n\n${clamped}` : `## ${heading}`;
}

/*
  Assemble the structured sections into the canonical email-design.md. Returns
  "" when there is no content to lay out (honest degrade). Otherwise every
  canonical header is present in order and the result is guaranteed
  <= MAX_EMAIL_DESIGN_DOC_LENGTH.
*/
export function assembleEmailDesignMarkdown(sections: EmailDesignSections): string {
  if (!hasAnyContent(sections)) {
    return "";
  }

  const componentBlocks = COMPONENT_ORDER.map(({ key, heading }) => {
    const body = clampProse(sections.components[key], COMPONENT_BUDGETS[key]);
    return body.length > 0 ? `### ${heading}\n\n${body}` : `### ${heading}`;
  }).join("\n\n");

  const document = [
    sectionBlock({ heading: "Brand Essence", body: sections.brandEssence, budget: SECTION_BUDGETS.brandEssence }),
    sectionBlock({ heading: "Signature Moves", body: sections.signatureMoves, budget: SECTION_BUDGETS.signatureMoves }),
    sectionBlock({ heading: "Color System", body: sections.colorSystem, budget: SECTION_BUDGETS.colorSystem }),
    sectionBlock({ heading: "Typography", body: sections.typography, budget: SECTION_BUDGETS.typography }),
    sectionBlock({ heading: "Layout & Structure", body: sections.layoutStructure, budget: SECTION_BUDGETS.layoutStructure }),
    `## Components\n\n${componentBlocks}`,
    sectionBlock({ heading: "Voice & Tone", body: sections.voiceAndTone, budget: SECTION_BUDGETS.voiceAndTone }),
  ].join("\n\n");

  /*
    Belt and suspenders: the budgets are chosen to sum under the ceiling, so
    this slice should never fire — but if a future budget edit breaks that, a
    hard cut is safer than emitting a document the wire contract will reject.
  */
  return document.length <= MAX_EMAIL_DESIGN_DOC_LENGTH
    ? document
    : document.slice(0, MAX_EMAIL_DESIGN_DOC_LENGTH).trimEnd();
}
