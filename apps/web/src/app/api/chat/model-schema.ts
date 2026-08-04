import { jsonSchema, type JSONSchema7, type Schema } from "ai";
import { z } from "zod";
import { normalizeToolInput } from "./tool-input-normalizer";

/**
 * Gemini-compatible model-facing schemas.
 *
 * The Gemini API's function-declaration format requires `enum` entries to be
 * STRINGS; numeric literal unions in our op schemas (e.g. heading `level:
 * 1 | 2 | 3` in the rich-text doc) convert to numeric `const`/`enum` JSON
 * Schema nodes, which Gemini rejects with
 * "Invalid value at ... any_of[i].enum[0] (TYPE_STRING)".
 *
 * Fix at the glue layer (this module — packages/email-sdk stays
 * provider-agnostic): convert the Zod schema to JSON Schema ourselves, rewrite
 * numeric `const`/`enum` nodes into `type` + `minimum`/`maximum` (+ an
 * "Allowed values" description), and hand the AI SDK a `jsonSchema()` whose
 * `validate` still runs the ORIGINAL Zod schema — so the validation gate is
 * untouched; only the model-facing declaration changes.
 */

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendAllowedValuesDescription(node: Record<string, unknown>, values: number[]): void {
  const allowedValuesText = `Allowed values: ${values.join(", ")}.`;
  node.description =
    typeof node.description === "string" && node.description.length > 0
      ? `${node.description} ${allowedValuesText}`
      : allowedValuesText;
}

function rewriteNumericLiterals(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(rewriteNumericLiterals);
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    rewritten[key] = rewriteNumericLiterals(value);
  }

  if (typeof rewritten.const === "number") {
    const constValue = rewritten.const;
    delete rewritten.const;
    rewritten.type ??= Number.isInteger(constValue) ? "integer" : "number";
    rewritten.minimum = constValue;
    rewritten.maximum = constValue;
    appendAllowedValuesDescription(rewritten, [constValue]);
  }

  if (Array.isArray(rewritten.enum) && rewritten.enum.every((v) => typeof v === "number")) {
    const enumValues = rewritten.enum as number[];
    delete rewritten.enum;
    rewritten.type ??= enumValues.every(Number.isInteger) ? "integer" : "number";
    rewritten.minimum = Math.min(...enumValues);
    rewritten.maximum = Math.max(...enumValues);
    appendAllowedValuesDescription(rewritten, enumValues);
  }

  return rewritten;
}

/**
 * Known Gemini tool-call mangle (observed live on deep nested inputs like
 * addSection's children): the model emits `function_call.args` as ONE
 * JSON-ESCAPED STRING of the whole argument object instead of a typed object.
 * The SDK's JSON parse of the raw call then yields a string, Zod rejects it
 * ("expected object, received string"), and a repair round is spent — or
 * worse, wasted — on a call whose content was actually valid. Unwrap it here,
 * BEFORE validation: parse the string (twice if needed — double-encoding has
 * been seen) and validate the result instead. Anything that doesn't parse to
 * an object falls through to normal Zod rejection.
 */
export function unwrapStringifiedToolInput(value: unknown): unknown {
  let current: unknown = value;
  for (let unwrapAttempt = 0; unwrapAttempt < 2 && typeof current === "string"; unwrapAttempt++) {
    try {
      current = JSON.parse(current);
    } catch {
      return value;
    }
  }
  return isJsonObject(current) ? current : value;
}

/**
 * Build the model-facing input schema for one tool: Gemini-compatible JSON
 * Schema declaration, original Zod schema for validation (with the
 * stringified-args unwrap above, then the near-miss tool-input normalization
 * of ./tool-input-normalizer, applied first). Both are deterministic
 * pre-validation coercions for known model quirks; the Zod schema stays the
 * authority, and anything neither coercion can close fails exactly as before.
 */
export function toModelInputSchema(zodInputSchema: z.ZodType): Schema<unknown> {
  const rawJsonSchema = z.toJSONSchema(zodInputSchema, {
    io: "input",
    unrepresentable: "any",
  });
  const compatibleJsonSchema = rewriteNumericLiterals(rawJsonSchema) as JSONSchema7;

  return jsonSchema(compatibleJsonSchema, {
    validate: (value) => {
      const parsed = zodInputSchema.safeParse(
        normalizeToolInput(zodInputSchema, unwrapStringifiedToolInput(value)),
      );
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  });
}
