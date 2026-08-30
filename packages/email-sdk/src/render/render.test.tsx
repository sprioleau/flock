import { describe, expect, it } from "vitest";
import { createSampleDocument, type EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { DocumentIntegrityError } from "./errors";
import { renderToHTML } from "./render-to-html";
import { renderToJSON } from "./render-to-json";
import { renderToPlainText } from "./render-to-plain-text";
import { renderToReactEmail } from "./render-to-react-email";
import {
  createBlockOverridesOnlyFixture,
  createGlobalsOnlyFixture,
  createMixedFixture,
} from "./render.fixtures";

describe("golden fixtures (plan §1.4: globals-only, overrides-only, mixed)", () => {
  const fixtures: [string, () => EmailDocument][] = [
    ["globals-only", createGlobalsOnlyFixture],
    ["block-overrides-only", createBlockOverridesOnlyFixture],
    ["mixed", createMixedFixture],
    ["sample-document", createSampleDocument],
  ];

  it.each(fixtures)("%s fixture passes the integrity check", (_name, createFixture) => {
    expect(checkDocumentIntegrity(createFixture()).errors).toEqual([]);
  });

  it.each(fixtures)("%s fixture HTML matches its snapshot", async (_name, createFixture) => {
    const html = await renderToHTML(createFixture(), { isPretty: true });
    expect(html).toMatchSnapshot();
  });
});

describe("renderToHTML style resolution end to end", () => {
  it("applies globals when blocks carry no overrides", async () => {
    const html = await renderToHTML(createGlobalsOnlyFixture());
    expect(html).toContain("background-color:#0b0b14"); // emailBackgroundColor on body
    expect(html).toContain("background-color:#f8f7f2"); // contentBackgroundColor as section inner
    expect(html).toContain("max-width:640px"); // contentWidth
    expect(html).toContain("background-color:#e63946"); // buttonBackgroundColor
    expect(html).toContain("border:2px solid #8d0801"); // button border globals
    expect(html).toContain("border-radius:8px"); // imageBorderRadius global on the <img>
    expect(html).toContain("color:#1d3557"); // heading1TextColor
    expect(html).toContain("border-top:1px solid #1d3557"); // dividerColor, default thickness
  });

  it("applies block overrides over renderer defaults", async () => {
    const html = await renderToHTML(createBlockOverridesOnlyFixture());
    expect(html).toContain("background-color:#f4f4f4"); // default email background (no globals)
    expect(html).toContain("background-color:#fff8e7"); // section innerBackgroundColor override
    expect(html).toContain("background-color:#22223b"); // section outerBackgroundColor override
    expect(html).toContain("width:65%"); // column widthPercent
    expect(html).toContain("vertical-align:middle");
    expect(html).toContain("border-top:4px solid #c9ada7"); // divider overrides
    expect(html).toContain("text-align:right"); // button align override
    expect(html).toContain('href="https://example.com/gallery"'); // linked image
    expect(html).toContain("background-color:#dbeafe"); // image block backgroundColor override
    expect(html).toContain("border-radius:16px"); // image corner radius override
    expect(html).toContain("border:2px dashed #22223b"); // image border w/ style + color
    expect(html).toContain("border:3px double #9a8c98"); // button borderStyle override
    expect(html).toContain("background-color:#f2e9e4"); // text block background (callout)
  });

  it("omits image border markup entirely at the defaults", async () => {
    // A document whose images set nothing must render byte-identically to the
    // pre-border renderer: no border-radius, no border shorthand on the <img>.
    const html = await renderToHTML(createMixedFixture());
    const imageTag = /<img[^>]*>/.exec(html)?.[0] ?? "";
    expect(imageTag).not.toBe("");
    expect(imageTag).not.toContain("border-radius");
    // React Email's own Img reset is the only `border` declaration present.
    expect(imageTag).toContain("border:none");
    expect(imageTag).not.toMatch(/border:\d/);
  });

  it("renders the new leaf blocks (link, code, spacer) from globals", async () => {
    const html = await renderToHTML(createGlobalsOnlyFixture());
    // link: linkTextColor global, underlined by default, paragraph font.
    expect(html).toContain('href="https://example.com/newsletter/view"');
    expect(html).toContain("View in browser");
    // code: Prism-highlighted with inline styles, dark theme by default.
    expect(html).toContain("@react-email/render");
    expect(html).toContain("<pre");
    // spacer: fixed-height cell idiom.
    expect(html).toContain("height:24px");
    expect(html).toContain("line-height:24px");
    expect(html).toContain("font-size:1px");
  });

  it("applies the new leaf blocks' overrides (link/code/spacer)", async () => {
    const html = await renderToHTML(createBlockOverridesOnlyFixture());
    expect(html).toContain("color:#8d0801"); // link textColor override
    expect(html).toContain("font-size:18px"); // link fontSize override
    expect(html).toContain("text-decoration:none"); // link isUnderlined: false
    expect(html).toContain("height:48px"); // spacer height
  });

  it("mixed: block overrides beat globals, untouched fields keep globals", async () => {
    const html = await renderToHTML(createMixedFixture());
    expect(html).toContain("background-color:#ffd500"); // button bg override wins
    expect(html).not.toContain("background-color:#0057b7"); // global button bg fully shadowed
    expect(html).toContain("background-color:#00296b"); // section outer override
    expect(html).toContain("color:#00296b"); // heading1TextColor global still applies
  });
});

describe("renderToReactEmail integrity gate", () => {
  it("throws a structured DocumentIntegrityError for a broken document", () => {
    const broken = createSampleDocument();
    delete broken["txt_e5f6"]; // dangling child reference
    let caught: unknown;
    try {
      renderToReactEmail(broken);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocumentIntegrityError);
    const integrityError = caught as DocumentIntegrityError;
    expect(integrityError.errors.length).toBeGreaterThan(0);
    expect(integrityError.errors.map((error) => error.code)).toContain("child_not_found");
  });

  it("renderToJSON throws the same structured error", () => {
    const broken = createSampleDocument();
    delete broken["root"];
    expect(() => renderToJSON(broken)).toThrow(DocumentIntegrityError);
  });
});

describe("subject → <title> and previewText → <Preview>", () => {
  it("renders <title>Welcome</title> in the head when subject is set", async () => {
    const html = await renderToHTML(createSampleDocument(), { subject: "Welcome" });
    expect(html).toContain("<title>Welcome</title>");
  });

  it("renders the hidden preheader when previewText is set", async () => {
    const html = await renderToHTML(createSampleDocument(), {
      previewText: "Sneak peek inside",
    });
    // react-email's <Preview> emits a hidden div carrying the text, tagged so
    // the plain-text pass skips it.
    expect(html).toContain('data-skip-in-text="true"');
    expect(html).toContain("Sneak peek inside");
  });

  it("emits exactly one <title> when subject and previewText are both set", async () => {
    // <Preview> defaults to useTitleTag=true and would stamp a second <title>;
    // subject must remain the single source of the document title.
    const html = await renderToHTML(createSampleDocument(), {
      subject: "The Subject",
      previewText: "The preheader",
    });
    expect((html.match(/<title>/g) ?? []).length).toBe(1);
    expect(html).toContain("<title>The Subject</title>");
    expect(html).toContain("The preheader");
  });

  it.each(["", "   ", "\n\t "])(
    "renders no <title> when subject is empty/whitespace (%j)",
    async (subject) => {
      const html = await renderToHTML(createSampleDocument(), { subject });
      expect(html).not.toContain("<title>");
    },
  );

  it.each(["", "   ", "\n\t "])(
    "renders no <Preview> when previewText is empty/whitespace (%j)",
    async (previewText) => {
      const html = await renderToHTML(createSampleDocument(), { previewText });
      expect(html).not.toContain('data-skip-in-text="true"');
    },
  );

  it("default render is byte-identical whether options are absent or {}", async () => {
    const doc = createSampleDocument();
    const noOptions = await renderToHTML(doc);
    const emptyOptions = await renderToHTML(doc, {});
    expect(emptyOptions).toBe(noOptions);
    // Today's output carries neither a <title> nor a <Preview>.
    expect(noOptions).not.toContain("<title>");
    expect(noOptions).not.toContain('data-skip-in-text="true"');
  });

  it("subject and previewText do not affect the plain-text output", async () => {
    // <title> lives in <head> (dropped by html-to-text) and <Preview> is
    // marked data-skip-in-text, so the text/plain part is unchanged.
    const doc = createSampleDocument();
    const plain = await renderToPlainText(doc);
    const plainWithBoth = await renderToPlainText(doc, {
      subject: "The Subject",
      previewText: "The preheader",
    });
    expect(plainWithBoth).toBe(plain);
    expect(plainWithBoth).not.toContain("The preheader");
  });
});

describe("renderToJSON", () => {
  it("returns the inflated tree with resolved styles attached per node", () => {
    const rendered = renderToJSON(createSampleDocument());
    expect(rendered.block.type).toBe("root");
    expect(rendered.resolvedStyles).toMatchObject({
      emailBackgroundColor: "#f4f4f4",
      contentWidth: 600,
    });

    const heroSection = rendered.children[0]!;
    expect(heroSection.block.id).toBe("sec_a1b2");
    // Section chains inner/outer from the document's globals.
    expect(heroSection.resolvedStyles).toMatchObject({
      innerBackgroundColor: "#ffffff",
      outerBackgroundColor: "#f4f4f4",
    });

    const button = rendered.children[1]!.children[0]!.children[1]!.children[0]!;
    expect(button.block.type).toBe("button");
    // buttonBackgroundColor comes from the sample document's globals.
    expect(button.resolvedStyles).toMatchObject({ backgroundColor: "#1a1a2e" });

    // Every node carries resolvedStyles and children arrays (wire format).
    const walk = (node: typeof rendered): void => {
      expect(node.resolvedStyles).toBeDefined();
      expect(Array.isArray(node.children)).toBe(true);
      node.children.forEach(walk);
    };
    walk(rendered);

    // JSON-serializable end to end.
    expect(() => JSON.stringify(rendered)).not.toThrow();
  });
});
