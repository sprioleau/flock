import { describe, expect, it } from "vitest";
import { createSampleDocument, type EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { DocumentIntegrityError } from "./errors";
import { renderToHTML } from "./render-to-html";
import { renderToJSON } from "./render-to-json";
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
