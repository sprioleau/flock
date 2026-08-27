import { describe, expect, it } from "vitest";
import { extractPage, MAX_PAGE_CONTENT_CHARS } from "../extract-page";

/**
 * The budget's whole value is that it is PREDICTABLE. Two things are therefore
 * pinned here: the drop order fires 1→6 and never out of order, and the
 * identity of the page survives any budget at all — including one that cannot
 * possibly be met.
 */

const BUDGET_URL = "https://studiomarrow.example/record";

const FULL_BLOCK_COUNT = 69;
const FULL_LIST_COUNT = 8;
const FULL_ITEMS_PER_LIST = 15;
const FULL_STRUCTURED_DATA_COUNT = 7;
const FULL_IMAGE_COUNT = 21;

/**
 * A page far over any budget in every channel at once, so each drop step has
 * something to bite on. Sizes are chosen so the steps are separable: dropping
 * everything step 1 can drop still leaves the page over budget, and so on down.
 */
function buildOverCapPage(): string {
  const paragraphs = Array.from(
    { length: 40 },
    (_, index) =>
      `<p>Paragraph ${index + 1}. The studio kept a written record of every decision it made about the platform that year, and this entry covers the part of it that people still argue about at length whenever the subject comes up again over lunch.</p>`,
  ).join("\n");

  /*
    Eight admissible lists whose link densities rise steadily, so step 3's
    "keep the lowest density" has a right answer that is not the array order.
  */
  const lists = Array.from({ length: FULL_LIST_COUNT }, (_, listIndex) => {
    const items = Array.from({ length: FULL_ITEMS_PER_LIST }, (_, itemIndex) =>
      itemIndex < listIndex
        ? `<li><a href="/ref/${listIndex}/${itemIndex}">Documentation reference link</a> Capability ${listIndex + 1}-${itemIndex + 1}</li>`
        : `<li>Capability ${listIndex + 1}-${itemIndex + 1} of the toolkit</li>`,
    ).join("");
    return `<h2>Group ${listIndex + 1}</h2><ul class="group-${listIndex + 1}">${items}</ul>`;
  }).join("\n");

  const structuredData = [
    { "@type": "WebPage", name: "A page", description: "x".repeat(120) },
    { "@type": "BreadcrumbList", name: "Crumbs", description: "y".repeat(120) },
    { "@type": "Person", name: "Rowan Ellis", description: "z".repeat(120) },
    { "@type": "WebSite", name: "The site", description: "w".repeat(120) },
    { "@type": "Organization", name: "Studio Marrow", description: "v".repeat(120) },
    { "@type": "Product", name: "Atlas", description: "u".repeat(120) },
    { "@type": "Event", name: "Launch", description: "t".repeat(120) },
  ]
    .map(
      (node) =>
        `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", ...node })}</script>`,
    )
    .join("\n");

  const images = Array.from(
    { length: 20 },
    (_, index) =>
      `<p>Interlude ${index + 1} before the screenshot, long enough to be real prose that a reader would keep.</p><img src="/media/shot-${index + 1}.png" alt="Screenshot number ${index + 1} of the platform">`,
  ).join("\n");

  return `<!doctype html><html><head><title>The record</title>
    <meta property="og:site_name" content="Studio Marrow">
    <meta property="og:title" content="The record">
    <meta property="og:description" content="Everything the studio decided that year, written down.">
    <meta property="og:image" content="/media/card.png">
    <link rel="canonical" href="https://studiomarrow.example/record">
    ${structuredData}
    </head><body><main>
    <h1>The record of that year</h1>
    ${paragraphs}
    ${lists}
    ${images}
    </main></body></html>`;
}

const OVER_CAP_HTML = buildOverCapPage();

function scrapeAt(maxContentChars: number) {
  const result = extractPage({ html: OVER_CAP_HTML, finalUrl: BUDGET_URL, maxContentChars });
  if (!result.isOk) {
    throw new Error(`expected a scrape, got refusal: ${result.reason}`);
  }
  return result.scrape;
}

/** Which of the six drop steps are observably done, in order. */
function readFiredSteps(scrape: ReturnType<typeof scrapeAt>): boolean[] {
  return [
    scrape.blocks.length < FULL_BLOCK_COUNT,
    Math.max(...scrape.lists.map((list) => list.items.length)) < FULL_ITEMS_PER_LIST,
    scrape.lists.length < FULL_LIST_COUNT,
    scrape.structuredData.length < FULL_STRUCTURED_DATA_COUNT,
    scrape.imageCandidates.length < FULL_IMAGE_COUNT,
    scrape.imageCandidates.slice(6).every((candidate) => candidate.surroundingText === undefined),
  ];
}

describe("extractPage — the content budget", () => {
  it("leaves an over-cap page untouched only when the budget is not binding", () => {
    const scrape = scrapeAt(Number.MAX_SAFE_INTEGER);
    expect(scrape.blocks.length).toBe(FULL_BLOCK_COUNT);
    expect(scrape.lists.length).toBe(FULL_LIST_COUNT);
    expect(scrape.structuredData.length).toBe(FULL_STRUCTURED_DATA_COUNT);
    expect(scrape.imageCandidates.length).toBe(FULL_IMAGE_COUNT);
    expect(scrape.isTruncated).toBe(false);
  });

  it("fires the six steps strictly in order, never one out of turn", () => {
    /*
      Swept rather than spot-checked: at EVERY budget the fired steps must form
      a prefix of 1→6 — a later step may only have run once all the earlier ones
      are exhausted — and the count may only rise as the budget falls.
    */
    let previousFiredCount = 0;
    let highestFiredCount = 0;
    for (let budget = 30_000; budget >= 0; budget -= 100) {
      const fired = readFiredSteps(scrapeAt(budget));
      const firedCount = fired.filter(Boolean).length;
      expect(fired).toEqual([
        ...Array<boolean>(firedCount).fill(true),
        ...Array<boolean>(fired.length - firedCount).fill(false),
      ]);
      expect(firedCount).toBeGreaterThanOrEqual(previousFiredCount);
      previousFiredCount = firedCount;
      highestFiredCount = Math.max(highestFiredCount, firedCount);
    }
    /*
      Every stage, including doing nothing at all, is actually reachable here.
    */
    expect(previousFiredCount).toBe(6);
    expect(highestFiredCount).toBe(6);
  });

  it("1 — drops trailing prose later-before-earlier, and sets isTruncated", () => {
    const scrape = scrapeAt(22_000);
    expect(scrape.blocks.length).toBeLessThan(FULL_BLOCK_COUNT);
    expect(scrape.isTruncated).toBe(true);
    const texts = scrape.blocks.map((block) => block.text);
    expect(texts).toContain("Paragraph 1. The studio kept a written record of every decision it made about the platform that year, and this entry covers the part of it that people still argue about at length whenever the subject comes up again over lunch.");
    expect(texts.some((text) => text.startsWith("Interlude 20"))).toBe(false);
    /*
      Nothing else has been touched yet.
    */
    expect(scrape.lists.length).toBe(FULL_LIST_COUNT);
    expect(scrape.structuredData.length).toBe(FULL_STRUCTURED_DATA_COUNT);
    expect(scrape.imageCandidates.length).toBe(FULL_IMAGE_COUNT);
  });

  it("2 — caps list items at 12 per list once the prose tail is gone", () => {
    const scrape = scrapeAt(11_500);
    for (const list of scrape.lists) {
      expect(list.items.length).toBe(12);
    }
    expect(scrape.lists.length).toBe(FULL_LIST_COUNT);
    expect(scrape.structuredData.length).toBe(FULL_STRUCTURED_DATA_COUNT);
  });

  it("3 — keeps the six lists with the LOWEST link density", () => {
    const scrape = scrapeAt(10_800);
    expect(scrape.lists.length).toBe(6);
    const densities = scrape.lists.map((list) => list.linkDensity);
    /*
      The two most link-heavy lists are the ones that went.
    */
    expect(Math.max(...densities)).toBeLessThan(0.3);
    /*
      Document order survives the selection — order is evidence.
    */
    expect(densities).toEqual([...densities].sort((left, right) => left - right));
    expect(scrape.structuredData.length).toBe(FULL_STRUCTURED_DATA_COUNT);
  });

  it("4 — keeps four structuredData nodes, priority types first", () => {
    const scrape = scrapeAt(9_900);
    const types = scrape.structuredData.map((node) => node["@type"]);
    expect(types).toEqual(["Person", "Organization", "Product", "Event"]);
    expect(scrape.imageCandidates.length).toBe(FULL_IMAGE_COUNT);
  });

  it("5 — keeps twelve image candidates in document order, og-image among them", () => {
    const scrape = scrapeAt(9_300);
    expect(scrape.imageCandidates.length).toBe(12);
    expect(scrape.imageCandidates[0].origin).toBe("og-image");
    const orders = scrape.imageCandidates.map((candidate) => candidate.documentOrder);
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
    /*
      Ids stay stable, so a dropped candidate leaves a visible gap rather than
      silently renumbering the ones a later step will refer to.
    */
    expect(scrape.imageCandidates[0].id).toBe("img_1");
  });

  it("6 — strips surroundingText beyond the first six candidates last of all", () => {
    /*
      The same candidates still carry their context one step earlier, so this
      is a removal being observed rather than an absence.
    */
    const beforeStep = scrapeAt(9_300);
    for (const candidate of beforeStep.imageCandidates.slice(6)) {
      expect(candidate.surroundingText).toBeDefined();
    }

    const scrape = scrapeAt(6_800);
    expect(scrape.imageCandidates.map((candidate) => candidate.id)).toEqual(
      beforeStep.imageCandidates.map((candidate) => candidate.id),
    );
    for (const candidate of scrape.imageCandidates.slice(6)) {
      expect(candidate.surroundingText).toBeUndefined();
    }
    expect(
      scrape.imageCandidates
        .slice(0, 6)
        .filter((candidate) => candidate.surroundingText !== undefined).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the never-droppable set at a budget that cannot be met", () => {
    const scrape = scrapeAt(0);
    expect(scrape.finalUrl).toBe(BUDGET_URL);
    expect(scrape.canonicalUrl).toBe("https://studiomarrow.example/record");
    expect(scrape.siteName).toBe("Studio Marrow");
    expect(scrape.title).toBe("The record");
    expect(scrape.description).toBe("Everything the studio decided that year, written down.");

    /*
      The first heading and the first two paragraphs.
    */
    expect(scrape.blocks[0]).toEqual({ kind: "heading", text: "The record of that year" });
    const paragraphs = scrape.blocks.filter((block) => block.kind === "paragraph");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].text.startsWith("Paragraph 1.")).toBe(true);
    expect(paragraphs[1].text.startsWith("Paragraph 2.")).toBe(true);

    /*
      The og:image candidate.
    */
    const ogImage = scrape.imageCandidates.find((candidate) => candidate.origin === "og-image");
    expect(ogImage?.sourceUrl).toBe("https://studiomarrow.example/media/card.png");

    expect(scrape.isTruncated).toBe(true);
  });

  it("applies the 8,000 character default when no budget is given", () => {
    expect(MAX_PAGE_CONTENT_CHARS).toBe(8_000);
    const defaultScrape = extractPage({ html: OVER_CAP_HTML, finalUrl: BUDGET_URL });
    if (!defaultScrape.isOk) throw new Error("expected a scrape");
    expect(defaultScrape.scrape).toEqual(scrapeAt(MAX_PAGE_CONTENT_CHARS));
    expect(defaultScrape.scrape.isTruncated).toBe(true);
  });
});
