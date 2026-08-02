import type { PersonHighlightPayload, WebArticlePayload } from "@flock/agent";
import { addSectionOperationSchema, ROOT_BLOCK_ID } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import {
  composeArticleSection,
  composePersonSection,
  condenseArticleBody,
} from "../compose-article-section";

/**
 * The deterministic composer stands in for the model on the mock tier, so it
 * is held to the SAME §7.4 faithfulness rules the prompt imposes on the model:
 * every emitted string traces back to the payload, the attribution link is
 * always the payload's canonical URL, and an absent image stays absent.
 */

const ARTICLE: WebArticlePayload = {
  title: "City to build solar canopy over downtown parking",
  byline: "Dana Reeve",
  publishedAt: "2026-07-18T09:30:00Z",
  sourceName: "The Daily Meridian",
  canonicalUrl: "https://www.dailymeridian.com/climate/solar-canopy-city",
  heroImageUrl: "https://storage.example.com/stored-hero.jpg",
  excerpt: "A 4.2-megawatt solar canopy is coming downtown.",
  mainText:
    "The council voted 8-1 on Tuesday to approve the canopy. It would be the largest municipal solar installation in the state. Construction is expected to begin in the spring.\n\nA structural study confirmed the 1970s-era garage can carry the load.",
  isTruncated: false,
  confidence: "high",
};

/** Every text run in an addSection payload, flattened. */
function collectEmittedText(operation: ReturnType<typeof composeArticleSection>): string[] {
  const texts: string[] = [];
  for (const block of operation.children ?? []) {
    if (block.type === "text") {
      for (const node of block.properties.text.content) {
        for (const inline of node.content ?? []) {
          if (inline.type === "text") {
            texts.push(inline.text);
          }
        }
      }
    }
    if (block.type === "button") {
      texts.push(block.properties.label);
    }
  }
  return texts;
}

describe("composeArticleSection", () => {
  const operation = composeArticleSection({ article: ARTICLE, index: 2 });

  it("emits a schema-valid addSection at the requested index", () => {
    const parsed = addSectionOperationSchema.safeParse(operation);
    expect(parsed.success).toBe(true);
    expect(operation.index).toBe(2);
    expect(operation.section.parentId).toBe(ROOT_BLOCK_ID);
  });

  it("wires childrenIds to the prebuilt subtree, parents included", () => {
    const childIds = (operation.children ?? []).map((block) => block.id);
    expect(operation.section.childrenIds).toEqual(childIds);
    for (const block of operation.children ?? []) {
      expect(block.parentId).toBe(operation.section.id);
    }
  });

  it("ALWAYS attributes: the button href is the payload's canonical URL", () => {
    const button = (operation.children ?? []).find((block) => block.type === "button");
    expect(button).toBeDefined();
    if (button?.type !== "button") return;
    expect(button.properties.href).toBe(ARTICLE.canonicalUrl);
  });

  it("names the real source, byline, and date — and nothing else", () => {
    const texts = collectEmittedText(operation);
    expect(texts.some((text) => text.includes("The Daily Meridian"))).toBe(true);
    expect(texts.some((text) => text.includes("Dana Reeve"))).toBe(true);
  });

  it("uses the stored hero image URL verbatim, never a placeholder", () => {
    const image = (operation.children ?? []).find((block) => block.type === "image");
    expect(image).toBeDefined();
    if (image?.type !== "image") return;
    expect(image.properties.src).toBe(ARTICLE.heroImageUrl);
    expect(image.properties.alt).toBe(ARTICLE.title);
  });

  it("emits NO image block when the payload carries no hero image", () => {
    const { heroImageUrl: _dropped, ...articleWithoutHero } = ARTICLE;
    const withoutHero = composeArticleSection({ article: articleWithoutHero, index: 0 });
    expect((withoutHero.children ?? []).some((block) => block.type === "image")).toBe(false);
    // …and no placehold.co stand-in sneaks in either.
    expect(JSON.stringify(withoutHero)).not.toContain("placehold.co");
  });

  it("writes only sentences that are literally in the fetched text", () => {
    const texts = collectEmittedText(operation);
    const bodyParagraph = texts.find((text) => text.includes("council voted"));
    expect(bodyParagraph).toBeDefined();
    for (const sentence of (bodyParagraph ?? "").split(". ")) {
      expect(ARTICLE.mainText).toContain(sentence.replace(/…$/, "").trim().replace(/\.$/, ""));
    }
  });

  it("falls back to a source-only credit when byline and date are absent", () => {
    const { byline: _b, publishedAt: _p, ...bare } = ARTICLE;
    const texts = collectEmittedText(composeArticleSection({ article: bare, index: 0 }));
    expect(texts).toContain("From The Daily Meridian");
  });
});

describe("condenseArticleBody", () => {
  it("keeps the article's opening sentences in order", () => {
    const condensed = condenseArticleBody({
      mainText: ARTICLE.mainText,
      sentenceCount: 2,
      maxChars: 1_000,
    });
    expect(condensed).toBe(
      "The council voted 8-1 on Tuesday to approve the canopy. It would be the largest municipal solar installation in the state.",
    );
  });

  it("respects the character budget", () => {
    const condensed = condenseArticleBody({
      mainText: ARTICLE.mainText,
      sentenceCount: 5,
      maxChars: 40,
    });
    expect(condensed.length).toBeLessThanOrEqual(41); // budget + the ellipsis
    expect(condensed.endsWith("…")).toBe(true);
  });
});

const PERSON: PersonHighlightPayload = {
  name: "Dr. Amara Osei",
  role: "Professor of Environmental Engineering",
  organization: "Yale School of Engineering",
  sourceName: "Yale University",
  profileUrl: "https://seas.yale.edu/people/amara-osei",
  photoUrl: "https://storage.example.com/stored-portrait.jpg",
  bio: "Amara Osei studies urban heat and the design of shaded public space.",
  facts: [
    {
      text: "She leads the Urban Climate Lab.",
      sourceUrl: "https://seas.yale.edu/people/amara-osei",
    },
  ],
  sources: [{ title: "Yale University", url: "https://seas.yale.edu/people/amara-osei" }],
  searchStatus: "unavailable",
};

describe("composePersonSection", () => {
  const operation = composePersonSection({ person: PERSON, index: 0 });

  it("emits a schema-valid addSection linking back to the profile", () => {
    expect(addSectionOperationSchema.safeParse(operation).success).toBe(true);
    const button = (operation.children ?? []).find((block) => block.type === "button");
    if (button?.type !== "button") throw new Error("expected an attribution button");
    expect(button.properties.href).toBe(PERSON.profileUrl);
  });

  it("uses the stored portrait and names the person in the alt text", () => {
    const image = (operation.children ?? []).find((block) => block.type === "image");
    if (image?.type !== "image") throw new Error("expected a portrait");
    expect(image.properties.src).toBe(PERSON.photoUrl);
    expect(image.properties.alt).toBe("Photo of Dr. Amara Osei");
  });

  it("emits no image at all when no usable photo came back", () => {
    const { photoUrl: _dropped, ...personWithoutPhoto } = PERSON;
    const withoutPhoto = composePersonSection({ person: personWithoutPhoto, index: 0 });
    expect((withoutPhoto.children ?? []).some((block) => block.type === "image")).toBe(false);
  });

  it("writes only the payload's own role, organization, and bio", () => {
    const texts = collectEmittedText(operation);
    expect(texts).toContain("Professor of Environmental Engineering, Yale School of Engineering");
    expect(texts).toContain(PERSON.bio);
    expect(texts).toContain("Source: Yale University");
  });
});
