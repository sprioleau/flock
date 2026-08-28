import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPage } from "../extract-page";
import type { ImageCandidate } from "../page-scrape";

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

/*
  Verbatim markup from https://www.sprioleau.dev/ — the first two of the five
  entries in its "Selected Work" list, with only the inline <svg> icons
  dropped. The five project screenshots on that page are not <img> tags at all:
  each is a CSS background painted by an inline style= on the anchor that links
  to the project. An <img>-only collector recovers none of them, which on that
  page is every picture the page has of its own work.
*/
const CSS_BACKGROUND_PAGE_URL = "https://www.sprioleau.dev/";

const CSS_BACKGROUND_PAGE_HTML = `<!doctype html>
<html><head><title>San&#x27;Quan Prioleau</title></head><body><main>
<h1>San&#x27;Quan Prioleau</h1>
<p>A staff software engineer who builds collaborative tools for the web, and writes about the
   parts of that work which turn out to generalise beyond the product they were built for.</p>
<section class="section work"><div id="work" class="marker"></div><div class="container"><header class="section-header"><h2 class="section-header__title">Selected Work</h2><div class="section-header__accent-line"></div></header><div class="work__main-content"><div class="selected-work"><ul class="selected-work__works"><li class="selected-work__work"><div class="selected-work__image"><a href="https://flockto.email" class="button selected-work__link" target="_blank" rel="noreferrer" style="background-image:url(https://cdn.sanity.io/images/76u9ka0u/production/fb02babb8db5bb14dff885594eb0ef43df8737f2-1200x630.png?rect=40,0,1120,630&amp;w=800&amp;h=450&amp;fm=webp);background-size:cover"><span>Flock</span></a></div><div class="selected-work__details"><h3 class="selected-work__title">Flock</h3><p class="selected-work__description"><span>A collaborative email editor for humans and AI agents with presence sensing, live cursors, next edit suggestions and customizable agents improving the content as co-capable partners.</span></p><div class="selected-work__meta"><ul class="selected-work__tags"><li class="selected-work__tag"><p>Next.js</p></li><li class="selected-work__tag"><p>Resend</p></li><li class="selected-work__tag"><p>React Email</p></li><li class="selected-work__tag"><p>Vercel AI SDK</p></li></ul></div></div></li><li class="selected-work__work"><div class="selected-work__image"><a href="https://dobblego.sprioleau.dev" class="button selected-work__link" target="_blank" rel="noreferrer" style="background-image:url(https://cdn.sanity.io/images/76u9ka0u/production/9074a947b66e538c6a67290859fcb9e85f34d95b-1200x630.png?rect=40,0,1120,630&amp;w=800&amp;h=450&amp;fm=webp);background-size:cover"><span>Dobble Go</span></a></div><div class="selected-work__details"><h3 class="selected-work__title">Dobble Go</h3><p class="selected-work__description"><span>Dobble Go is a shape recognition game based on the popular game &quot;Dobble&quot; (aka &quot;Spot it&quot;). It features a playful design aesthetic and several ways to customize gameplay for kids.</span></p><div class="selected-work__meta"><ul class="selected-work__tags"><li class="selected-work__tag"><p>Next.js</p></li><li class="selected-work__tag"><p>React</p></li><li class="selected-work__tag"><p>TypeScript</p></li></ul></div></div></li></ul></div></div></div></section>
</main></body></html>`;

describe("extractPage — a picture the page paints with CSS", () => {
  const result = extractPage({
    html: CSS_BACKGROUND_PAGE_HTML,
    finalUrl: CSS_BACKGROUND_PAGE_URL,
  });

  it("recovers a screenshot carried by an inline background-image", () => {
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const backgrounds = result.scrape.imageCandidates.filter(
      (candidate) => candidate.origin === "css-background",
    );
    expect(backgrounds.map((candidate) => candidate.sourceUrl)).toEqual([
      "https://cdn.sanity.io/images/76u9ka0u/production/fb02babb8db5bb14dff885594eb0ef43df8737f2-1200x630.png?rect=40,0,1120,630&w=800&h=450&fm=webp",
      "https://cdn.sanity.io/images/76u9ka0u/production/9074a947b66e538c6a67290859fcb9e85f34d95b-1200x630.png?rect=40,0,1120,630&w=800&h=450&fm=webp",
    ]);
  });

  it("names each screenshot after its own project, not the one above it", () => {
    if (!result.isOk) throw new Error("expected success");
    const [flock, dobble] = result.scrape.imageCandidates.filter(
      (candidate) => candidate.origin === "css-background",
    );
    /*
      This page puts each picture ABOVE the title it belongs to, so the heading
      that precedes a work item's image link is the PREVIOUS item's title. Read
      that way, every screenshot after the first arrives labelled with the wrong
      project — and `nearestHeading` is the only context that reaches the model,
      so a wrong one is worse than none at all. The element carrying the
      background is what the background belongs to, and it labels itself.
    */
    expect(flock.nearestHeading).toBe("Flock");
    expect(dobble.nearestHeading).toBe("Dobble Go");
    expect(flock.surroundingText).toContain("A collaborative email editor");
    expect(dobble.surroundingText).toContain("shape recognition game");
  });

  /*
    A background carries no `alt`, so the element it sits on is all there is to
    read it by. `<img>` draws its hints from class, id, alt and the image URL;
    here the anchor's destination joins them, because where a picture links to
    is the nearest thing a link-shaped element has to a description of itself.
    Still hints, still deciding nothing.
  */
  it.each([
    ["a class on the element", `class="button selected-work__link avatar"`],
    ["the destination it links to", `href="https://flockto.email/team/headshot"`],
  ])("reads %s as a hint about the picture", (_label, replacement) => {
    const portrait = extractPage({
      html: CSS_BACKGROUND_PAGE_HTML.replace(
        `href="https://flockto.email" class="button selected-work__link"`,
        replacement,
      ),
      finalUrl: CSS_BACKGROUND_PAGE_URL,
    });
    if (!portrait.isOk) throw new Error("expected success");
    const first = portrait.scrape.imageCandidates.find(
      (candidate) => candidate.origin === "css-background",
    );
    expect(first?.hints).toContain("portrait-ish");
  });
});

describe("collectImageCandidates — the shapes a CSS url() comes in", () => {
  function readCssBackgrounds(markup: string): ImageCandidate[] {
    const result = extractPage({
      html: `<html><head><title>Styles</title></head><body><main>
        ${markup}
        <p>The first of four sentences that exist only so this fixture clears the readable-content
           floor without having to be a realistically long page about anything.</p>
        <p>The second of them says as little as the first, at about the same length, for the same
           reason, and neither is what the test is looking at.</p>
        <p>The third is here because the floor is three hundred characters and two sentences of
           this width do not quite reach it on their own.</p>
      </main></body></html>`,
      finalUrl: "https://styles.example/gallery/index.html",
    });
    if (!result.isOk) throw new Error("expected success");
    return result.scrape.imageCandidates.filter(
      (candidate) => candidate.origin === "css-background",
    );
  }

  it("accepts single quotes, double quotes, no quotes, and stray whitespace", () => {
    const candidates = readCssBackgrounds(`
      <div style="background-image: url('https://cdn.example/single.png')"></div>
      <div style="background-image:url(&quot;https://cdn.example/double.png&quot;)"></div>
      <div style="background-image:url(https://cdn.example/bare.png)"></div>
      <div style="background-image : url(  https://cdn.example/spaced.png  ) "></div>
    `);
    expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
      "https://cdn.example/single.png",
      "https://cdn.example/double.png",
      "https://cdn.example/bare.png",
      "https://cdn.example/spaced.png",
    ]);
  });

  it("resolves a relative url against the page, exactly as an <img> src is", () => {
    const candidates = readCssBackgrounds(
      `<div style="background-image:url(../media/hero.jpg)"></div>
       <div style="background-image:url(/media/root.jpg)"></div>`,
    );
    expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
      "https://styles.example/media/hero.jpg",
      "https://styles.example/media/root.jpg",
    ]);
  });

  it("reads every layer of a multi-layer declaration, and the shorthand too", () => {
    const candidates = readCssBackgrounds(
      `<div style="background-image:url(/a.png), url('/b.png')"></div>
       <div style="background:#fff url(/c.png) no-repeat center / cover"></div>`,
    );
    expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
      "https://styles.example/a.png",
      "https://styles.example/b.png",
      "https://styles.example/c.png",
    ]);
  });

  it("offers nothing for a data: URI, a gradient, or a property that is not a background", () => {
    const candidates = readCssBackgrounds(`
      <div style="background-image:url(data:image/svg+xml;base64,PHN2Zy8+)"></div>
      <div style="background-image:linear-gradient(rgba(0,0,0,.6),rgba(0,0,0,.6))"></div>
      <div style="background-color:#fff;background-size:cover"></div>
      <div style="mask-image:url(/mask.png);list-style-image:url(/bullet.png)"></div>
    `);
    expect(candidates).toEqual([]);
  });

  it("keeps a data: layer from hiding the real picture beside it", () => {
    const candidates = readCssBackgrounds(
      `<div style="background-image:url(data:image/svg+xml;base64,PHN2Zy8+), url(/real.png)"></div>`,
    );
    expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
      "https://styles.example/real.png",
    ]);
  });

  /*
    A background belongs to the element that carries it, so that element
    describes it better than whatever heading happened to precede it in the
    document. These three cases are the whole rule, and none of them knows what
    kind of page it is looking at.
  */
  it("prefers a heading the element itself contains over the one before it", () => {
    const candidates = readCssBackgrounds(`
      <h2>Reports and briefings</h2>
      <section style="background-image:url(/hero.jpg)">
        <h1>The tide gauge project</h1>
        <p>Eleven years of paper records, and what came out of transcribing them.</p>
      </section>
    `);
    expect(candidates.map((candidate) => candidate.nearestHeading)).toEqual([
      "The tide gauge project",
    ]);
  });

  it("falls back to the element's own label when it contains no heading", () => {
    const candidates = readCssBackgrounds(`
      <h2>Reports and briefings</h2>
      <a href="/projects/atlas" style="background-image:url(/card.jpg)"><span>Atlas Scheduler</span></a>
    `);
    expect(candidates.map((candidate) => candidate.nearestHeading)).toEqual(["Atlas Scheduler"]);
  });

  it("falls back to the heading before it when the element labels itself with neither", () => {
    const candidates = readCssBackgrounds(`
      <h2>Reports and briefings</h2>
      <div style="background-image:url(/texture.jpg)"></div>
      <div style="background-image:url(/wall.jpg)"><p>A caption long enough that it is plainly a
        sentence about the picture rather than a name for it, which is the line a label has to stay
        on the short side of.</p></div>
    `);
    expect(candidates.map((candidate) => candidate.nearestHeading)).toEqual([
      "Reports and briefings",
      "Reports and briefings",
    ]);
  });

  /*
    Only what the page actually rendered. A stylesheet is out of scope because
    resolving it needs a second fetch, and markup parked in a <script> was
    never rendered at all — sprioleau.dev ships its whole work list a second
    time that way, so reading scripts would double every candidate on it.
  */
  it("reads inline style attributes only — never a stylesheet or a script payload", () => {
    const candidates = readCssBackgrounds(`
      <style>.hero { background-image: url(/from-stylesheet.png); }</style>
      <script type="text/template"><div style="background-image:url(/from-script.png)"></div></script>
      <div style="background-image:url(/from-attribute.png)"></div>
    `);
    expect(candidates.map((candidate) => candidate.sourceUrl)).toEqual([
      "https://styles.example/from-attribute.png",
    ]);
  });
});

describe("extractPage — honest refusals", () => {
  /*
    These two used to assert parity with the article extractor's verdict, which
    was the right check while both existed and the risk was drift during the
    migration. That extractor is gone, so the refusals are asserted directly.

    The messages are checked for being TYPE-NEUTRAL, because one reader now
    serves every kind of page: telling someone their portfolio contains no
    readable "article" is both wrong and confusing, and the old copy said
    exactly that.
  */
  it("refuses a paywall stub", () => {
    const result = extractPage({
      html: loadFixture("paywall-stub.html"),
      finalUrl: "https://harborbusinessjournal.com/ports/merger-talks",
    });
    expect(result).toMatchObject({ isOk: false, reason: "paywalled" });
    if (result.isOk) return;
    expect(result.message).toContain("paywall or sign-in");
    expect(result.message).not.toMatch(/\barticle\b|\bstory\b/i);
  });

  it("refuses a nav-heavy index page", () => {
    const result = extractPage({
      html: loadFixture("nav-heavy-page.html"),
      finalUrl: "https://www.dailymeridian.com/",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
    if (result.isOk) return;
    expect(result.message).toContain("readable content");
    expect(result.message).not.toMatch(/\barticle\b|\bstory\b/i);
  });

  it("refuses an empty-ish page rather than returning an empty scrape", () => {
    const result = extractPage({
      html: "<html><body><p>Hello.</p></body></html>",
      finalUrl: "https://example.com/",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
  });
});
