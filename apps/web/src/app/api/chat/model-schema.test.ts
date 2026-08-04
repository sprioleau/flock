import { addSectionOperationSchema } from "@flock/email-sdk";
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

/**
 * The second deterministic pre-validation coercion at this seam (see
 * tool-input-normalizer.ts): the live conformance miss where the model sent a
 * text block's rich-text doc at the block's top level, with no childrenIds, no
 * properties, and no operation `name`.
 */
describe("toModelInputSchema validate — tool-input normalization", () => {
  const validate = toModelInputSchema(addSectionOperationSchema).validate!;

  const textDoc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello there" }] }],
  };
  const productionFailure = {
    index: 1,
    section: {
      id: "sec_h101",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_h101"],
      properties: {},
    },
    children: [{ type: "text", text: textDoc, id: "txt_h101", parentId: "sec_h101" }],
  };

  it("accepts the observed near-miss block and yields the conforming operation", async () => {
    const result = await validate(productionFailure);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({
      name: "addSection",
      index: 1,
      section: productionFailure.section,
      children: [
        {
          id: "txt_h101",
          type: "text",
          parentId: "sec_h101",
          childrenIds: [],
          properties: { text: textDoc },
        },
      ],
    });
  });

  /**
   * The mock model's "schema-invalid tool call" probe (mock-model.ts) sends an
   * addSection whose `name` is present but WRONG ("section") and whose section
   * is a container missing childrenIds. Both are repairs this module refuses on
   * purpose, so that probe must keep failing exactly as it does today — the
   * observability path that reads its Zod issues is not disturbed.
   */
  it("leaves the mock model's schema-invalid probe payload rejected", async () => {
    const result = await validate({
      name: "section",
      section: { id: "sec_probe", type: "section", parentId: "root" },
      index: 0,
      children: [
        {
          id: "txt_probe",
          type: "text",
          parentId: "sec_probe",
          text: { type: "text", text: "Hello" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("still rejects a near-miss no mechanical repair can close", async () => {
    const result = await validate({
      index: 0,
      section: {
        id: "sec_h101",
        type: "section",
        parentId: "root",
        childrenIds: ["btn_h101"],
        properties: {},
      },
      // A button with no href: the destination is content the model never
      // sent, and inventing one is not repair.
      children: [{ id: "btn_h101", type: "button", parentId: "sec_h101", label: "Buy now" }],
    });
    expect(result.success).toBe(false);
  });
});
