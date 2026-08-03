import { describe, expect, it } from "vitest";
import { createSampleDocument } from "../store/document";
import { renderToHTML } from "./render-to-html";
import { renderToPlainText } from "./render-to-plain-text";
import { createMixedFixture } from "./render.fixtures";

/**
 * The plain-text alternative — the `text/plain` part of the email, and the
 * third view in the studio's preview dialog.
 */

describe("renderToPlainText", () => {
  it("returns the email's words with no HTML around them", async () => {
    const text = await renderToPlainText(createSampleDocument());

    expect(text).toContain("WELCOME TO FLOCK");
    expect(text).toContain("Ready to ride?");
    expect(text).not.toContain("<table");
    expect(text).not.toContain("<td");
    expect(text).not.toContain("style=");
  });

  it("keeps link destinations, which are the whole point of a text alternative", async () => {
    const text = await renderToPlainText(createSampleDocument());

    // A text-only client cannot show a button, so the URL has to survive.
    expect(text).toContain("https://example.com/start");
    expect(text).toContain("https://example.com/docs");
  });

  it("carries no <style> or <head> content into the body text", async () => {
    const text = await renderToPlainText(createMixedFixture());

    expect(text).not.toContain("DOCTYPE");
    expect(text).not.toContain("xmlns");
    expect(text).not.toContain("mso-");
  });

  it("stays in lockstep with the HTML render — same words, different clothes", async () => {
    const document = createMixedFixture();
    const [html, text] = await Promise.all([
      renderToHTML(document),
      renderToPlainText(document),
    ]);
    const lowercaseHtml = html.toLowerCase();

    // Every non-trivial word in the text view must be present in the HTML the
    // same render produced; the two are one email, not two. Compared
    // case-insensitively because headings arrive uppercased — see below.
    const words = text
      .split(/\s+/u)
      .filter((word) => /^[A-Za-z]{5,}$/u.test(word))
      .slice(0, 12);
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(lowercaseHtml).toContain(word.toLowerCase());
    }
  });

  it("uppercases headings, which is how text-only mail marks a heading", async () => {
    // The mixed fixture's h1 is "Spring launch" in the HTML. Plain text has no
    // type scale, so html-to-text shouts headings instead. Pinned because it
    // is surprising, not because it is wrong.
    const document = createMixedFixture();
    const [html, text] = await Promise.all([
      renderToHTML(document),
      renderToPlainText(document),
    ]);

    expect(html).toContain(">Spring launch<");
    expect(text).toContain("SPRING LAUNCH");
  });

  it("produces something a person could actually read", async () => {
    const text = await renderToPlainText(createSampleDocument());

    expect(text.trim().length).toBeGreaterThan(40);
    expect(text).toMatchSnapshot();
  });
});
