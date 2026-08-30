import { z } from "zod";
import type { TextMark } from "../../schema/text";
import { createSectionComposer, paragraphNode, textDocOf, textRun } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/*
  `footer` — legal footing over a divider: secondary links, company line,
  and an unsubscribe link, centered in small print. Reference:
  react.email/components "footer-with-one-column" / "footer-with-two-columns"
  (flattened). Small print is a fontSize-only textStyle mark — themes own all
  colors and fonts, so the footer stays theme-native.
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
      .optional()
      .describe(
        "The sender's postal address (required by anti-spam law in most regions). There is no default: an address is a legal claim about where the sender is, so an unsupplied one is left OUT of the footer rather than invented, and the sender fills it in.",
      ),
    links: z
      .array(footerLinkSchema)
      .max(5)
      .optional()
      .describe(
        "Up to 5 secondary links (privacy, terms, help …), each with a real destination. Omit for none — there is no default, so links you do not name are not invented.",
      ),
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
    The footer names the sender. The unsubscribe merge tag is sending
    boilerplate the owner configures. The postal address and the secondary
    links are NOT required — requiring either would drop the footer, and a
    dropped footer takes the unsubscribe link with it — so they carry no
    default instead, and are simply absent when nobody supplied them.
  */
  contentRequirements: {
    copyParams: ["companyName"],
    listParams: [],
    imageCount: 0,
  },
  /*
    The gallery shows a complete legal footing; a real one says only what it was told.
  */
  previewParams: {
    address: "123 Market Street, Suite 400, San Francisco, CA",
    links: [
      { label: "Privacy", href: "https://example.com/privacy" },
      { label: "Terms", href: "https://example.com/terms" },
    ],
  },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({ kind: "divider" });

    const paragraphs = [];
    if (params.links !== undefined && params.links.length > 0) {
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
    /*
      The company line names whoever the sender said they are, and adds the
      address only when there is one. No address is a footer the sender still
      has to complete; a made-up address is a false statement of where they are.
    */
    const companyLine =
      params.address === undefined
        ? params.companyName
        : `${params.companyName} · ${params.address}`;
    paragraphs.push(
      paragraphNode([textRun(companyLine, [FOOTER_FONT_SIZE_MARK])]),
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
