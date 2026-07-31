import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import type { GlobalStyles } from "../schema/globals";
import type { RandomFn } from "../schema/ids";
import type { TextDoc } from "../schema/text";
import { renderToHTML } from "../render/render-to-html";
import { createEmptyDocument, emailDocumentSchema, type EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { getSectionTemplate, SECTION_TEMPLATE_IDS, SECTION_TEMPLATES } from "./catalog";
import { chunkGalleryImages } from "./templates/image-gallery";
import { SECTION_CATEGORIES, type SectionTemplate } from "./types";

/** Deterministic LCG so ids (and therefore HTML snapshots) are stable. */
function createSeededRandom(seed = 7): RandomFn {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Build a template with default params into an empty document. */
function scaffoldIntoEmptyDocument(template: SectionTemplate, seed = 7): EmailDocument {
  const params: unknown = template.paramsSchema.parse({});
  const built = template.build({ params, random: createSeededRandom(seed) });
  const result = applyOperation(createEmptyDocument(), {
    name: "addSection",
    section: built.section,
    index: 0,
    children: built.children,
  });
  expect(result.isOk).toBe(true);
  if (!result.isOk) throw new Error("unreachable");
  return result.doc;
}

// Theme fixtures mirroring the app's Classic Light / Midnight brand-kit
// variations — the theme-native contract: the SAME scaffolded section must
// take ALL its colors/fonts from whichever globals the document carries.
const CLASSIC_LIGHT: GlobalStyles = {
  emailBackgroundColor: "#eef1f6",
  contentBackgroundColor: "#ffffff",
  buttonBackgroundColor: "#3730a3",
  buttonTextColor: "#ffffff",
  heading1TextColor: "#111827",
  heading2TextColor: "#111827",
  heading3TextColor: "#111827",
  paragraphTextColor: "#374151",
  linkTextColor: "#3730a3",
  dividerColor: "#e5e7eb",
};

const MIDNIGHT: GlobalStyles = {
  emailBackgroundColor: "#0b1120",
  contentBackgroundColor: "#151c2c",
  buttonBackgroundColor: "#38bdf8",
  buttonTextColor: "#0b1120",
  heading1TextColor: "#f8fafc",
  heading2TextColor: "#f8fafc",
  heading3TextColor: "#f8fafc",
  paragraphTextColor: "#cbd5e1",
  linkTextColor: "#7dd3fc",
  dividerColor: "#2b3548",
};

function withGlobals(doc: EmailDocument, globals: GlobalStyles): EmailDocument {
  const result = applyOperation(doc, { name: "applyTheme", globals });
  expect(result.isOk).toBe(true);
  if (!result.isOk) throw new Error("unreachable");
  return result.doc;
}

/** Property keys the templates must NEVER emit — themes own these. */
const THEME_OWNED_PROPERTY_KEYS = [
  "textColor",
  "backgroundColor",
  "innerBackgroundColor",
  "outerBackgroundColor",
  "color",
  "borderColor",
  "borderRadius",
  "borderSize",
  "fontFamily",
  "horizontalPadding",
  "verticalPadding",
  "thickness",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
] as const;

describe("the section catalog", () => {
  it("ships the eighteen v2 templates, in composition order with variations beside their base", () => {
    expect(SECTION_TEMPLATE_IDS).toEqual([
      "header",
      "header-centered",
      "hero",
      "hero-split",
      "feature-columns",
      "feature-list",
      "article",
      "image-gallery",
      "cta",
      "product",
      "pricing",
      "code-sample",
      "testimonial",
      "testimonial-columns",
      "stats",
      "footer",
      "footer-social",
      "footer-detailed",
    ]);
  });

  it("gives every template a category, a one-sentence useWhen, and a resolvable id", () => {
    for (const template of SECTION_TEMPLATES) {
      expect(SECTION_CATEGORIES).toContain(template.category);
      expect(template.useWhen.trim().length).toBeGreaterThan(20);
      // One crisp sentence: a single terminal period.
      expect(template.useWhen.trim().split(". ")).toHaveLength(1);
      expect(getSectionTemplate(template.id)).toBe(template);
    }
    expect(getSectionTemplate("promo-code")).toBeUndefined();
  });

  it("defaults every params field: parse({}) yields a complete params object", () => {
    for (const template of SECTION_TEMPLATES) {
      expect(template.paramsSchema.safeParse({}).success).toBe(true);
    }
  });
});

describe.each(SECTION_TEMPLATES.map((template) => [template.id, template] as const))(
  "template %s",
  (_id, template) => {
    it("builds a document that passes the full schema and the integrity checker", () => {
      const doc = scaffoldIntoEmptyDocument(template);
      expect(emailDocumentSchema.safeParse(doc).success).toBe(true);
      expect(checkDocumentIntegrity(doc).errors).toEqual([]);
    });

    it("emits only theme-native blocks: no theme-owned property overrides, no color/font marks", () => {
      const params: unknown = template.paramsSchema.parse({});
      const built = template.build({ params, random: createSeededRandom() });
      for (const block of [built.section, ...built.children]) {
        const propertyKeys = Object.keys(block.properties);
        for (const themeOwnedKey of THEME_OWNED_PROPERTY_KEYS) {
          expect(propertyKeys).not.toContain(themeOwnedKey);
        }
        if (block.type === "text") {
          const doc: TextDoc = block.properties.text;
          for (const node of doc.content) {
            for (const inline of node.content ?? []) {
              if (inline.type !== "text") continue;
              for (const mark of inline.marks ?? []) {
                // fontSize-only textStyle marks are allowed (structural small
                // print); colors and font families belong to the theme.
                if (mark.type === "textStyle") {
                  expect(mark.attrs.color).toBeUndefined();
                  expect(mark.attrs.fontFamily).toBeUndefined();
                }
                expect(mark.type).not.toBe("highlight");
              }
            }
          }
        }
      }
    });

    it("gives every image a placehold.co PNG src and non-empty alt text", () => {
      const params: unknown = template.paramsSchema.parse({});
      const built = template.build({ params, random: createSeededRandom() });
      for (const block of built.children) {
        if (block.type !== "image") continue;
        expect(block.properties.src).toMatch(/^https:\/\/placehold\.co\/\d+x\d+\.png$/);
        expect(block.properties.alt.trim().length).toBeGreaterThan(0);
      }
    });

    it("renders default-params HTML that matches its snapshot", async () => {
      const doc = scaffoldIntoEmptyDocument(template);
      const html = await renderToHTML(doc, { isPretty: true });
      expect(html).toMatchSnapshot();
    });

    it("is theme-native: the SAME build restyles fully under Classic Light and Midnight", async () => {
      const doc = scaffoldIntoEmptyDocument(template);
      const lightHtml = await renderToHTML(withGlobals(doc, CLASSIC_LIGHT));
      const darkHtml = await renderToHTML(withGlobals(doc, MIDNIGHT));
      // The dark render must carry ZERO of the light theme's palette and
      // vice versa — proof that no color was baked into the scaffold.
      for (const lightColor of Object.values(CLASSIC_LIGHT)) {
        expect(darkHtml).not.toContain(String(lightColor));
      }
      expect(darkHtml).toContain(MIDNIGHT.contentBackgroundColor as string);
      expect(lightHtml).toContain(CLASSIC_LIGHT.contentBackgroundColor as string);
    });
  },
);

describe("template-specific structure", () => {
  it("header: logo-only when navLinks is empty; 40/60 middle-aligned split otherwise", () => {
    const header = getSectionTemplate("header")!;
    const logoOnly = header.build({
      params: header.paramsSchema.parse({ brandName: "Northwind", navLinks: [] }),
      random: createSeededRandom(),
    });
    expect(logoOnly.children).toHaveLength(1);
    expect(logoOnly.children[0]!.type).toBe("image");
    expect((logoOnly.children[0] as { properties: { alt: string } }).properties.alt).toBe(
      "Northwind logo",
    );

    const withNav = header.build({
      params: header.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    const columns = withNav.children.filter((block) => block.type === "column");
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([40, 60]);
  });

  it("article: image appears only when imageAlt is given", () => {
    const article = getSectionTemplate("article")!;
    const withoutImage = article.build({
      params: article.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    expect(withoutImage.children.some((block) => block.type === "image")).toBe(false);

    const withImage = article.build({
      params: article.paramsSchema.parse({ imageAlt: "Team photo" }),
      random: createSeededRandom(),
    });
    expect(withImage.children.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("feature-columns: column count follows the features given (2 and 4)", () => {
    const featureColumns = getSectionTemplate("feature-columns")!;
    for (const count of [2, 4]) {
      const built = featureColumns.build({
        params: featureColumns.paramsSchema.parse({
          features: Array.from({ length: count }, (_, i) => ({
            title: `Feature ${i + 1}`,
            body: `Why feature ${i + 1} matters.`,
          })),
        }),
        random: createSeededRandom(),
      });
      expect(built.children.filter((block) => block.type === "column")).toHaveLength(count);
    }
  });

  it("image-gallery: chunks 2/3/4/5/6 images into the documented row shapes", () => {
    expect(chunkGalleryImages([1, 2]).map((row) => row.length)).toEqual([2]);
    expect(chunkGalleryImages([1, 2, 3]).map((row) => row.length)).toEqual([3]);
    expect(chunkGalleryImages([1, 2, 3, 4]).map((row) => row.length)).toEqual([2, 2]);
    expect(chunkGalleryImages([1, 2, 3, 4, 5]).map((row) => row.length)).toEqual([3, 2]);
    expect(chunkGalleryImages([1, 2, 3, 4, 5, 6]).map((row) => row.length)).toEqual([3, 3]);

    const gallery = getSectionTemplate("image-gallery")!;
    const built = gallery.build({
      params: gallery.paramsSchema.parse({
        images: Array.from({ length: 4 }, (_, i) => ({ alt: `Look ${i + 1}` })),
      }),
      random: createSeededRandom(),
    });
    expect(built.children.filter((block) => block.type === "row")).toHaveLength(2);
    expect(built.children.filter((block) => block.type === "image")).toHaveLength(4);
  });

  it("footer: unsubscribe defaults to the *|UNSUB|* merge tag", () => {
    const footer = getSectionTemplate("footer")!;
    const built = footer.build({
      params: footer.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    expect(JSON.stringify(built.children)).toContain("*|UNSUB|*");
    expect(built.children.some((block) => block.type === "divider")).toBe(true);
  });

  it("header-centered: logo-only when navLinks is empty; stacked centered leaves (no columns) otherwise", () => {
    const headerCentered = getSectionTemplate("header-centered")!;
    const logoOnly = headerCentered.build({
      params: headerCentered.paramsSchema.parse({ navLinks: [] }),
      random: createSeededRandom(),
    });
    expect(logoOnly.children).toHaveLength(1);
    expect(logoOnly.children[0]!.type).toBe("image");

    const withNav = headerCentered.build({
      params: headerCentered.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    expect(withNav.children.map((block) => block.type)).toEqual(["image", "text"]);
    expect(
      (withNav.children[0] as { properties: { align?: string } }).properties.align,
    ).toBe("center");
  });

  it("hero-split: 55/45 middle-aligned split with the CTA left and the image right", () => {
    const heroSplit = getSectionTemplate("hero-split")!;
    const built = heroSplit.build({
      params: heroSplit.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    const columns = built.children.filter((block) => block.type === "column");
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([55, 45]);
    expect(columns.every((column) => column.properties.verticalAlign === "middle")).toBe(true);
    expect(built.children.some((block) => block.type === "button")).toBe(true);
    expect(built.children.some((block) => block.type === "image")).toBe(true);
  });

  it("feature-list: features stack vertically with dividers between (not around) them", () => {
    const featureList = getSectionTemplate("feature-list")!;
    const built = featureList.build({
      params: featureList.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    // 3 default features → text, divider, text, divider, text.
    expect(built.children.map((block) => block.type)).toEqual([
      "text",
      "divider",
      "text",
      "divider",
      "text",
    ]);
  });

  it("cta: centered text, a spacer for air, and exactly one button", () => {
    const cta = getSectionTemplate("cta")!;
    const built = cta.build({
      params: cta.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    expect(built.children.map((block) => block.type)).toEqual(["text", "spacer", "button"]);
  });

  it("product: 45/55 split with a bold display price and a buy button", () => {
    const product = getSectionTemplate("product")!;
    const built = product.build({
      params: product.paramsSchema.parse({ price: "€39.90" }),
      random: createSeededRandom(),
    });
    const columns = built.children.filter((block) => block.type === "column");
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([45, 55]);
    expect(JSON.stringify(built.children)).toContain("€39.90");
    expect(built.children.some((block) => block.type === "button")).toBe(true);
  });

  it("pricing: one ✓ line per feature and a signup button", () => {
    const pricing = getSectionTemplate("pricing")!;
    const built = pricing.build({
      params: pricing.paramsSchema.parse({ features: ["Everything", "And more"] }),
      random: createSeededRandom(),
    });
    const serialized = JSON.stringify(built.children);
    expect(serialized).toContain("✓  Everything");
    expect(serialized).toContain("✓  And more");
    expect(built.children.some((block) => block.type === "button")).toBe(true);
  });

  it("code-sample: emits a code block with the chosen language and a standalone docs link", () => {
    const codeSample = getSectionTemplate("code-sample")!;
    const built = codeSample.build({
      params: codeSample.paramsSchema.parse({ language: "python", code: "print('hi')" }),
      random: createSeededRandom(),
    });
    const codeBlock = built.children.find((block) => block.type === "code");
    expect(codeBlock).toBeDefined();
    expect((codeBlock as { properties: { language: string } }).properties.language).toBe("python");
    expect(built.children.some((block) => block.type === "link")).toBe(true);
  });

  it("testimonial-columns: one column per quote (2 and 3)", () => {
    const testimonialColumns = getSectionTemplate("testimonial-columns")!;
    for (const count of [2, 3]) {
      const built = testimonialColumns.build({
        params: testimonialColumns.paramsSchema.parse({
          testimonials: Array.from({ length: count }, (_, i) => ({
            quote: `Quote ${i + 1}`,
            attribution: `Person ${i + 1}`,
          })),
        }),
        random: createSeededRandom(),
      });
      expect(built.children.filter((block) => block.type === "column")).toHaveLength(count);
    }
  });

  it("footer-social: social links plus a standalone centered unsubscribe link block", () => {
    const footerSocial = getSectionTemplate("footer-social")!;
    const built = footerSocial.build({
      params: footerSocial.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    const linkBlock = built.children.find((block) => block.type === "link");
    expect(linkBlock).toBeDefined();
    const linkProperties = (linkBlock as { properties: { text: string; href: string; align?: string } })
      .properties;
    expect(linkProperties.text).toBe("Unsubscribe");
    expect(linkProperties.href).toBe("*|UNSUB|*");
    expect(linkProperties.align).toBe("center");
    expect(built.children.some((block) => block.type === "divider")).toBe(true);
  });

  it("footer-detailed: 60/40 columns and both unsubscribe + preferences merge tags", () => {
    const footerDetailed = getSectionTemplate("footer-detailed")!;
    const built = footerDetailed.build({
      params: footerDetailed.paramsSchema.parse({}),
      random: createSeededRandom(),
    });
    const columns = built.children.filter((block) => block.type === "column");
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([60, 40]);
    const serialized = JSON.stringify(built.children);
    expect(serialized).toContain("*|UNSUB|*");
    expect(serialized).toContain("*|UPDATE_PROFILE|*");
  });
});
