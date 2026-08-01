import {
  buttonBlockSchema,
  codeBlockSchema,
  columnBlockSchema,
  dividerBlockSchema,
  globalStylesSchema,
  imageBlockSchema,
  linkBlockSchema,
  rowBlockSchema,
  sectionBlockSchema,
  spacerBlockSchema,
  textBlockSchema,
  type GlobalStyles,
} from "@flock/email-sdk";
import type { z } from "zod";

/**
 * Field help text sourced from the SDK's Zod `.describe()` strings — the
 * schemas are the single source of documentation for every property, so the
 * panel reads descriptions off the schemas instead of duplicating prose.
 */

/** Walk optional/default wrappers until a description is found. */
export function getSchemaDescription(schema: z.ZodType): string | undefined {
  let current: z.ZodType | undefined = schema;
  while (current !== undefined) {
    if (current.description !== undefined && current.description !== "") {
      return current.description;
    }
    const unwrappable = current as Partial<{ unwrap: () => z.ZodType }>;
    current = typeof unwrappable.unwrap === "function" ? unwrappable.unwrap() : undefined;
  }
  return undefined;
}

const blockPropertyShapesByType = {
  section: sectionBlockSchema.shape.properties.shape,
  row: rowBlockSchema.shape.properties.shape,
  column: columnBlockSchema.shape.properties.shape,
  text: textBlockSchema.shape.properties.shape,
  button: buttonBlockSchema.shape.properties.shape,
  image: imageBlockSchema.shape.properties.shape,
  divider: dividerBlockSchema.shape.properties.shape,
  link: linkBlockSchema.shape.properties.shape,
  code: codeBlockSchema.shape.properties.shape,
  spacer: spacerBlockSchema.shape.properties.shape,
} as const;

export type DescribableBlockType = keyof typeof blockPropertyShapesByType;

export interface BlockPropertyHelpInput {
  blockType: DescribableBlockType;
  propertyKey: string;
}

/** Help text for one block property, from the block schema's `.describe()`. */
export function getBlockPropertyHelp({
  blockType,
  propertyKey,
}: BlockPropertyHelpInput): string | undefined {
  const shape: Record<string, z.ZodType> = blockPropertyShapesByType[blockType];
  const fieldSchema = shape[propertyKey];
  return fieldSchema === undefined ? undefined : getSchemaDescription(fieldSchema);
}

/** Help text for one global style key, from globalStylesSchema's `.describe()`. */
export function getGlobalStyleHelp(key: keyof GlobalStyles): string | undefined {
  const shape: Record<string, z.ZodType> = globalStylesSchema.shape;
  const fieldSchema = shape[key];
  return fieldSchema === undefined ? undefined : getSchemaDescription(fieldSchema);
}
