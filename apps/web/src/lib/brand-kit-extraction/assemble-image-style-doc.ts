/*
  Deterministic assembly of the image-style.md guidance document from bounded
  structured prose. The fixed headings make the document easy to scan and
  ensure a verbose model response cannot make the whole brand kit invalid.
*/

export const MAX_IMAGE_STYLE_DOC_LENGTH = 12_000;

export interface ImageStyleSections {
  overview: string;
  color: string;
  subjectsAndComposition: string;
  signatureElements: string;
  lightingAndMood: string;
  cameraRendering: string;
  doNot: string;
}

const SECTION_ORDER: ReadonlyArray<{
  key: keyof ImageStyleSections;
  heading: string;
  budget: number;
}> = [
  { key: "overview", heading: "Overview", budget: 1_700 },
  { key: "color", heading: "Color", budget: 2_000 },
  {
    key: "subjectsAndComposition",
    heading: "Subjects & Composition",
    budget: 2_100,
  },
  { key: "signatureElements", heading: "Signature Elements", budget: 1_700 },
  { key: "lightingAndMood", heading: "Lighting & Mood", budget: 1_500 },
  { key: "cameraRendering", heading: "Camera / Rendering", budget: 1_500 },
  { key: "doNot", heading: "Do Not", budget: 1_300 },
];

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

  const ellipsisWindow = trimmed.slice(0, Math.max(0, budget - 1));
  const lastSpace = ellipsisWindow.lastIndexOf(" ");
  const base =
    lastSpace >= budget * 0.6
      ? ellipsisWindow.slice(0, lastSpace)
      : ellipsisWindow;
  return `${base.trim()}…`;
}

function hasAnyContent(sections: ImageStyleSections): boolean {
  return SECTION_ORDER.some(({ key }) => sections[key].trim().length > 0);
}

/*
  Assemble a bounded image-style.md. Empty sections remain visible when at
  least one signal exists, which keeps the artifact's contract stable while
  honestly leaving unsupported areas without invented prose.
*/
export function assembleImageStyleMarkdown(
  sections: ImageStyleSections,
): string {
  if (!hasAnyContent(sections)) {
    return "";
  }

  const document = SECTION_ORDER.map(({ key, heading, budget }) => {
    const body = clampProse(sections[key], budget);
    return body.length > 0 ? `## ${heading}\n\n${body}` : `## ${heading}`;
  }).join("\n\n");

  return document.length <= MAX_IMAGE_STYLE_DOC_LENGTH
    ? document
    : document.slice(0, MAX_IMAGE_STYLE_DOC_LENGTH).trimEnd();
}
