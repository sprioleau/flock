import { describe, expect, it } from "vitest";
import {
  buildClassificationPrompt,
  buildDeterministicFloor,
  classifyPage,
  validateClassification,
  type PageClassification,
} from "../classify-page";
import type { PageScrape } from "../page-scrape";

/**
 * The reading step, held to two rules above all others.
 *
 * 1. The classifier never sees the user's message. Not "is told to ignore it"
 *    — it is not passed. The first describe block below is the enforcement.
 * 2. It never throws. A page that WAS fetched always yields a usable answer,
 *    because throwing puts a page we did read onto the error path, where the
 *    model is invited to retry a call that will fail the same way.
 */

function makeScrape(overrides: Partial<PageScrape> = {}): PageScrape {
  return {
    finalUrl: "https://studio.example/about",
    canonicalUrl: "https://studio.example/about",
    siteName: "Studio Marrow",
    title: "Rowan Ellis",
    description: "Product designer.",
    blocks: [
      { kind: "heading", text: "Rowan Ellis" },
      { kind: "paragraph", text: "Nine years of clinical software." },
    ],
    lists: [{ headingBefore: "Skills", items: ["TypeScript", "React"], linkDensity: 0 }],
    structuredData: [{ "@type": "Person", name: "Rowan Ellis" }],
    imageCandidates: [
      {
        id: "img_1",
        sourceUrl: "https://studio.example/portrait.jpg",
        alt: "Rowan Ellis",
        documentOrder: 0,
        origin: "inline",
        hints: ["portrait-ish"],
      },
      {
        id: "img_2",
        sourceUrl: "https://studio.example/card.png",
        documentOrder: 1,
        origin: "og-image",
        hints: [],
      },
    ],
    isTruncated: false,
    ...overrides,
  };
}

function makeClassification(overrides: Partial<PageClassification> = {}): PageClassification {
  return {
    pageType: "portfolio",
    confidence: "high",
    sourceSummary: "A designer's portfolio.",
    isPlanUsable: true,
    images: [],
    ...overrides,
  };
}

describe("buildClassificationPrompt — nothing about the asker can reach it", () => {
  /*
    The real guarantee is the SIGNATURE: one parameter, a PageScrape. This
    block exists to fail loudly if someone widens it, because the failure it
    prevents is invisible — a prompt that quietly starts steering on how the
    request was worded is exactly the design that produced the original bug.
  */
  it("takes exactly one argument", () => {
    expect(buildClassificationPrompt).toHaveLength(1);
  });

  it("renders only the page, never anything else that was passed", () => {
    const scrape = makeScrape({
      title: "ZZQQ_TITLE",
      siteName: "ZZQQ_SITE",
      description: "ZZQQ_DESC",
      blocks: [{ kind: "paragraph", text: "ZZQQ_BLOCK" }],
      lists: [{ items: ["ZZQQ_ITEM"], linkDensity: 0 }],
      structuredData: [],
      imageCandidates: [],
    });
    /*
      Called with a second argument the signature does not accept. If a future
      change starts reading one, this catches it: the marker must not appear.
    */
    const prompt = (buildClassificationPrompt as (...args: unknown[]) => string)(
      scrape,
      "ZZQQ_SMUGGLED_USER_PHRASING",
    );
    expect(prompt).toContain("ZZQQ_TITLE");
    expect(prompt).toContain("ZZQQ_BLOCK");
    expect(prompt).toContain("ZZQQ_ITEM");
    expect(prompt).not.toContain("ZZQQ_SMUGGLED");
  });

  it("carries no keyword list or user-facing phrasing of its own", () => {
    /*
      The phrasings the deleted routing rule embedded. None may return, in the
      prompt or in its examples.
    */
    const prompt = buildClassificationPrompt(makeScrape());
    for (const banned of [
      "my portfolio",
      "about me",
      "personal site",
      "personal website",
      "bare personal domain",
      "who i am",
    ]) {
      expect(prompt.toLowerCase()).not.toContain(banned);
    }
  });

  it("shows each list's link density, so the reader can tell content from navigation", () => {
    const prompt = buildClassificationPrompt(
      makeScrape({
        lists: [
          { headingBefore: "Skills", items: ["TypeScript"], linkDensity: 0 },
          { headingBefore: "Elsewhere", items: ["Work", "About"], linkDensity: 0.97 },
        ],
      }),
    );
    expect(prompt).toContain("LIST[0.00]");
    expect(prompt).toContain("LIST[0.97]");
  });

  it("offers images by id, and never as something the reader could copy", () => {
    const prompt = buildClassificationPrompt(makeScrape());
    expect(prompt).toContain("img_1");
    /* The addresses themselves stay out: there is no syntax for inventing one. */
    expect(prompt).not.toContain("https://studio.example/portrait.jpg");
  });
});

describe("validateClassification — coherence, not page kind", () => {
  const scrape = makeScrape();

  it("drops an assignment naming an image the page never offered", () => {
    const result = validateClassification({
      classification: makeClassification({
        images: [
          { candidateId: "img_1", role: "portrait" },
          { candidateId: "img_INVENTED", role: "lead" },
        ],
      }),
      scrape,
    });
    expect(result.images.map((image) => image.candidateId)).toEqual(["img_1"]);
  });

  it("drops a repeated candidate rather than copying it twice", () => {
    const result = validateClassification({
      classification: makeClassification({
        images: [
          { candidateId: "img_1", role: "portrait" },
          { candidateId: "img_1", role: "supporting" },
        ],
      }),
      scrape,
    });
    expect(result.images).toHaveLength(1);
  });

  it("forces low confidence to stop, whatever else was returned", () => {
    const result = validateClassification({
      classification: makeClassification({ confidence: "low", isPlanUsable: true }),
      scrape,
    });
    expect(result.isPlanUsable).toBe(false);
  });

  it("will not accept 'certain, and also there is nothing here'", () => {
    /*
      An incoherent pair. The confidence is what gives way — a refusal we trust
      less is still a refusal, and downgrading the refusal instead would build
      from a page the reader just said it could not use.
    */
    const result = validateClassification({
      classification: makeClassification({ confidence: "high", isPlanUsable: false }),
      scrape,
    });
    expect(result.confidence).toBe("medium");
    expect(result.isPlanUsable).toBe(false);
  });

  it("treats a medium with nothing to say as a high", () => {
    const result = validateClassification({
      classification: makeClassification({ confidence: "medium" }),
      scrape,
    });
    expect(result.confidence).toBe("high");
  });

  it("keeps a medium that names the unclear thing", () => {
    const result = validateClassification({
      classification: makeClassification({
        confidence: "medium",
        uncertaintyNote: "Could equally be a listing of six separate events.",
      }),
      scrape,
    });
    expect(result.confidence).toBe("medium");
  });
});

describe("classifyPage — a page that was read always yields an answer", () => {
  it("falls to the floor when there is no classifier at all", async () => {
    const result = await classifyPage({ scrape: makeScrape(), classify: null });
    expect(result.isPlanUsable).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.sourceSummary).toContain("Rowan Ellis");
  });

  it("does not throw when the call throws", async () => {
    const result = await classifyPage({
      scrape: makeScrape(),
      classify: async () => {
        throw new Error("quota exhausted");
      },
    });
    expect(result.isPlanUsable).toBe(false);
    expect(result.message).toBeDefined();
  });

  it("does not throw when the call returns something off-schema", async () => {
    const result = await classifyPage({
      scrape: makeScrape(),
      classify: async () => ({ pageType: "not_a_real_type", confidence: "very" }),
    });
    expect(result.pageType).toBe("other");
    expect(result.isPlanUsable).toBe(false);
  });

  it("keeps one image at the floor, so a refusal is cheap to recover from", async () => {
    /*
      A refusal the user cannot cheaply recover from just makes them re-ask,
      and we pay for the fetch again. The publisher's own nominated image plus
      the title is enough for the agent to say what it found.
    */
    const result = await classifyPage({ scrape: makeScrape(), classify: null });
    expect(result.images).toEqual([{ candidateId: "img_2", role: "lead" }]);
  });

  it("never nominates a favicon as the floor's image", async () => {
    const result = await classifyPage({
      scrape: makeScrape({
        imageCandidates: [
          {
            id: "img_1",
            sourceUrl: "https://studio.example/icon.png",
            documentOrder: 0,
            origin: "og-image",
            hints: ["icon-ish", "small"],
          },
        ],
      }),
      classify: null,
    });
    expect(result.images).toEqual([]);
  });

  it("passes a well-formed reading through, validated", async () => {
    const result = await classifyPage({
      scrape: makeScrape(),
      classify: async () => ({
        pageType: "portfolio",
        confidence: "high",
        sourceSummary: "A designer's own site.",
        isPlanUsable: true,
        images: [{ candidateId: "img_1", role: "portrait", subject: "Rowan Ellis" }],
      }),
    });
    expect(result.pageType).toBe("portfolio");
    expect(result.images).toEqual([
      { candidateId: "img_1", role: "portrait", subject: "Rowan Ellis" },
    ]);
  });
});

describe("buildDeterministicFloor", () => {
  it("says the page was read but not interpreted, rather than guessing", () => {
    const floor = buildDeterministicFloor(makeScrape());
    expect(floor.pageType).toBe("other");
    expect(floor.confidence).toBe("low");
    expect(floor.isPlanUsable).toBe(false);
    /* It must not invent a page kind it has no evidence for. */
    expect(floor.pageTypeNote).toContain("not interpreted");
  });
});
