/**
 * Theme derivation from an ALREADY-FETCHED page — the deterministic path.
 *
 * No model is mocked here because no model is called: every value in a derived
 * theme is a color or a font family the page itself declared. The only I/O is
 * the injected stylesheet fetcher, which every test supplies from a fixture.
 *
 * The two real-page cases at the bottom are the ones this work is judged on.
 * They are VERBATIM excerpts of pages fetched with a plain GET — the same
 * request `fetchPage` makes — because five bugs once sat in the extractor while
 * every hand-written fixture passed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_STYLES } from "@flock/email-sdk";
import { getContrastRatio, MIN_THEME_CONTRAST_RATIO } from "@/lib/brand-kit";
import { derivePageTheme } from "./derive-page-theme";

const FIXTURES_DIR = path.join(__dirname, "__tests__", "fixtures");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

/** A stylesheet fetcher over a fixture table — the pipeline's fetch, offline. */
function fixtureCssFetcher(byUrlSuffix: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const match = Object.entries(byUrlSuffix).find(([suffix]) => url.endsWith(suffix));
    return match === undefined ? null : match[1];
  });
}

function contrastOf({ foreground, background }: { foreground: string; background: string }): number {
  return getContrastRatio({ foreground, background }) ?? 0;
}

describe("derivePageTheme — the accent is the page's own brand color", () => {
  it("prefers a color declared as a brand variable over a library color used just as often", async () => {
    /*
      The measured failure mode on a real page: a component library ships its
      own `:root` palette (toastify's info/success/warning/error), and those
      colors are every bit as vivid as the brand's. Frequency alone does not
      separate them — the brand accent on a small site can be declared once.
      What separates them is the NAME the page gave the color.
    */
    const html = `<!doctype html><html><head><title>Acme</title><style>
      :root{--library-color-info:#3498db;--library-color-error:#e74d3c;--brand-accent:#ffc400;}
      .toast-a{color:var(--library-color-info)} .toast-b{border-color:var(--library-color-info)}
      .toast-c{fill:var(--library-color-info)} .toast-d{outline-color:var(--library-color-info)}
      .toast-e{background:var(--library-color-info)} .toast-f{stroke:var(--library-color-info)}
      .cta{background:var(--brand-accent)}
    </style></head><body><h1>Acme</h1></body></html>`;
    /*
      The library colour is deliberately referenced SIX times to the brand's
      one, so it outranks the accent on the harvest's own vibrancy-boosted
      score. Without the name check this test picks #3498db.
    */
    const theme = await derivePageTheme({ html, finalUrl: "https://acme.test/", fetchCss: null });
    expect(theme).not.toBeNull();
    expect(theme?.globals.buttonBackgroundColor).toBe("#ffc400");
  });

  it("reads a vivid theme-color as the ACCENT and never as the background", async () => {
    /*
      The trap a naive `theme-color → background` rule falls into, and it is
      not hypothetical: wesbos.com/about declares `theme-color: #ffc600`, a
      saturated yellow that is the brand accent. Painting an email's content
      area in it would be unreadable, and the contrast repair would then
      "fix" it by turning the brand color into a near-black.
    */
    const html = `<!doctype html><html><head><title>Vivid</title>
      <meta name="theme-color" content="#ffc600"></head><body><h1>Vivid</h1></body></html>`;
    const theme = await derivePageTheme({ html, finalUrl: "https://vivid.test/", fetchCss: null });
    expect(theme).not.toBeNull();
    expect(theme?.globals.buttonBackgroundColor).toBe("#ffc600");
    expect(theme?.globals.contentBackgroundColor).toBe(DEFAULT_GLOBAL_STYLES.contentBackgroundColor);
  });

  it("reads a muted theme-color as the page's background", async () => {
    const html = `<!doctype html><html><head><title>Deep</title>
      <meta name="theme-color" content="#16032c">
      <style>:root{--brand-accent:#ffc400}.cta{color:var(--brand-accent)}</style>
      </head><body><h1>Deep</h1></body></html>`;
    const theme = await derivePageTheme({ html, finalUrl: "https://deep.test/", fetchCss: null });
    expect(theme?.globals.contentBackgroundColor).toBe("#16032c");
    expect(theme?.globals.buttonBackgroundColor).toBe("#ffc400");
  });
});

describe("derivePageTheme — what it refuses to do", () => {
  it("returns null for a page with no color signal, so the draft keeps the theme it has", async () => {
    const html = `<!doctype html><html><head><title>Bare</title></head>
      <body><h1>Bare</h1><p>Nothing styled here at all.</p></body></html>`;
    const theme = await derivePageTheme({ html, finalUrl: "https://bare.test/", fetchCss: null });
    expect(theme).toBeNull();
  });

  it("still derives a theme when every stylesheet fetch fails", async () => {
    /*
      Auxiliary fetches fail soft (fetchTextResource returns null). A page whose
      palette is inline must not lose its theme because a CDN stylesheet 404ed.
    */
    const html = `<!doctype html><html><head><title>Inline</title>
      <link rel="stylesheet" href="/dead.css">
      <style>:root{--brand-accent:#0f4c81}.cta{color:var(--brand-accent)}</style>
      </head><body><h1>Inline</h1></body></html>`;
    const fetchCss = vi.fn(async () => null);
    const theme = await derivePageTheme({ html, finalUrl: "https://inline.test/", fetchCss });
    expect(fetchCss).toHaveBeenCalled();
    expect(theme?.globals.buttonBackgroundColor).toBe("#0f4c81");
  });

  it("keeps the page's inline theme when the stylesheet fetcher REJECTS", async () => {
    /*
      `harvestBrandSignals` fetches its stylesheets through one Promise.all, so
      a fetcher that rejects (a socket hang-up rather than a 404) would reject
      the whole harvest and cost this page a theme it did not need CSS for.
    */
    const html = `<!doctype html><html><head><title>Angry</title>
      <link rel="stylesheet" href="/boom.css">
      <style>:root{--brand-accent:#0f4c81}.cta{color:var(--brand-accent)}</style>
      </head><body><h1>Angry</h1></body></html>`;
    const fetchCss = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const theme = await derivePageTheme({ html, finalUrl: "https://angry.test/", fetchCss });
    expect(fetchCss).toHaveBeenCalled();
    expect(theme?.globals.buttonBackgroundColor).toBe("#0f4c81");
  });
});

describe("derivePageTheme — the applyTheme contract", () => {
  const html = `<!doctype html><html><head><title>Contract</title>
    <meta name="theme-color" content="#16032c">
    <style>:root{--brand-accent:#ffc400;--ui-text:#b0a7ba}
      .cta{background:var(--brand-accent)}.p{color:var(--ui-text)}
      body{font-family:Quando}</style>
    </head><body><h1>Contract</h1></body></html>`;

  it("emits a COMPLETE globals payload — applyTheme replaces wholesale", async () => {
    const theme = await derivePageTheme({ html, finalUrl: "https://contract.test/", fetchCss: null });
    expect(theme).not.toBeNull();
    const derivedKeys = Object.keys(theme?.globals ?? {}).sort();
    expect(derivedKeys).toEqual(Object.keys(DEFAULT_GLOBAL_STYLES).sort());
  });

  it("keeps every layout key at the renderer default — a theme recolors, never reflows", async () => {
    const theme = await derivePageTheme({ html, finalUrl: "https://contract.test/", fetchCss: null });
    expect(theme?.globals.contentWidth).toBe(DEFAULT_GLOBAL_STYLES.contentWidth);
    expect(theme?.globals.baseSpacing).toBe(DEFAULT_GLOBAL_STYLES.baseSpacing);
    expect(theme?.globals.buttonHorizontalPadding).toBe(DEFAULT_GLOBAL_STYLES.buttonHorizontalPadding);
    expect(theme?.globals.buttonVerticalPadding).toBe(DEFAULT_GLOBAL_STYLES.buttonVerticalPadding);
    /*
      Nothing harvests a button SHAPE, so the radius holds the renderer default
      rather than guessing at one — the same stance expand-variations.ts already
      takes for imageBorderRadius.
    */
    expect(theme?.globals.buttonBorderRadius).toBe(DEFAULT_GLOBAL_STYLES.buttonBorderRadius);
  });

  it("maps the page's own font to the closest email-safe stack", async () => {
    const theme = await derivePageTheme({ html, finalUrl: "https://contract.test/", fetchCss: null });
    /* Quando is a serif; Georgia is the email-safe serif. */
    expect(theme?.globals.heading1FontFamily).toBe("Georgia, 'Times New Roman', serif");
    expect(theme?.globals.paragraphFontFamily).toBe("Georgia, 'Times New Roman', serif");
  });

  it("says which page signals produced the theme", async () => {
    const theme = await derivePageTheme({ html, finalUrl: "https://contract.test/", fetchCss: null });
    expect(theme?.source).toContain("#ffc400");
    expect(theme?.source).toContain("#16032c");
    expect(theme?.source).toContain("Quando");
  });
});

describe("derivePageTheme — real pages, fetched with a plain GET", () => {
  it("picks up sprioleau.dev's deep purple canvas and its yellow accent", async () => {
    const theme = await derivePageTheme({
      html: readFixture("sprioleau-dev.html"),
      finalUrl: "https://www.sprioleau.dev/",
      fetchCss: fixtureCssFetcher({
        "400psvul0_tus.css": readFixture("sprioleau-dev.css"),
        "0mm9vh-r512a0.css": "",
      }),
    });
    expect(theme).not.toBeNull();
    /* --ui-accent-1: #ffc400 — declared once, referenced fifty-one times. */
    expect(theme?.globals.buttonBackgroundColor).toBe("#ffc400");
    /* --ui-bg / theme-color: #16032c — the site really is that dark. */
    expect(theme?.globals.contentBackgroundColor).toBe("#16032c");
    /* A dark canvas must produce LIGHT text, not the default near-black. */
    expect(
      contrastOf({
        foreground: theme?.globals.paragraphTextColor ?? "",
        background: theme?.globals.contentBackgroundColor ?? "",
      }),
    ).toBeGreaterThanOrEqual(MIN_THEME_CONTRAST_RATIO);
    expect(theme?.globals.paragraphTextColor).not.toBe(DEFAULT_GLOBAL_STYLES.paragraphTextColor);
  });

  it("picks up wesbos.com's yellow as an accent and leaves the canvas alone", async () => {
    const theme = await derivePageTheme({
      html: readFixture("wesbos-com.html"),
      finalUrl: "https://wesbos.com/about",
      fetchCss: fixtureCssFetcher({ "_layout-hp_J14D5.css": readFixture("wesbos-com.css") }),
    });
    expect(theme).not.toBeNull();
    /* --yellow: #ffc600, and the same value in theme-color. */
    expect(theme?.globals.buttonBackgroundColor).toBe("#ffc600");
    /*
      The page declares no background variable and its theme-color is the
      accent, so the canvas stays the renderer default rather than being
      painted yellow.
    */
    expect(theme?.globals.contentBackgroundColor).toBe(DEFAULT_GLOBAL_STYLES.contentBackgroundColor);
    /* Yellow fails AA against white, so links are repaired, never shipped broken. */
    expect(
      contrastOf({
        foreground: theme?.globals.linkTextColor ?? "",
        background: theme?.globals.contentBackgroundColor ?? "",
      }),
    ).toBeGreaterThanOrEqual(MIN_THEME_CONTRAST_RATIO);
  });

  it("derives nothing from either real page without its stylesheets — the palette lives in CSS", async () => {
    /*
      MEASURED, and the reason the theme step fetches stylesheets while the
      content pipeline deliberately does not: with `fetchCss: null` both pages
      yield exactly one color (their theme-color) and zero font families. The
      brand IS in the CSS.
    */
    const wesbos = await derivePageTheme({
      html: readFixture("wesbos-com.html"),
      finalUrl: "https://wesbos.com/about",
      fetchCss: null,
    });
    expect(wesbos?.globals.buttonBackgroundColor).toBe("#ffc600");
    expect(wesbos?.globals.paragraphFontFamily).toBe(DEFAULT_GLOBAL_STYLES.paragraphFontFamily);
    const sprioleau = await derivePageTheme({
      html: readFixture("sprioleau-dev.html"),
      finalUrl: "https://www.sprioleau.dev/",
      fetchCss: null,
    });
    /*
      Without CSS the only signal sprioleau.dev gives is its muted theme-color —
      a canvas with nothing to accent it. One colour is not a visual identity,
      so there is no theme to apply and the draft keeps its own.
    */
    expect(sprioleau).toBeNull();
  });
});
