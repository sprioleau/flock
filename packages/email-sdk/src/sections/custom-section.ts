import { z } from "zod";
import type { RandomFn } from "../schema/ids";
import {
  createSectionComposer,
  headingNode,
  paragraphNode,
  textDocOf,
  type LeafSpec,
} from "./build-helpers";
import type { SectionBuildResult } from "./types";

/*
  A deliberately small, declarative escape hatch for layouts the catalog does
  not cover. It can describe content and safe links, but never HTML, CSS,
  block JSON, image addresses, or theme values. The builder below translates
  it into the same section/row/column/leaf tree as the catalog builders.
*/

const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), "Links must use https://.");

const customTextSchema = z
  .strictObject({
    kind: z.literal("text"),
    role: z.enum(["heading", "paragraph"]),
    text: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((value) => !/<\/?[a-z][^>]*>/i.test(value), "Text cannot contain HTML markup."),
  })
  .describe("A heading or paragraph of source-backed copy.");

const customButtonSchema = z
  .strictObject({
    kind: z.literal("button"),
    label: z.string().trim().min(1).max(120),
    href: httpsUrlSchema,
  })
  .describe("A call-to-action button with an existing secure destination.");

const customLinkSchema = z
  .strictObject({
    kind: z.literal("link"),
    text: z.string().trim().min(1).max(160),
    href: httpsUrlSchema,
  })
  .describe("A standalone secure link with source-backed link text.");

const customDividerSchema = z
  .strictObject({ kind: z.literal("divider") })
  .describe("A theme-native horizontal divider.");

export const customLeafSchema = z.discriminatedUnion("kind", [
  customTextSchema,
  customButtonSchema,
  customLinkSchema,
  customDividerSchema,
]);

export type CustomLeaf = z.infer<typeof customLeafSchema>;

const customColumnSchema = z
  .strictObject({
    widthPercent: z.number().min(1).max(100).optional(),
    leaves: z.array(customLeafSchema).min(1).max(8),
  })
  .describe("One vertical column of source-backed content.");

export type CustomColumn = z.infer<typeof customColumnSchema>;

export const customSectionSchema = z
  .strictObject({
    columns: z.array(customColumnSchema).min(1).max(3),
  })
  .superRefine((section, context) => {
    const leafCount = section.columns.reduce((count, column) => count + column.leaves.length, 0);
    if (leafCount > 18) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 18,
        inclusive: true,
        origin: "array",
        path: ["columns"],
        message: "A custom section may contain at most 18 leaves.",
      });
    }
    const widths = section.columns.map((column) => column.widthPercent);
    const hasExplicitWidths = widths.some((width) => width !== undefined);
    if (hasExplicitWidths && widths.some((width) => width === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "Set widthPercent on every column or omit it from every column.",
      });
    }
    if (hasExplicitWidths) {
      const total = widths.reduce<number>((sum, width) => sum + (width ?? 0), 0);
      if (Math.abs(total - 100) > 0.01) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["columns"],
          message: "Explicit column widths must sum to 100.",
        });
      }
    }
  })
  .describe(
    "A custom section for a source structure no catalog template can represent: one to three theme-native columns of faithful text and existing secure links. Omit every widthPercent for equal columns, or provide every widthPercent so they total 100.",
  );

export type CustomSection = z.infer<typeof customSectionSchema>;

function toLeafSpec(leaf: CustomLeaf): LeafSpec {
  switch (leaf.kind) {
    case "text":
      return {
        kind: "text",
        text: textDocOf([
          leaf.role === "heading"
            ? headingNode({ level: 2, content: leaf.text })
            : paragraphNode(leaf.text),
        ]),
      };
    case "button":
      return { kind: "button", label: leaf.label, href: leaf.href };
    case "link":
      return { kind: "link", text: leaf.text, href: leaf.href };
    case "divider":
      return { kind: "divider" };
  }
}

export function buildCustomSection({
  section,
  random,
}: {
  section: CustomSection;
  random?: RandomFn;
}): SectionBuildResult {
  const composer = createSectionComposer(random);
  if (section.columns.length === 1) {
    for (const leaf of section.columns[0]!.leaves) {
      composer.addLeaf(toLeafSpec(leaf));
    }
  } else {
    composer.addColumns(
      section.columns.map((column) => ({
        ...(column.widthPercent === undefined ? {} : { widthPercent: column.widthPercent }),
        leaves: column.leaves.map(toLeafSpec),
      })),
    );
  }
  return composer.finish();
}

export function isCustomSectionPlan(
  section: unknown,
): section is { custom: CustomSection } {
  return (
    typeof section === "object" &&
    section !== null &&
    "custom" in section &&
    typeof (section as { custom?: unknown }).custom === "object"
  );
}
