import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractArticle } from "../extract-article";
import { extractPage } from "../extract-page";

/**
 * The generic scrape is held to one rule above all others: it must not know
 * what kind of page it is reading. So these tests never ask "is this a
 * portfolio" — they ask what the page literally said, and whether the shape
 * heuristics kept it or threw it away.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

const PORTFOLIO_URL = "https://studiomarrow.example/people/rowan-ellis?ref=directory";

describe("extractPage — the list discriminator", () => {
  /*
    This is the bug the whole change exists to fix. `collectProseBlocks` keeps
    an `li` only when it is 60+ characters with low link density, so a skills
    list — every item a single word — was discarded before the model ever saw
    it. The fixture puts a link-only list and a link-free list side by side,
    both plain `<ul>`s in `<main>`: neither `<nav>` removal nor the junk
    class/id pattern touches either one, so link density is the ONLY thing that
    can tell them apart.
  */
  const result = extractPage({
    html: loadFixture("portfolio-page.html"),
    finalUrl: PORTFOLIO_URL,
  });

  it("admits the skills list even though every item is far under 60 characters", () => {
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const skills = result.scrape.lists.find((list) => list.headingBefore === "Skills");
    expect(skills).toBeDefined();
    expect(skills?.items).toEqual([
      "TypeScript",
      "React",
      "Design systems",
      "Accessibility auditing",
      "Motion prototyping",
    ]);
    /*
      The exact condition today's prose collector fails: all of them are short.
    */
    for (const item of skills?.items ?? []) {
      expect(item.length).toBeLessThan(60);
    }
  });

  it("rejects the link-only list, on its density rather than its markup", () => {
    if (!result.isOk) throw new Error("expected success");
    const admittedItems = result.scrape.lists.flatMap((list) => list.items);
    for (const navItem of ["Work", "Writing", "Speaking", "Contact"]) {
      expect(admittedItems).not.toContain(navItem);
    }
    /*
      And it did not sneak into the prose channel either.
    */
    const blockText = result.scrape.blocks.map((block) => block.text).join(" ");
    expect(blockText).not.toContain("Speaking");
  });

  it("carries the link density through so the admission is auditable", () => {
    if (!result.isOk) throw new Error("expected success");
    const skills = result.scrape.lists.find((list) => list.headingBefore === "Skills");
    const projects = result.scrape.lists.find((list) => list.headingBefore === "Selected work");
    expect(skills?.linkDensity).toBe(0);
    /*
      A list of linked project names with prose after each one is still content.
    */
    expect(projects?.linkDensity).toBeGreaterThan(0);
    expect(projects?.linkDensity).toBeLessThan(0.5);
  });

  it("does not let an admitted list item appear as a prose block as well", () => {
    if (!result.isOk) throw new Error("expected success");
    const projects = result.scrape.lists.find((list) => list.headingBefore === "Selected work");
    const atlasItem = projects?.items[0];
    expect(atlasItem).toContain("scheduling tool for clinical trials");
    /*
      This item is 60+ chars and link-light, so collectProseBlocks WOULD have
      taken it. It belongs to the list channel now, and only there.
    */
    expect(atlasItem === undefined ? [] : result.scrape.blocks.map((block) => block.text)).not.toContain(
      atlasItem,
    );
  });
});

describe("extractPage — scrape shape", () => {
  const result = extractPage({
    html: loadFixture("portfolio-page.html"),
    finalUrl: PORTFOLIO_URL,
  });

  it("resolves identity from og tags and the canonical link", () => {
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const { scrape } = result;
    expect(scrape.finalUrl).toBe(PORTFOLIO_URL);
    expect(scrape.canonicalUrl).toBe("https://studiomarrow.example/people/rowan-ellis");
    expect(scrape.siteName).toBe("Studio Marrow");
    /*
      The site suffix is stripped from the title, exactly as the article
      extractor strips it.
    */
    expect(scrape.title).toBe("Rowan Ellis — Product Designer");
    expect(scrape.description).toContain("clinical software");
  });

  it("keeps prose blocks in document order", () => {
    if (!result.isOk) throw new Error("expected success");
    const texts = result.scrape.blocks.map((block) => block.text);
    const intro = texts.findIndex((text) => text.startsWith("Rowan Ellis is a product designer"));
    const priorRole = texts.findIndex((text) => text.startsWith("Before Studio Marrow"));
    const skillsHeading = texts.indexOf("Skills");
    const workHeading = texts.indexOf("Selected work");
    const closing = texts.findIndex((text) => text.startsWith("Rowan writes occasionally"));
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(priorRole).toBeGreaterThan(intro);
    expect(skillsHeading).toBeGreaterThan(priorRole);
    expect(workHeading).toBeGreaterThan(skillsHeading);
    expect(closing).toBeGreaterThan(workHeading);
  });

  it("flattens @graph into structuredData with no type filter at all", () => {
    if (!result.isOk) throw new Error("expected success");
    const types = result.scrape.structuredData.flatMap((node) => {
      const nodeType = node["@type"];
      return typeof nodeType === "string" ? [nodeType] : [];
    });
    /*
      Person and Organization come out of the @graph; Product comes from a
      second script and is kept precisely because nothing filters by type.
    */
    expect(types).toContain("Person");
    expect(types).toContain("Organization");
    expect(types).toContain("Product");
  });

  it("absolutizes a relative image src against the final URL", () => {
    if (!result.isOk) throw new Error("expected success");
    const urls = result.scrape.imageCandidates.map((candidate) => candidate.sourceUrl);
    expect(urls).toContain("https://studiomarrow.example/media/rowan-social-card.png");
    expect(urls).toContain("https://studiomarrow.example/media/rowan-portrait.jpg");
    for (const url of urls) {
      expect(url.startsWith("https://")).toBe(true);
    }
  });

  it("reports nothing was dropped when the page fits the budget", () => {
    if (!result.isOk) throw new Error("expected success");
    expect(result.scrape.isTruncated).toBe(false);
  });
});

const IMAGE_PAGE_URL = "https://harbourlab.example/notes/2026/tides";

const IMAGE_PAGE_HTML = `<!doctype html>
<html><head>
<title>Field notes — Harbour Lab</title>
<meta property="og:site_name" content="Harbour Lab">
<meta property="og:image" content="/social/card.png">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"Field notes",
 "image":"https://cdn.harbourlab.example/ld-hero.jpg"}
</script>
</head><body><main>
<h1>Notes from the harbour wall</h1>
<p>The tide gauge on the east wall has been logging every six minutes since nineteen seventy-one,
   and the paper record for the first eleven years of that is still in a filing cabinet upstairs
   rather than anywhere a computer can reach it.</p>
<img src="/photos/tide-gauge.jpg" alt="The tide gauge housing" width="800" height="600">
<p>Transcribing it took the whole summer and produced one genuinely surprising result about winter
   surge heights that nobody on the team had expected to find in it.</p>
<h2>The second morning</h2>
<p>Low water exposed the full width of the mud flats, which is the only condition under which the
   older timber piles are visible at all from the shore.</p>
<img src="photos/mud.jpg" alt="Mud flats at low water">
<img src="https://cdn.harbourlab.example/crew.jpg" alt="The survey crew" width="400" height="400">
<img srcset="/photos/wide-480.jpg 480w, /photos/wide-1600.jpg 1600w" alt="The estuary at dusk">
</main></body></html>`;

describe("extractPage — image candidates", () => {
  const result = extractPage({ html: IMAGE_PAGE_HTML, finalUrl: IMAGE_PAGE_URL });

  it("numbers every candidate in document order, head before body", () => {
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const { imageCandidates } = result.scrape;
    expect(imageCandidates.map((candidate) => candidate.id)).toEqual([
      "img_1",
      "img_2",
      "img_3",
      "img_4",
      "img_5",
      "img_6",
    ]);
    expect(imageCandidates.map((candidate) => candidate.documentOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(imageCandidates.map((candidate) => candidate.origin)).toEqual([
      "og-image",
      "structured-data",
      "inline",
      "inline",
      "inline",
      "inline",
    ]);
  });

  it("resolves relative and root-relative srcs against the final URL", () => {
    if (!result.isOk) throw new Error("expected success");
    const urlById = new Map(
      result.scrape.imageCandidates.map((candidate) => [candidate.id, candidate.sourceUrl]),
    );
    expect(urlById.get("img_1")).toBe("https://harbourlab.example/social/card.png");
    expect(urlById.get("img_2")).toBe("https://cdn.harbourlab.example/ld-hero.jpg");
    expect(urlById.get("img_3")).toBe("https://harbourlab.example/photos/tide-gauge.jpg");
    /*
      Document-relative, so it resolves against the directory, not the root.
    */
    expect(urlById.get("img_4")).toBe("https://harbourlab.example/notes/2026/photos/mud.jpg");
  });

  it("reads dimensions from the tag's own attributes, and claims none when absent", () => {
    if (!result.isOk) throw new Error("expected success");
    const byId = new Map(
      result.scrape.imageCandidates.map((candidate) => [candidate.id, candidate]),
    );
    expect(byId.get("img_3")?.width).toBe(800);
    expect(byId.get("img_3")?.height).toBe(600);
    expect(byId.get("img_5")?.width).toBe(400);
    expect(byId.get("img_5")?.height).toBe(400);
    expect(byId.get("img_4")?.width).toBeUndefined();
    expect(byId.get("img_4")?.height).toBeUndefined();
    /*
      Aspect is a hint drawn from those attributes, never a probe.
    */
    expect(byId.get("img_5")?.hints).toContain("square");
    expect(byId.get("img_3")?.hints).toContain("wide");
  });

  it("takes the largest entry of a srcset when there is no src", () => {
    if (!result.isOk) throw new Error("expected success");
    const estuary = result.scrape.imageCandidates.find(
      (candidate) => candidate.alt === "The estuary at dusk",
    );
    expect(estuary?.sourceUrl).toBe("https://harbourlab.example/photos/wide-1600.jpg");
  });

  it("attributes each inline image to the heading above it", () => {
    if (!result.isOk) throw new Error("expected success");
    const byId = new Map(
      result.scrape.imageCandidates.map((candidate) => [candidate.id, candidate]),
    );
    expect(byId.get("img_3")?.nearestHeading).toBe("Notes from the harbour wall");
    expect(byId.get("img_4")?.nearestHeading).toBe("The second morning");
    expect(byId.get("img_5")?.nearestHeading).toBe("The second morning");
    /*
      Nothing precedes a head-level tag, so nothing is claimed for it.
    */
    expect(byId.get("img_1")?.nearestHeading).toBeUndefined();
  });

  it("captures a bounded window of the page's own words around an inline image", () => {
    if (!result.isOk) throw new Error("expected success");
    const byId = new Map(
      result.scrape.imageCandidates.map((candidate) => [candidate.id, candidate]),
    );
    const surroundingText = byId.get("img_3")?.surroundingText ?? "";
    expect(surroundingText).toContain("filing cabinet upstairs");
    expect(surroundingText).toContain("Transcribing it took the whole summer");
    expect(surroundingText.length).toBeLessThanOrEqual(200);
    /*
      The tag's own attributes are not "surrounding text".
    */
    expect(surroundingText).not.toContain("tide-gauge.jpg");
    expect(surroundingText).not.toContain("alt=");
    /*
      A meta tag in <head> has no prose around it, so it gets none.
    */
    expect(byId.get("img_1")?.surroundingText).toBeUndefined();
  });

  it("keeps the portrait pattern as a hint that decides nothing", () => {
    const portraitResult = extractPage({
      html: IMAGE_PAGE_HTML.replace("/photos/tide-gauge.jpg", "/photos/headshot-mara.jpg"),
      finalUrl: IMAGE_PAGE_URL,
    });
    if (!portraitResult.isOk) throw new Error("expected success");
    const headshot = portraitResult.scrape.imageCandidates.find((candidate) =>
      candidate.sourceUrl.includes("headshot"),
    );
    expect(headshot?.hints).toContain("portrait-ish");
    /*
      A hint, not a promotion: it keeps its document position and its origin.
    */
    expect(headshot?.origin).toBe("inline");
    expect(headshot?.documentOrder).toBe(3);
  });
});

describe("extractPage — honest refusals", () => {
  /*
    Both refusals must fire on exactly the pages they fire on today, so they are
    tested against the article extractor's own verdict rather than against a
    copy of its wording.
  */
  it("refuses a paywall stub identically to the article extractor", () => {
    const html = loadFixture("paywall-stub.html");
    const finalUrl = "https://harborbusinessjournal.com/ports/merger-talks";
    const pageResult = extractPage({ html, finalUrl });
    const articleResult = extractArticle({ html, finalUrl });
    expect(pageResult).toMatchObject({ isOk: false, reason: "paywalled" });
    if (pageResult.isOk || articleResult.isOk) return;
    expect(pageResult.message).toBe(articleResult.message);
    expect(pageResult.message).toContain("paywall or sign-in");
  });

  it("refuses a nav-heavy index page identically to the article extractor", () => {
    const html = loadFixture("nav-heavy-page.html");
    const finalUrl = "https://www.dailymeridian.com/";
    const pageResult = extractPage({ html, finalUrl });
    const articleResult = extractArticle({ html, finalUrl });
    expect(pageResult).toMatchObject({ isOk: false, reason: "no_main_content" });
    if (pageResult.isOk || articleResult.isOk) return;
    expect(pageResult.message).toBe(articleResult.message);
  });

  it("refuses an empty-ish page rather than returning an empty scrape", () => {
    const result = extractPage({
      html: "<html><body><p>Hello.</p></body></html>",
      finalUrl: "https://example.com/",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
  });
});
