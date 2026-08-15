import { z } from "zod";
import {
  createSectionComposer,
  paragraphNode,
  placeholderImageUrl,
  textDocOf,
  textRun,
  type LeafSpec,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `header` — brand bar: logo placeholder left, optional nav links right.
 * Reference pattern: react.email/components "header-with-centered-menu" /
 * "header-with-social-icons" (nested rows flattened to one row).
 */

const navLinkSchema = z
  .strictObject({
    label: z.string().min(1).describe("The visible link text (short, one or two words)."),
    href: z.string().min(1).describe("Link destination: an absolute https:// URL or a merge tag."),
  })
  .describe("One navigation link: label and destination.");

export const headerParamsSchema = z
  .strictObject({
    brandName: z
      .string()
      .min(1)
      .default("Flock")
      .describe("The sender's brand or company name — used for the logo placeholder's alt text."),
    navLinks: z
      .array(navLinkSchema)
      .max(4)
      .default([
        { label: "Shop", href: "https://example.com/shop" },
        { label: "About", href: "https://example.com/about" },
        { label: "Contact", href: "https://example.com/contact" },
      ])
      .describe("Up to 4 navigation links shown right of the logo. Pass [] for a logo-only header."),
  })
  .describe("Header content: brand name and optional navigation links.");

export const headerTemplate = defineSectionTemplate({
  id: "header",
  name: "Header",
  category: "header",
  useWhen:
    "Open the email with brand identity: a slim bar with the logo on the left and a few navigation links on the right.",
  paramsSchema: headerParamsSchema,
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    const logo: LeafSpec = {
      kind: "image",
      src: placeholderImageUrl({ width: 280, height: 80 }),
      alt: `${params.brandName} logo`,
      width: 140,
      align: "left",
    };
    if (params.navLinks.length === 0) {
      composer.addLeaf(logo);
      return composer.finish();
    }
    const navRuns = params.navLinks.flatMap((link, index) => [
      ...(index > 0 ? [textRun("   ·   ")] : []),
      textRun(link.label, [{ type: "link", attrs: { href: link.href } }]),
    ]);
    composer.addColumns([
      { widthPercent: 40, verticalAlign: "middle", leaves: [logo] },
      {
        widthPercent: 60,
        verticalAlign: "middle",
        leaves: [{ kind: "text", text: textDocOf([paragraphNode(navRuns)]), textAlign: "right" }],
      },
    ]);
    return composer.finish();
  },
});
