import { z } from "zod";
import type { TextMark } from "../../schema/text";
import { createSectionComposer, paragraphNode, textDocOf, textRun } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `footer-social` — social-first footer over a divider: follow links, the
 * company line, and a standalone unsubscribe link block, all centered in
 * small print. Reference: react.email/components "footer-with-social-icons"
 * (icons rendered as text links — no image assets to break in dark mode).
 */

const FOOTER_FONT_SIZE_MARK: TextMark = { type: "textStyle", attrs: { fontSize: "12px" } };

const socialLinkSchema = z
  .strictObject({
    label: z.string().min(1).describe('The network\'s visible name (like "Instagram").'),
    href: z.string().min(1).describe("Absolute https:// URL of the profile."),
  })
  .describe("One social profile link: network name and profile URL.");

export const footerSocialParamsSchema = z
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
    socialLinks: z
      .array(socialLinkSchema)
      .min(1)
      .max(5)
      .default([
        { label: "X", href: "https://x.com/example" },
        { label: "Instagram", href: "https://instagram.com/example" },
        { label: "YouTube", href: "https://youtube.com/@example" },
      ])
      .describe("1–5 social profile links shown as a follow row."),
    unsubscribeHref: z
      .string()
      .min(1)
      .default("*|UNSUB|*")
      .describe('Destination of the unsubscribe link. Defaults to the "*|UNSUB|*" merge tag.'),
  })
  .describe("Social-footer content: company identity, social profile links, and the unsubscribe destination.");

export const footerSocialTemplate = defineSectionTemplate({
  id: "footer-social",
  name: "Social footer",
  category: "footer",
  useWhen:
    "Close the email with a social-first footer: follow links for your profiles above the company line and an unsubscribe link.",
  paramsSchema: footerSocialParamsSchema,
  /*
    As `footer`, plus: a social link is an assertion that an account exists at that URL, so this variant needs at least one real one — otherwise the plain `footer` is its substitute.
  */
  contentRequirements: {
    copyParams: ["companyName"],
    listParams: [{ param: "socialLinks", minimumCount: 1 }],
    imageCount: 0,
  },
  /* As `footer`: the gallery shows the address line, a real footer states only a real one. */
  previewParams: { address: "123 Market Street, Suite 400, San Francisco, CA" },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({ kind: "divider" });
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        paragraphNode(
          params.socialLinks.flatMap((link, index) => [
            ...(index > 0 ? [textRun("   ·   ", [FOOTER_FONT_SIZE_MARK])] : []),
            textRun(link.label, [
              { type: "link", attrs: { href: link.href } },
              FOOTER_FONT_SIZE_MARK,
            ]),
          ]),
        ),
        paragraphNode([
          textRun(
            params.address === undefined
              ? params.companyName
              : `${params.companyName} · ${params.address}`,
            [FOOTER_FONT_SIZE_MARK],
          ),
        ]),
      ]),
      textAlign: "center",
    });
    composer.addLeaf({
      kind: "link",
      text: "Unsubscribe",
      href: params.unsubscribeHref,
      align: "center",
      fontSize: 12,
    });
    return composer.finish();
  },
});
