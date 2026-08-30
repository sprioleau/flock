/*
  Copy-signal extraction (brand-kit-user-control §5.4) — the deterministic
  raw material behind tone of voice. The failure stance is the point: a page
  with no readable copy reports `hasAnySignal: false`, and the pipeline turns
  that into an ABSENT tone field rather than an invented voice.
*/
import { describe, expect, it } from "vitest";
import { describeCopySignals, extractCopySignals } from "./extract-copy-signals";

const PAGE = `<!doctype html><html><head>
  <title>Acme — Robots</title>
  <meta property="og:description" content="We build robots that get out of your way." />
</head><body>
  <h1>Robots, minus the drama</h1>
  <nav><a class="nav-link" href="/about">About</a></nav>
  <p>Tiny.</p>
  <p>We ship one robot at a time, and we tell you exactly what it costs before you buy.</p>
  <button type="button">Get started</button>
  <a class="btn btn-primary" href="/demo">Book a demo</a>
  <script>const noise = "<p>not copy</p>";</script>
</body></html>`;

describe("extractCopySignals", () => {
  it("reads the author-written description, headline and first real paragraph", () => {
    const signals = extractCopySignals(PAGE);
    expect(signals.description).toBe("We build robots that get out of your way.");
    expect(signals.headline).toBe("Robots, minus the drama");
    /*
      "Tiny." is a caption, not the brand's prose — too short to carry voice.
    */
    expect(signals.firstParagraph).toContain("We ship one robot at a time");
  });

  it("collects button and CTA-classed anchor labels", () => {
    expect(extractCopySignals(PAGE).ctaLabels).toEqual(["Get started", "Book a demo"]);
  });

  it("falls back to <meta name=description> when og:description is absent", () => {
    const signals = extractCopySignals(
      '<html><head><meta name="description" content="Plain description." /></head><body></body></html>',
    );
    expect(signals.description).toBe("Plain description.");
    expect(signals.hasAnySignal).toBe(true);
  });

  it("reports no signal for a page with no copy (→ no tone field, not an invented one)", () => {
    const signals = extractCopySignals("<html><head></head><body><div><img src=x /></div></body></html>");
    expect(signals.hasAnySignal).toBe(false);
    expect(describeCopySignals(signals)).toBeNull();
  });

  it("decodes entities and never leaks markup into the sample", () => {
    const signals = extractCopySignals("<html><body><h1>Tools &amp; <em>toys</em></h1></body></html>");
    expect(signals.headline).toBe("Tools & toys");
  });

  it("renders a prompt block only when there is something to describe", () => {
    const described = describeCopySignals(extractCopySignals(PAGE))!;
    expect(described).toContain("Description: We build robots");
    expect(described).toContain("Button labels: Get started | Book a demo");
  });
});
