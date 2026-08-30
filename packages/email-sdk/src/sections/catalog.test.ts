import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation } from "../operations/apply";
import type { GlobalStyles } from "../schema/globals";
import type { RandomFn } from "../schema/ids";
import type { TextDoc } from "../schema/text";
import { renderToHTML } from "../render/render-to-html";
import { createEmptyDocument, emailDocumentSchema, type EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { getSectionTemplate, SECTION_TEMPLATE_IDS, SECTION_TEMPLATES } from "./catalog";
import { chunkGalleryImages } from "./templates/image-gallery";
import {
  SECTION_CATEGORIES,
  getContentRequirements,
  getPreviewParams,
  type SectionTemplate,
} from "./types";

/*
  Deterministic LCG so ids (and therefore HTML snapshots) are stable.
*/
function createSeededRandom(seed = 7): RandomFn {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/*
  The params the CATALOG GALLERY builds from: a template's sample copy, plus
  the sample values for the params that deliberately carry no default (a
  button's destination, a nav bar, a postal address). Every test below that
  asks what a template LOOKS like builds this way — which is why undefaulting
  those params left the HTML snapshots byte-identical.
*/
function parseDemoParams(
  template: SectionTemplate,
  overrides: Record<string, unknown> = {},
): unknown {
  return template.paramsSchema.parse({ ...getPreviewParams(template), ...overrides });
}

/*
  Build a template with default params into an empty document.
*/
function scaffoldIntoEmptyDocument(template: SectionTemplate, seed = 7): EmailDocument {
  const params: unknown = parseDemoParams(template, {});
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

/*
  Theme fixtures mirroring the app's Classic Light / Midnight brand-kit
  variations — the theme-native contract: the SAME scaffolded section must
  take ALL its colors/fonts from whichever globals the document carries.
*/
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

/*
  Property keys the templates must NEVER emit — themes own these.
*/
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
      /*
        One crisp sentence: a single terminal period.
      */
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
      const params: unknown = parseDemoParams(template, {});
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
                /*
                  fontSize-only textStyle marks are allowed (structural small
                  print); colors and font families belong to the theme.
                */
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
      const params: unknown = parseDemoParams(template, {});
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
      /*
        The dark render must carry ZERO of the light theme's palette and
        vice versa — proof that no color was baked into the scaffold.
      */
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
      params: parseDemoParams(header, { brandName: "Northwind", navLinks: [] }),
      random: createSeededRandom(),
    });
    expect(logoOnly.children).toHaveLength(1);
    expect(logoOnly.children[0]!.type).toBe("image");
    expect((logoOnly.children[0] as { properties: { alt: string } }).properties.alt).toBe(
      "Northwind logo",
    );

    const withNav = header.build({
      params: parseDemoParams(header, {}),
      random: createSeededRandom(),
    });
    const columns = withNav.children.filter((block) => block.type === "column");
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([40, 60]);
  });

  it("article: image appears only when imageAlt is given", () => {
    const article = getSectionTemplate("article")!;
    const withoutImage = article.build({
      params: parseDemoParams(article, {}),
      random: createSeededRandom(),
    });
    expect(withoutImage.children.some((block) => block.type === "image")).toBe(false);

    const withImage = article.build({
      params: parseDemoParams(article, { imageAlt: "Team photo" }),
      random: createSeededRandom(),
    });
    expect(withImage.children.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("feature-columns: column count follows the features given (2 and 4)", () => {
    const featureColumns = getSectionTemplate("feature-columns")!;
    for (const count of [2, 4]) {
      const built = featureColumns.build({
        params: parseDemoParams(featureColumns, {
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
      params: parseDemoParams(gallery, {
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
      params: parseDemoParams(footer, {}),
      random: createSeededRandom(),
    });
    expect(JSON.stringify(built.children)).toContain("*|UNSUB|*");
    expect(built.children.some((block) => block.type === "divider")).toBe(true);
  });

  it("header-centered: logo-only when navLinks is empty; stacked centered leaves (no columns) otherwise", () => {
    const headerCentered = getSectionTemplate("header-centered")!;
    const logoOnly = headerCentered.build({
      params: parseDemoParams(headerCentered, { navLinks: [] }),
      random: createSeededRandom(),
    });
    expect(logoOnly.children).toHaveLength(1);
    expect(logoOnly.children[0]!.type).toBe("image");

    const withNav = headerCentered.build({
      params: parseDemoParams(headerCentered, {}),
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
      params: parseDemoParams(heroSplit, {}),
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
      params: parseDemoParams(featureList, {}),
      random: createSeededRandom(),
    });
    /*
      3 default features → text, divider, text, divider, text.
    */
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
      params: parseDemoParams(cta, {}),
      random: createSeededRandom(),
    });
    expect(built.children.map((block) => block.type)).toEqual(["text", "spacer", "button"]);
  });

  it("product: 45/55 split with a bold display price and a buy button", () => {
    const product = getSectionTemplate("product")!;
    const built = product.build({
      params: parseDemoParams(product, { price: "€39.90" }),
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
      params: parseDemoParams(pricing, { features: ["Everything", "And more"] }),
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
      params: parseDemoParams(codeSample, { language: "python", code: "print('hi')" }),
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
        params: parseDemoParams(testimonialColumns, {
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
      params: parseDemoParams(footerSocial, {}),
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
      params: parseDemoParams(footerDetailed, {}),
      random: createSeededRandom(),
    });
    const columns = built.children.filter((block) => block.type === "column");
    expect(columns.map((column) => column.properties.widthPercent)).toEqual([60, 40]);
    const serialized = JSON.stringify(built.children);
    expect(serialized).toContain("*|UNSUB|*");
    expect(serialized).toContain("*|UPDATE_PROFILE|*");
  });
});

/*
  THE SECOND HALF OF THE FABRICATION FIX.

  `contentRequirements` stops a section being KEPT on the strength of its own
  sample copy, and it deliberately does not require the chrome: requiring a
  postal address or a button label would drop nearly every hero and every
  footer, and a footer carries the unsubscribe link.

  So the chrome takes the other route. A param that names a PLACE — a
  destination to click through to, a street to post a letter to — carries no
  default at all, and `build` renders that element only when the caller
  supplied one. A hero nobody gave a call to action shows no button; a footer
  nobody gave an address shows no address line. Nothing is invented, and
  nothing legally required is dropped.

  The two literals below are the shipped incident itself: a footer naming a
  street nobody occupies, and a button pointing at a domain nobody owns.
*/
const SAMPLE_POSTAL_ADDRESS = "123 Market Street";
const UNOWNED_DESTINATION_DOMAIN = "example.com";

/*
  ONE INSTANCE IS KNOWINGLY STILL STANDING, and it is named here rather than
  quietly left out of the sweep below.

  Both header variants default `navLinks` to three example.com destinations —
  the same defect. Undefaulting it was tried and reverted on evidence: with no
  links to show, `header` and `header-centered` emit the same blocks, and
  createDraft's guarantee that several drafts in one call are genuinely
  different collapsed to two drafts separated only by the logo's alignment.
  The nav bar needs diversification to gain another axis to vary before its
  default can go, which is a different piece of work.
*/
const TEMPLATES_STILL_DEFAULTING_A_DESTINATION: readonly string[] = ["header", "header-centered"];

/*
  Rewrite one sample value into something only the CALLER could have written,
  keeping its shape. Recursing rather than special-casing each list element
  type is what lets the sweep below need no per-template fixture.
*/
function toCallerSuppliedShape(value: unknown, label: string): unknown {
  if (typeof value === "string") {
    return `Caller supplied ${label}`;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => toCallerSuppliedShape(entry, `${label} ${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toCallerSuppliedShape(entry, `${label} ${key}`),
      ]),
    );
  }
  return value;
}

/*
  Exactly the params a real caller had to supply to keep this template, and
  not one more — the shape a composed draft actually reaches `build` with.
*/
function toRequiredParamsOnly(template: SectionTemplate): Record<string, unknown> {
  const sample = z.record(z.string(), z.unknown()).parse(template.paramsSchema.parse({}));
  const requirements = getContentRequirements(template);
  const params: Record<string, unknown> = {};
  for (const copyParam of requirements.copyParams) {
    params[copyParam] = `Caller supplied ${copyParam}`;
  }
  for (const listParam of requirements.listParams) {
    params[listParam.param] = z
      .array(z.unknown())
      .parse(sample[listParam.param])
      .slice(0, listParam.minimumCount)
      .map((entry, index) => toCallerSuppliedShape(entry, `${listParam.param} ${index}`));
  }
  return params;
}

describe("a section built from only the content its caller supplied", () => {
  const sweptTemplates = SECTION_TEMPLATES.filter(
    (template) => !TEMPLATES_STILL_DEFAULTING_A_DESTINATION.includes(template.id),
  );

  it.each(sweptTemplates.map((template) => [template.id, template] as const))(
    "%s: invents no destination and no postal address, and still says the caller's words",
    (_id, template) => {
      const suppliedParams = toRequiredParamsOnly(template);
      const params: unknown = template.paramsSchema.parse(suppliedParams);
      const built = template.build({ params, random: createSeededRandom() });
      const serialized = JSON.stringify([built.section, ...built.children]);

      expect(serialized).not.toContain(UNOWNED_DESTINATION_DOMAIN);
      expect(serialized).not.toContain(SAMPLE_POSTAL_ADDRESS);

      expect(built.children.length).toBeGreaterThan(0);
      for (const value of Object.values(suppliedParams)) {
        if (typeof value === "string") {
          expect(serialized).toContain(value);
        }
      }
    },
  );
});

describe("chrome the caller did not supply is left out, not invented", () => {
  /*
    Build one template from exactly these params, with stable ids.
  */
  function buildFrom(templateId: string, params: Record<string, unknown>) {
    const template = getSectionTemplate(templateId)!;
    const parsed: unknown = template.paramsSchema.parse(params);
    return template.build({ params: parsed, random: createSeededRandom() });
  }

  const HERO_COPY = { headline: "About Wes Bos", body: "Web developer and teacher." };

  it.each([
    ["hero", HERO_COPY],
    ["hero-split", HERO_COPY],
    ["product", { name: "No. 4 smoother", description: "A hand plane.", price: "$210" }],
    ["pricing", { planName: "Pro", price: "$29", pricePeriod: "per month", features: ["One"] }],
  ] as const)("%s: no button at all when the plan named no call to action", (templateId, copy) => {
    const built = buildFrom(templateId, { ...copy });
    expect(built.children.some((block) => block.type === "button")).toBe(false);
    /*
      …and the section is still worth having: its real copy is all there.
    */
    const serialized = JSON.stringify(built.children);
    for (const value of Object.values(copy)) {
      if (typeof value === "string") expect(serialized).toContain(value);
    }
  });

  it.each([
    ["hero", HERO_COPY],
    ["hero-split", HERO_COPY],
    ["product", { name: "No. 4 smoother", description: "A hand plane.", price: "$210" }],
    ["pricing", { planName: "Pro", price: "$29", pricePeriod: "per month", features: ["One"] }],
  ] as const)("%s: renders the button when the caller supplied both halves", (templateId, copy) => {
    const built = buildFrom(templateId, {
      ...copy,
      ctaLabel: "See the plane",
      ctaHref: "https://ashgrove-toolworks.example/planes",
    });
    const button = built.children.find((block) => block.type === "button");
    expect(button).toBeDefined();
    expect(JSON.stringify(button)).toContain("https://ashgrove-toolworks.example/planes");
  });

  it.each(["hero", "hero-split"] as const)(
    "%s: half a call to action is still no button — a label with nowhere to go is a dead button",
    (templateId) => {
      expect(
        buildFrom(templateId, { ...HERO_COPY, ctaLabel: "Get in touch" }).children.some(
          (block) => block.type === "button",
        ),
      ).toBe(false);
      expect(
        buildFrom(templateId, { ...HERO_COPY, ctaHref: "https://wesbos.com" }).children.some(
          (block) => block.type === "button",
        ),
      ).toBe(false);
    },
  );

  it.each(["footer", "footer-social"] as const)(
    "%s: the company line stands alone when no postal address was supplied",
    (templateId) => {
      const params =
        templateId === "footer"
          ? { companyName: "Wes Bos" }
          : { companyName: "Wes Bos", socialLinks: [{ label: "X", href: "https://x.com/wesbos" }] };
      const withoutAddress = JSON.stringify(buildFrom(templateId, params).children);
      expect(withoutAddress).toContain("Wes Bos");
      expect(withoutAddress).not.toContain("·  ");
      expect(withoutAddress).not.toContain("Wes Bos · ");

      const withAddress = JSON.stringify(
        buildFrom(templateId, { ...params, address: "17 Hawthorn Lane, Hamilton ON" }).children,
      );
      expect(withAddress).toContain("Wes Bos · 17 Hawthorn Lane, Hamilton ON");
    },
  );

  it("footer-detailed: no address paragraph when none was supplied, and the columns still stand", () => {
    const params = {
      companyName: "Wes Bos",
      links: [{ label: "Courses", href: "https://wesbos.com/courses" }],
    };
    const built = buildFrom("footer-detailed", params);
    const serialized = JSON.stringify(built.children);
    expect(serialized).not.toContain(SAMPLE_POSTAL_ADDRESS);
    expect(serialized).toContain("Wes Bos");
    expect(serialized).toContain("Courses");
    /*
      The unsubscribe merge tag is legally required chrome and never dropped.
    */
    expect(serialized).toContain("*|UNSUB|*");
    expect(built.children.filter((block) => block.type === "column")).toHaveLength(2);

    const withAddress = JSON.stringify(
      buildFrom("footer-detailed", { ...params, address: "17 Hawthorn Lane" }).children,
    );
    expect(withAddress).toContain("17 Hawthorn Lane");
  });

  it("footer: no secondary-links row when the caller named no links", () => {
    const serialized = JSON.stringify(buildFrom("footer", { companyName: "Wes Bos" }).children);
    expect(serialized).not.toContain("Privacy");
    expect(serialized).not.toContain("Terms");
    /*
      The unsubscribe link is legally required chrome and never dropped.
    */
    expect(serialized).toContain("*|UNSUB|*");
  });

  /*
    The gap, pinned so it cannot widen and cannot be fixed silently. When the
    nav bar's default finally goes, this test fails and its template moves into
    the sweep above — which is exactly the prompt it exists to give.
  */
  it.each(TEMPLATES_STILL_DEFAULTING_A_DESTINATION)(
    "%s: still shows its sample nav bar — the one place a caller-less destination survives",
    (templateId) => {
      const built = buildFrom(templateId, { brandName: "Wes Bos" });
      const serialized = JSON.stringify(built.children);
      expect(serialized).toContain("Wes Bos logo");
      expect(serialized).not.toContain(SAMPLE_POSTAL_ADDRESS);
      /*
        Every surviving destination is a nav link, and nothing else is.
      */
      const destinations = [...serialized.matchAll(/"href":"([^"]*)"/g)].map((match) => match[1]!);
      expect(destinations.length).toBeGreaterThan(0);
      expect(
        destinations.every((href) => href.startsWith(`https://${UNOWNED_DESTINATION_DOMAIN}/`)),
      ).toBe(true);
      /*
        …and the caller can still ask for a header with no nav bar at all.
      */
      expect(buildFrom(templateId, { brandName: "Wes Bos", navLinks: [] }).children).toHaveLength(1);
    },
  );

  it("code-sample: no docs link when the caller pointed at no docs", () => {
    const built = buildFrom("code-sample", {
      headline: "Install it",
      body: "One command.",
      code: "npm i flock",
    });
    expect(built.children.some((block) => block.type === "link")).toBe(false);
    expect(built.children.some((block) => block.type === "code")).toBe(true);

    const withDocs = buildFrom("code-sample", {
      headline: "Install it",
      body: "One command.",
      code: "npm i flock",
      docsLabel: "Read the docs",
      docsHref: "https://wesbos.com/docs",
    });
    expect(withDocs.children.some((block) => block.type === "link")).toBe(true);
  });
});
