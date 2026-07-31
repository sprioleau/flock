import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toModelInputSchema, unwrapStringifiedToolInput } from "./model-schema";

/**
 * Regression for the live Gemini tool-call mangle (owner repro, complex
 * multi-section prompt): `function_call.args` arrived as ONE JSON-escaped
 * string of the whole argument object (name included), Zod rejected the
 * string, and the repair spiral ended in a terminal turn failure. The unwrap
 * makes such calls validate directly — no repair round needed.
 */

const addSectionish = z.object({
  name: z.literal("addSection"),
  index: z.number(),
  section: z.object({ id: z.string() }),
  children: z.array(z.object({ id: z.string() })),
});

const VALID_INPUT = {
  name: "addSection",
  index: 0,
  section: { id: "sec_ab12" },
  children: [{ id: "txt_cd34" }],
};

describe("unwrapStringifiedToolInput", () => {
  it("passes plain objects through untouched", () => {
    expect(unwrapStringifiedToolInput(VALID_INPUT)).toBe(VALID_INPUT);
  });

  it("unwraps a stringified argument envelope (the observed mangle)", () => {
    expect(unwrapStringifiedToolInput(JSON.stringify(VALID_INPUT))).toEqual(VALID_INPUT);
  });

  it("unwraps double-encoded strings", () => {
    expect(unwrapStringifiedToolInput(JSON.stringify(JSON.stringify(VALID_INPUT)))).toEqual(
      VALID_INPUT,
    );
  });

  it("returns the original value when the string is not JSON", () => {
    expect(unwrapStringifiedToolInput("not json at all")).toBe("not json at all");
  });

  it("returns the original value when parsing yields a non-object", () => {
    expect(unwrapStringifiedToolInput("42")).toBe("42");
  });
});

describe("toModelInputSchema validate", () => {
  const schema = toModelInputSchema(addSectionish);
  const validate = schema.validate!;

  it("accepts a proper object", async () => {
    const result = await validate(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it("accepts the stringified-envelope mangle and yields the parsed object", async () => {
    const result = await validate(JSON.stringify(VALID_INPUT));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual(VALID_INPUT);
    }
  });

  it("still rejects genuinely invalid input", async () => {
    const result = await validate({ name: "addSection" });
    expect(result.success).toBe(false);
  });
});
