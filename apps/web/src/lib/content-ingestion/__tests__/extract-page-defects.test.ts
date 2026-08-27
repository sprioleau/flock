import { describe, expect, it } from "vitest";
import { collectProseBlocks, extractPage } from "../extract-page";

/**
 * Regressions for five defects that only a corpus of REAL pages exposed.
 *
 * Every one of these passed against hand-written fixtures and failed against
 * live markup, which is the argument for the corpus: a fixture written by the
 * same person who wrote the rule tests the rule against itself.
 *
 * Each fixture below is distilled from the actual page named in its comment —
 * the markup shape is the site's, not invented for the test.
 */

/*
  Minimum body text needed to clear the no-content gate, so a fixture can test
  ONE defect without also having to be a realistically long page.
*/
function padding(sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, index) =>
      `<p>Sentence number ${index} exists so this fixture clears the readable-content floor without inventing a long page.</p>`,
  ).join("");
}

describe("extractPage — a <header> holding the page's own <h1>", () => {
  /*
    From sprioleau.dev. <header> is the header of the nearest sectioning
    content, not necessarily the site banner, and a portfolio puts the owner's
    name in one. Stripping it deleted the person's name from a page about that
    person — and cost too little text for the ratio guard to catch.
  */
  const html = `<html><head><title>Ada Lovelace</title></head><body><main>
    <header><h1>Ada Lovelace</h1><p>Staff Software Engineer</p></header>
    ${padding(4)}
  </main></body></html>`;

  it("keeps the page's own name as a heading", () => {
    const result = extractPage({ html, finalUrl: "https://ada.example/" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const headings = result.scrape.blocks.filter((block) => block.kind === "heading");
    expect(headings.map((heading) => heading.text)).toContain("Ada Lovelace");
  });

  it("still strips a site banner whose <header> holds no page title", () => {
    const banner = `<html><head><title>Post</title></head><body>
      <header><a href="/">Home</a><a href="/about">About</a></header>
      <main><h1>The post title</h1>${padding(4)}</main>
    </body></html>`;
    const result = extractPage({ html: banner, finalUrl: "https://ada.example/post" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const texts = result.scrape.blocks.map((block) => block.text).join(" ");
    expect(texts).not.toContain("Home");
  });
});

describe("extractPage — an <aside> that wraps the whole page", () => {
  /*
    From the University of Washington faculty page, which is built with a page
    builder that puts the ENTIRE profile inside <aside>. Removing it left 7
    characters of a 1,856-character scope and the page was refused for having
    no readable content.
  */
  it("keeps content a mismarked <aside> wraps", () => {
    const html = `<html><head><title>Prof</title></head><body><main>
      <aside><h2>Biography</h2>${padding(5)}</aside>
    </main></body></html>`;
    const result = extractPage({ html, finalUrl: "https://uni.example/faculty/prof" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.scrape.blocks.length).toBeGreaterThan(1);
  });

  it("still strips an <aside> that is a genuine sidebar", () => {
    const html = `<html><head><title>Post</title></head><body><main>
      <h1>The post</h1>${padding(5)}
      <aside><p>Related: some other thing entirely worth reading later on.</p></aside>
    </main></body></html>`;
    const result = extractPage({ html, finalUrl: "https://uni.example/post" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.scrape.blocks.map((block) => block.text).join(" ")).not.toContain("Related:");
  });
});

describe("collectProseBlocks — prose that cross-links heavily", () => {
  /*
    From sqlite.org, whose opening paragraph links every feature word to the
    page documenting it. It scored 0.501 against a 0.5 cut and was discarded,
    taking the page's entire self-description with it.
  */
  it("admits a paragraph past the density cut when its own words are substantial", () => {
    /*
      Built to land where sqlite.org actually lands — just PAST the 0.5 cut,
      with plenty of the block's own words. A fixture that merely has some
      links sits under the threshold and would pass without the fix, proving
      nothing; the assertion below pins the density so it cannot drift back
      under the cut and go quietly vacuous.
    */
    const linked = [
      "a small self-contained embedded database engine",
      "a fast fully transactional storage layer",
      "a high-reliability zero-configuration design",
      "a full-featured serverless architecture",
      "an extensively verified automated test suite",
      "a public-domain licensing arrangement",
      "a stable long-term file format guarantee",
    ]
      .map((phrase) => `<a href="/docs">${phrase}</a>`)
      .join(", ");
    const own =
      "Widget is a C-language library that implements what the project's own documentation describes as ";
    const tail =
      ", and it is the most widely deployed database engine anywhere in the world today, built into every mobile phone and into most of the desktop computers that people use daily.";
    const html = `<p>${own}${linked}${tail}</p>`;

    const blocks = collectProseBlocks(html);
    expect(blocks.map((block) => block.text).join(" ")).toContain("C-language library");

    /*
      The fixture is only meaningful if it sits where the real page sits: PAST
      the density cut, and carrying enough of its own words to earn admission
      on the second clause. Asserting both stops it drifting back under either
      threshold and passing vacuously.
    */
    const linkTextLength = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].reduce(
      (total, match) => total + match[1].length,
      0,
    );
    const totalTextLength = html.replace(/<[^>]+>/g, "").length;
    expect(linkTextLength / totalTextLength).toBeGreaterThan(0.5);
    expect(totalTextLength - linkTextLength).toBeGreaterThanOrEqual(200);
  });

  it("still rejects a menu, whose own words are only separators", () => {
    const menu = `<p>${["Home", "About", "Docs", "Download", "Support", "Purchase"]
      .map((word) => `<a href="/${word}">${word}</a>`)
      .join(" · ")}</p>`;
    expect(collectProseBlocks(menu)).toHaveLength(0);
  });
});

describe("collectProseBlocks — a heading a later paragraph mentions", () => {
  /*
    The containment de-dup compared across kinds, so any paragraph that
    happened to repeat the heading's words swallowed it. That is the NORMAL
    shape of an identity page: <h1>Name</h1> then "Name is a …".
  */
  it("keeps a heading whose text a following paragraph repeats", () => {
    const html = `<h1>Ada Lovelace</h1><p>Ada Lovelace is a mathematician who writes about analytical engines and their uses.</p>`;
    const blocks = collectProseBlocks(html);
    expect(blocks.filter((block) => block.kind === "heading")).toHaveLength(1);
  });

  it("still de-dups a paragraph repeated inside a blockquote", () => {
    const repeated = "The same sentence appears twice because a widget duplicated the teaser copy.";
    const html = `<p>${repeated}</p><blockquote><p>${repeated}</p></blockquote>`;
    expect(collectProseBlocks(html)).toHaveLength(1);
  });
});

describe("extractPage — the no-content gate counts recovered lists", () => {
  /*
    The gate counted prose only, so a page whose content is short list items —
    precisely the content the list channel was added to recover — was refused
    AFTER being read successfully.
  */
  it("accepts a page whose content is mostly a genuine list", () => {
    const items = [
      "Harbour and dockside photography",
      "Working portraits on location",
      "Long-exposure night work",
      "Editorial assignments",
      "Archival scanning and restoration",
      "Print production and framing",
    ]
      .map((item) => `<li>${item}</li>`)
      .join("");
    const html = `<html><head><title>Studio</title></head><body><main>
      <h1>What we do</h1><p>A short line of prose, and then the actual content.</p>
      <ul>${items}</ul><ul>${items}</ul>
    </main></body></html>`;
    const result = extractPage({ html, finalUrl: "https://studio.example/" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.scrape.lists.length).toBeGreaterThan(0);
  });

  it("still refuses a page that is a list of links and nothing else", () => {
    const links = Array.from(
      { length: 40 },
      (_, index) => `<li><a href="/item-${index}">Some linked resource number ${index}</a></li>`,
    ).join("");
    const html = `<html><head><title>Resources</title></head><body><main>
      <h1>Resources</h1><p>Things we found useful.</p><ul>${links}</ul>
    </main></body></html>`;
    const result = extractPage({ html, finalUrl: "https://library.example/resources" });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
  });
});

describe("extractPage — a canonical URL on another site", () => {
  /*
    From sprioleau.dev, where a stale build left both the canonical and the
    og:image pointing at a long-dead preview deployment on another domain, so
    every attribution link would have sent readers to a preview build.
  */
  const body = `<main><h1>The page</h1>${padding(4)}</main>`;

  it("ignores a canonical whose host is a different site", () => {
    const html = `<html><head><title>T</title>
      <link rel="canonical" href="https://project-abc123-team.vercel.app/"></head>
      <body>${body}</body></html>`;
    const result = extractPage({ html, finalUrl: "https://www.realsite.example/" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.scrape.canonicalUrl).toBe("https://www.realsite.example/");
  });

  it("honours a canonical that differs only by subdomain", () => {
    const html = `<html><head><title>T</title>
      <link rel="canonical" href="https://realsite.example/page"></head>
      <body>${body}</body></html>`;
    const result = extractPage({ html, finalUrl: "https://www.realsite.example/page" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.scrape.canonicalUrl).toBe("https://realsite.example/page");
  });
});
