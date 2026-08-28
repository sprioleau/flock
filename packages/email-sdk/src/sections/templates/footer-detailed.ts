import { z } from "zod";
import type { TextMark } from "../../schema/text";
import { createSectionComposer, paragraphNode, textDocOf, textRun } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `footer-detailed` — two-column footer over a divider: company identity on
 * the left, a stack of helpful links on the right, then a centered
 * unsubscribe/preferences line. Reference: react.email/components
 * "footer-with-two-columns".
 */

const FOOTER_FONT_SIZE_MARK: TextMark = { type: "textStyle", attrs: { fontSize: "12px" } };

const footerLinkSchema = z
  .strictObject({
    label: z.string().min(1).describe("The visible link text (short)."),
    href: z.string().min(1).describe("Link destination: an absolute https:// URL or a merge tag."),
  })
  .describe("One footer link: label and destination.");

export const footerDetailedParamsSchema = z
  .strictObject({
    companyName: z
      .string()
      .min(1)
      .default("Flock")
      .describe("The sender's legal company name."),
    tagline: z
      .string()
      .min(1)
      .optional()
      .describe("Optional one-line tagline shown under the company name."),
    address: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The sender's postal address (required by anti-spam law in most regions). There is no default: an address is a legal claim about where the sender is, so an unsupplied one is left OUT of the footer rather than invented, and the sender fills it in.",
      ),
    links: z
      .array(footerLinkSchema)
      .min(1)
      .max(6)
      .default([
        { label: "Help Center", href: "https://example.com/help" },
        { label: "Blog", href: "https://example.com/blog" },
        { label: "Careers", href: "https://example.com/careers" },
        { label: "Privacy", href: "https://example.com/privacy" },
      ])
      .describe("1–6 helpful links stacked in the right column."),
    unsubscribeHref: z
      .string()
      .min(1)
      .default("*|UNSUB|*")
      .describe('Destination of the unsubscribe link. Defaults to the "*|UNSUB|*" merge tag.'),
    managePreferencesHref: z
      .string()
      .min(1)
      .default("*|UPDATE_PROFILE|*")
      .describe('Destination of the "Manage preferences" link. Defaults to the "*|UPDATE_PROFILE|*" merge tag.'),
  })
  .describe(
    "Detailed-footer content: company identity, a right-hand link stack, and the unsubscribe/preferences destinations.",
  );

export const footerDetailedTemplate = defineSectionTemplate({
  id: "footer-detailed",
  name: "Detailed footer",
  category: "footer",
  useWhen:
    "Close the email with a fuller footer: company identity on the left, a stack of helpful links on the right, unsubscribe and preferences underneath.",
  paramsSchema: footerDetailedParamsSchema,
  /*
    As `footer`, plus the link column this variant exists for.
  */
  contentRequirements: {
    copyParams: ["companyName"],
    listParams: [{ param: "links", minimumCount: 1 }],
    imageCount: 0,
  },
  /* As `footer`: the gallery shows the address line, a real footer states only a real one. */
  previewParams: { address: "123 Market Street, Suite 400, San Francisco, CA" },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({ kind: "divider" });
    composer.addColumns([
      {
        widthPercent: 60,
        leaves: [
          {
            kind: "text",
            text: textDocOf([
              paragraphNode([
                textRun(params.companyName, [{ type: "bold" }, FOOTER_FONT_SIZE_MARK]),
              ]),
              ...(params.tagline !== undefined
                ? [paragraphNode([textRun(params.tagline, [FOOTER_FONT_SIZE_MARK])])]
                : []),
              /* No address line at all rather than a street the sender is not on. */
              ...(params.address !== undefined
                ? [paragraphNode([textRun(params.address, [FOOTER_FONT_SIZE_MARK])])]
                : []),
            ]),
          },
        ],
      },
      {
        widthPercent: 40,
        leaves: [
          {
            kind: "text",
            text: textDocOf(
              params.links.map((link) =>
                paragraphNode([
                  textRun(link.label, [
                    { type: "link", attrs: { href: link.href } },
                    FOOTER_FONT_SIZE_MARK,
                  ]),
                ]),
              ),
            ),
            textAlign: "right",
          },
        ],
      },
    ]);
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        paragraphNode([
          textRun("Unsubscribe", [
            { type: "link", attrs: { href: params.unsubscribeHref } },
            FOOTER_FONT_SIZE_MARK,
          ]),
          textRun("   ·   ", [FOOTER_FONT_SIZE_MARK]),
          textRun("Manage preferences", [
            { type: "link", attrs: { href: params.managePreferencesHref } },
            FOOTER_FONT_SIZE_MARK,
          ]),
        ]),
      ]),
      textAlign: "center",
    });
    return composer.finish();
  },
});
