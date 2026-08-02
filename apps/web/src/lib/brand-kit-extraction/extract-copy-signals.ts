/**
 * Deterministic COPY-signal extraction — the raw material for tone of voice
 * (docs/proposals/brand-kit-user-control.md §5.4). No LLM, no fetching: it
 * reads the page the pipeline already has, with the same bounded regex-scale
 * approach as harvest.ts and extract-site-identity.ts.
 *
 * Signals, in descending order of how reliably they carry voice:
 * - the meta/og description: author-written, one sentence, usually on-voice;
 * - the H1 and the first real body paragraph;
 * - button/CTA labels — a brand that says "Get started" is not the brand that
 *   says "Request a consultation".
 *
 * FAILURE STANCE (matching the rest of the pipeline): no copy found means no
 * tone of voice, not an invented one. `hasAnySignal` is what the caller gates
 * on, and the user types their own voice when it is false.
 *
 * Everything here is UNTRUSTED page text that will eventually sit in a model
 * prompt. It is length-bounded at extraction and delimiter-sanitized again at
 * the seam (lib/brand-voice.ts) — defense at both ends.
 */

import { decodeBasicEntities, findMetaContent } from "./html-utils";

export interface CopySignals {
  /** og:description / <meta name="description">, entity-decoded. */
  description: string | null;
  /** The page's first <h1> text. */
  headline: string | null;
  /** The first body paragraph long enough to carry a voice. */
  firstParagraph: string | null;
  /** Button/CTA label text, deduped and bounded. */
  ctaLabels: string[];
  /** False when the page gave us nothing to reason about. */
  hasAnySignal: boolean;
}

const MAX_DESCRIPTION_CHARS = 300;
const MAX_HEADLINE_CHARS = 160;
const MAX_PARAGRAPH_CHARS = 400;
const MAX_CTA_LABELS = 8;
const MAX_CTA_LABEL_CHARS = 40;
/** Shorter than this and a <p> is a caption/label, not the brand's prose. */
const MIN_PARAGRAPH_CHARS = 40;
/** Bound the region scanned for CTAs so huge pages stay cheap. */
const MAX_CTA_SCAN_CHARS = 200_000;

/** Strip tags and collapse whitespace — inner HTML to readable text. */
function toPlainText(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  );
}

/** The inner text of the first matching element, or null. */
function findFirstElementText({
  html,
  tagName,
  minChars,
  maxChars,
}: {
  html: string;
  tagName: string;
  minChars: number;
  maxChars: number;
}): string | null {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]{0,2000}?)</${tagName}>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const text = toPlainText(match[1] ?? "");
    if (text.length >= minChars) {
      return text.slice(0, maxChars);
    }
  }
  return null;
}

/**
 * CTA labels: <button> text plus anchors whose class/id marks them as buttons.
 * Navigation words ("Home", "About") slip through occasionally and that is
 * fine — the model sees them as a sample of the site's label voice, not as a
 * list of calls to action.
 */
function extractCtaLabels(html: string): string[] {
  const region = html.slice(0, MAX_CTA_SCAN_CHARS);
  const labels: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const text = toPlainText(raw);
    const key = text.toLowerCase();
    if (text.length === 0 || text.length > MAX_CTA_LABEL_CHARS || seen.has(key)) {
      return;
    }
    seen.add(key);
    labels.push(text);
  };
  for (const match of region.matchAll(/<button\b[^>]*>([\s\S]{0,300}?)<\/button>/gi)) {
    push(match[1] ?? "");
  }
  for (const match of region.matchAll(
    /<a\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]{0,300}?)<\/a>/gi,
  )) {
    push(match[1] ?? "");
  }
  return labels.slice(0, MAX_CTA_LABELS);
}

/** Read the page's copy signals. Pure; nothing here fetches anything. */
export function extractCopySignals(html: string): CopySignals {
  const rawDescription =
    findMetaContent({ html, key: "og:description" }) ??
    findMetaContent({ html, key: "description" });
  const description =
    rawDescription === null ? null : decodeBasicEntities(rawDescription).slice(0, MAX_DESCRIPTION_CHARS);
  const headline = findFirstElementText({
    html,
    tagName: "h1",
    minChars: 1,
    maxChars: MAX_HEADLINE_CHARS,
  });
  const firstParagraph = findFirstElementText({
    html,
    tagName: "p",
    minChars: MIN_PARAGRAPH_CHARS,
    maxChars: MAX_PARAGRAPH_CHARS,
  });
  const ctaLabels = extractCtaLabels(html);
  return {
    description,
    headline,
    firstParagraph,
    ctaLabels,
    hasAnySignal:
      description !== null || headline !== null || firstParagraph !== null || ctaLabels.length > 0,
  };
}

/** The copy sample as prompt lines, or null when the page carried no copy. */
export function describeCopySignals(signals: CopySignals): string | null {
  if (!signals.hasAnySignal) {
    return null;
  }
  return [
    `Description: ${signals.description ?? "(none found)"}`,
    `Headline: ${signals.headline ?? "(none found)"}`,
    `First paragraph: ${signals.firstParagraph ?? "(none found)"}`,
    `Button labels: ${signals.ctaLabels.length > 0 ? signals.ctaLabels.join(" | ") : "(none found)"}`,
  ].join("\n");
}
