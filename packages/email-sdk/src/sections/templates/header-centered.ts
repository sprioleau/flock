import { z } from "zod";
import {
  createSectionComposer,
  paragraphNode,
  placeholderImageUrl,
  textDocOf,
  textRun,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `header-centered` — centered brand lockup: the logo on its own line with
 * the navigation links centered beneath it. Reference pattern:
 * react.email/components "header-with-centered-menu" (kept single-column —
 * logo above links — which is the email-safe reading of "centered").
 */

const navLinkSchema = z
  .strictObject({
    label: z.string().min(1).describe("The visible link text (short, one or two words)."),
    href: z.string().min(1).describe("Link destination: an absolute https:// URL or a merge tag."),
  })
  .describe("One navigation link: label and destination.");

export const headerCenteredParamsSchema = z
  .strictObject({
    brandName: z
      .string()
      .min(1)
      .default("Acme")
      .describe("The sender's brand or company name — used for the logo placeholder's alt text."),
    navLinks: z
      .array(navLinkSchema)
      .max(4)
      .default([
        { label: "Shop", href: "https://example.com/shop" },
        { label: "About", href: "https://example.com/about" },
        { label: "Contact", href: "https://example.com/contact" },
      ])
      .describe("Up to 4 navigation links centered under the logo. Pass [] for a logo-only header."),
  })
  .describe("Centered-header content: brand name and optional navigation links.");

export const headerCenteredTemplate = defineSectionTemplate({
  id: "header-centered",
  name: "Centered header",
  category: "header",
  useWhen:
    "Open the email with a centered brand lockup: the logo on its own line with navigation links centered beneath it.",
  paramsSchema: headerCenteredParamsSchema,
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "image",
      src: placeholderImageUrl({ width: 280, height: 80 }),
      alt: `${params.brandName} logo`,
      width: 140,
      align: "center",
    });
    if (params.navLinks.length > 0) {
      const navRuns = params.navLinks.flatMap((link, index) => [
        ...(index > 0 ? [textRun("   ·   ")] : []),
        textRun(link.label, [{ type: "link", attrs: { href: link.href } }]),
      ]);
      composer.addLeaf({
        kind: "text",
        text: textDocOf([paragraphNode(navRuns)]),
        textAlign: "center",
      });
    }
    return composer.finish();
  },
});
