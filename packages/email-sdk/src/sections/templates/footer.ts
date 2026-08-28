import { z } from "zod";
import type { TextMark } from "../../schema/text";
import { createSectionComposer, paragraphNode, textDocOf, textRun } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `footer` — legal footing over a divider: secondary links, company line,
 * and an unsubscribe link, centered in small print. Reference:
 * react.email/components "footer-with-one-column" / "footer-with-two-columns"
 * (flattened). Small print is a fontSize-only textStyle mark — themes own all
 * colors and fonts, so the footer stays theme-native.
 */

const FOOTER_FONT_SIZE_MARK: TextMark = { type: "textStyle", attrs: { fontSize: "12px" } };

const footerLinkSchema = z
  .strictObject({
    label: z.string().min(1).describe("The visible link text (short)."),
    href: z.string().min(1).describe("Link destination: an absolute https:// URL or a merge tag."),
  })
  .describe("One footer link: label and destination.");

export const footerParamsSchema = z
  .strictObject({
    companyName: z
      .string()
      .min(1)
      .default("Flock")
      .describe("The sender's legal company name."),
    address: z
      .string()
      .min(1)
      .default("123 Market Street, Suite 400, San Francisco, CA")
      .describe("The sender's postal address (required by anti-spam law in most regions)."),
    links: z
      .array(footerLinkSchema)
      .max(5)
      .default([
        { label: "Privacy", href: "https://example.com/privacy" },
        { label: "Terms", href: "https://example.com/terms" },
      ])
      .describe("Up to 5 secondary links (privacy, terms, help …). Pass [] for none."),
    unsubscribeHref: z
      .string()
      .min(1)
      .default("*|UNSUB|*")
      .describe('Destination of the unsubscribe link. Defaults to the "*|UNSUB|*" merge tag.'),
  })
  .describe("Footer content: company identity, secondary links, and the unsubscribe destination.");

export const footerTemplate = defineSectionTemplate({
  id: "footer",
  name: "Footer",
  category: "footer",
  useWhen:
    "Close the email with legal footing: company name and address, secondary links, and an unsubscribe link over a divider.",
  paramsSchema: footerParamsSchema,
  /*
    The footer names the sender. The postal address and the unsubscribe merge tag are sending boilerplate the owner configures, not claims invented about a subject.
  */
  contentRequirements: {
    copyParams: ["companyName"],
    listParams: [],
    imageCount: 0,
  },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({ kind: "divider" });

    const paragraphs = [];
    if (params.links.length > 0) {
      paragraphs.push(
        paragraphNode(
          params.links.flatMap((link, index) => [
            ...(index > 0 ? [textRun("   ·   ", [FOOTER_FONT_SIZE_MARK])] : []),
            textRun(link.label, [
              { type: "link", attrs: { href: link.href } },
              FOOTER_FONT_SIZE_MARK,
            ]),
          ]),
        ),
      );
    }
    paragraphs.push(
      paragraphNode([
        textRun(`${params.companyName} · ${params.address}`, [FOOTER_FONT_SIZE_MARK]),
      ]),
      paragraphNode([
        textRun("Unsubscribe", [
          { type: "link", attrs: { href: params.unsubscribeHref } },
          FOOTER_FONT_SIZE_MARK,
        ]),
      ]),
    );

    composer.addLeaf({ kind: "text", text: textDocOf(paragraphs), textAlign: "center" });
    return composer.finish();
  },
});
