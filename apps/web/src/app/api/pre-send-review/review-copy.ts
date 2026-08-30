import type { Block, EmailDocument } from "@flock/email-sdk";
import type { CompatibilityFinding } from "@flock/email-sdk/qa";
import type { PreSendReviewFinding } from "./contract";

/*
  Turning a compatibility finding into a sentence a person can act on.

  The SDK's finding is precise and unreadable: a caniemail feature title, a
  block id, and a list of client slugs. Everything here is the translation
  into the two things the dialog shows — a headline and one sentence — and
  the translation is deliberately GENERIC.

  NO PER-FEATURE COPY TABLE, which is the obvious way to make this read
  better ("Rounded corners will look square in Outlook"). caniemail covers
  307 features; a table would cover the dozen we happened to see, read
  beautifully for those, and fall back to something worse than this for
  everything else — and it would be exactly the hand-written rule set that
  using a maintained dataset was meant to avoid. One honest sentence built
  from the feature's own name is better than a hundred hand-written ones and
  a cliff.

  BLOCKS ARE NAMED BY WHAT THE USER CAN SEE. A block id is meaningless to the
  person reading the dialog, and it is the same rule the persona findings
  already follow: refer to content by its visible text, never by internal ids.
*/

/*
  How much of a block's own words to quote before trailing off.
*/
const QUOTED_CONTENT_MAX_CHARACTERS = 32;

function quote(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= QUOTED_CONTENT_MAX_CHARACTERS) {
    return `“${collapsed}”`;
  }
  return `“${collapsed.slice(0, QUOTED_CONTENT_MAX_CHARACTERS - 1).trimEnd()}…”`;
}

/*
  The first words a text block actually says, if it says anything.
*/
function readFirstWords(block: Block): string | undefined {
  if (block.type !== "text") {
    return undefined;
  }
  for (const node of block.properties.text.content) {
    for (const inline of node.content ?? []) {
      if (inline.type === "text" && inline.text.trim() !== "") {
        return inline.text;
      }
    }
  }
  return undefined;
}

/*
  A human reference to a block: its kind, plus its own visible words when it
  has any. Falls back to the bare kind rather than inventing a description —
  "the image" is honest about knowing nothing; "the hero image" would not be.
*/
export function describeBlock(block: Block | undefined): string {
  if (block === undefined) {
    return "the email itself";
  }
  switch (block.type) {
    case "button":
      return `the button labeled ${quote(block.properties.label)}`;
    case "image": {
      const alt = block.properties.alt.trim();
      return alt === "" ? "an image" : `the image ${quote(alt)}`;
    }
    case "link":
      return `the link ${quote(block.properties.text)}`;
    case "text": {
      const words = readFirstWords(block);
      return words === undefined ? "a text block" : `the text starting ${quote(words)}`;
    }
    case "code":
      return "the code block";
    case "divider":
      return "the divider";
    case "spacer":
      return "the spacer";
    case "section":
      return "a section of the email";
    case "row":
      return "a row of the email";
    case "column":
      return "a column of the email";
    case "root":
      return "the email itself";
  }
}

/*
  "Outlook (Windows)" / "Gmail (web) and Outlook (Windows)" /
  "Gmail (web), Outlook (Windows) and 3 others".

  The tail is summarised rather than listed because past two or three names
  the sentence stops being read at all, and the count is the part that
  actually carries the weight ("this breaks in a lot of places").
*/
export function joinClientLabels(labels: readonly string[]): string {
  if (labels.length === 0) {
    return "some email clients";
  }
  if (labels.length === 1) {
    return labels[0] ?? "some email clients";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  if (labels.length === 3) {
    return `${labels[0]}, ${labels[1]} and ${labels[2]}`;
  }
  return `${labels[0]}, ${labels[1]} and ${labels.length - 2} others`;
}

/*
  The whole translation, one finding at a time.

  The sentence always ends by saying what actually happens — the declaration
  is ignored and the email still arrives — because the single most useful
  thing this panel can do is stop a user reading "not supported" as "broken".
  Nothing here is a reason not to send.
*/
export function toPreSendReviewFinding({
  finding,
  doc,
}: {
  finding: CompatibilityFinding;
  doc: EmailDocument;
}): PreSendReviewFinding {
  const block = finding.blockId === undefined ? undefined : doc[finding.blockId];
  const clients = joinClientLabels(finding.affectedClientLabels);
  return {
    id: `${finding.featureTitle}:${finding.blockId ?? "document"}`,
    title: `${finding.featureTitle} is ignored in ${clients}`,
    description: `${describeBlock(block)} uses ${finding.featureTitle}, which ${clients} ${
      finding.affectedClientLabels.length === 1 ? "does" : "do"
    } not support. The email still sends and still reads correctly there — that styling is simply dropped.`,
    blockId: finding.blockId,
  };
}
