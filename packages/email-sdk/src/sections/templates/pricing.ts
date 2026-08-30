import { z } from "zod";
import {
  createSectionComposer,
  headingNode,
  paragraphNode,
  textDocOf,
  textRun,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/*
  `pricing` — one plan, one price, what's included, one signup button — all
  centered like a pricing card. Reference: react.email/components
  "pricing-with-single-tier" (the multi-tier table does not read well at
  email width, so the catalog ships the single-tier card).
*/

export const pricingParamsSchema = z
  .strictObject({
    planName: z
      .string()
      .min(1)
      .default("Pro")
      .describe("The plan's name — rendered as a level-3 heading above the price."),
    price: z
      .string()
      .min(1)
      .default("$29")
      .describe('The price as display text (currency included, like "$29").'),
    pricePeriod: z
      .string()
      .min(1)
      .default("per month")
      .describe('The billing period line under the price (like "per month" or "per seat, billed yearly").'),
    features: z
      .array(z.string().min(1).describe("One included feature, as a short line."))
      .min(1)
      .max(6)
      .default(["Unlimited projects", "Advanced analytics", "Priority support"])
      .describe("1–6 short lines saying what the plan includes."),
    ctaLabel: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The signup button's visible label (plain text). Omit, with ctaHref, for a card with no button.",
      ),
    ctaHref: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The signup button's destination: an absolute URL. Give a real one or omit it — there is no default, so a card you leave without a destination simply has no button.",
      ),
  })
  .describe("Pricing content: plan name, display price and period, included features, and the signup button.");

export const pricingTemplate = defineSectionTemplate({
  id: "pricing",
  name: "Pricing",
  category: "content",
  useWhen:
    "Present one pricing plan as a centered card: plan name, the price, what's included, and a signup button.",
  paramsSchema: pricingParamsSchema,
  /*
    A plan is its name, its price, its billing period, and at least one thing it includes.
  */
  contentRequirements: {
    copyParams: ["planName", "price", "pricePeriod"],
    listParams: [{ param: "features", minimumCount: 1 }],
    imageCount: 0,
  },
  /*
    The gallery shows the signup button; a real card only gets one you can sign up through.
  */
  previewParams: { ctaLabel: "Start free trial", ctaHref: "https://example.com/pricing" },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        headingNode({ level: 3, content: params.planName }),
        headingNode({ level: 1, content: params.price }),
        paragraphNode(params.pricePeriod),
      ]),
      textAlign: "center",
    });
    composer.addLeaf({ kind: "divider" });
    composer.addLeaf({
      kind: "text",
      text: textDocOf(
        params.features.map((feature) => paragraphNode([textRun(`✓  ${feature}`)])),
      ),
      textAlign: "center",
    });
    /*
      A signup button with nowhere to sign up is a dead button; leave it out.
      The spacer goes with it — it exists to give the button air.
    */
    if (params.ctaLabel !== undefined && params.ctaHref !== undefined) {
      composer.addLeaf({ kind: "spacer", height: 8 });
      composer.addLeaf({
        kind: "button",
        label: params.ctaLabel,
        href: params.ctaHref,
        align: "center",
      });
    }
    return composer.finish();
  },
});
