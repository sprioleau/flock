import { describe, expect, it } from "vitest";
import {
  assembleImageStyleMarkdown,
  type ImageStyleSections,
} from "./assemble-image-style-doc";

const CANONICAL_HEADERS = [
  "## Overview",
  "## Color",
  "## Subjects & Composition",
  "## Signature Elements",
  "## Lighting & Mood",
  "## Camera / Rendering",
  "## Do Not",
];

function sectionsWith(body: string): ImageStyleSections {
  return {
    overview: body,
    color: body,
    subjectsAndComposition: body,
    signatureElements: body,
    lightingAndMood: body,
    cameraRendering: body,
    doNot: body,
  };
}

describe("assembleImageStyleMarkdown", () => {
  it("lays out each canonical image-style section in order", () => {
    const document = assembleImageStyleMarkdown({
      ...sectionsWith(""),
      overview: "Editorial product imagery with crisp, deliberate framing.",
      color: "Use the harvested accent as a restrained focal point.",
      doNot: "Do not introduce partner logos as brand identity.",
    });

    expect(document).toContain("Editorial product imagery");
    expect(document).toContain("Do not introduce partner logos");
    const positions = CANONICAL_HEADERS.map((header) =>
      document.indexOf(header),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("returns no document when every section is empty", () => {
    expect(assembleImageStyleMarkdown(sectionsWith(""))).toBe("");
  });

  it("keeps the document bounded while retaining every heading", () => {
    const flood =
      "A grounded image treatment with a concrete, email-safe rule. ".repeat(
        1000,
      );
    const document = assembleImageStyleMarkdown(sectionsWith(flood));

    expect(document.length).toBeLessThanOrEqual(12000);
    for (const header of CANONICAL_HEADERS) {
      expect(document).toContain(header);
    }
  });
});
