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

  /*
    Code a reader copies out of the text alternative has to RUN. react-email's
    <CodeBlock> separates every Prism token with an invisible pair, which is
    harmless in HTML and arrives intact in the text, so a copied snippet used
    to carry hidden characters between every token and fail on paste.
  */
  it("gives back code a reader can paste and run", async () => {
    const text = await renderToPlainText(createMixedFixture());

    const codeLine = text.split("\n").find((line) => line.includes("@react-email/render"));
    expect(codeLine).toBeDefined();
    expect(codeLine).toContain('import { render } from "@react-email/render";');
  });

  /*
    The strip is the exact ZWJ+ZWSP pair and NOT zero-width characters in
    general, because U+200D is load-bearing: family and profession emoji are
    ZWJ-joined sequences. Blanket-stripping would quietly break any of those
    in the email's own prose, so this pins the emoji surviving the same render
    that cleans the code. U+200D followed by U+200B does not occur in a valid
    emoji sequence, which is what makes the pair safe to target.
  */
  it("leaves a ZWJ emoji in the prose alone while cleaning the code", async () => {
    const familyEmoji = "👨‍👩‍👧";
    const document = createMixedFixture();
    const textBlockId = Object.keys(document).find((id) => document[id]!.type === "text");
    expect(textBlockId).toBeDefined();
    const textBlock = document[textBlockId!]!;
    document[textBlockId!] = {
      ...textBlock,
      properties: {
        ...textBlock.properties,
        text: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: `Our family ${familyEmoji} sends` }] },
          ],
        },
      },
    } as (typeof document)[string];

    const text = await renderToPlainText(document);

    expect(text).toContain(familyEmoji);
    expect(text).not.toContain("‍​");
  });
});
