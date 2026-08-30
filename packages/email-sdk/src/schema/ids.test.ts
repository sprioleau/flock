import { describe, expect, it } from "vitest";
import {
  BLOCK_ID_PREFIXES,
  BLOCK_ID_SUFFIX_LENGTH,
  BLOCK_TYPES,
  ROOT_BLOCK_ID,
  blockIdSchema,
  blockIdSchemasByType,
  formatBlockId,
  generateBlockId,
  parseBlockId,
  rootBlockIdSchema,
  sectionBlockIdSchema,
  type BlockType,
} from "./ids";

const NON_ROOT_TYPES = BLOCK_TYPES.filter((type): type is Exclude<BlockType, "root"> => type !== "root");

describe("generateBlockId", () => {
  it('returns the literal "root" for the root type', () => {
    expect(generateBlockId("root")).toBe(ROOT_BLOCK_ID);
    expect(generateBlockId("root", () => 0.5)).toBe("root");
  });

  it.each(NON_ROOT_TYPES)("generates <prefix>_<4 lowercase alphanumeric> for %s", (type) => {
    const id = generateBlockId(type);
    expect(id).toMatch(new RegExp(`^${BLOCK_ID_PREFIXES[type]}_[a-z0-9]{${BLOCK_ID_SUFFIX_LENGTH}}$`));
  });

  it("is deterministic with an injected RNG", () => {
    const values = [0, 0.5, 0.999, 0.1];
    let callCount = 0;
    const fakeRandom = () => values[callCount++ % values.length]!;
    /*
      alphabet indexes: floor(0*36)=0→"a", floor(0.5*36)=18→"s", floor(0.999*36)=35→"9", floor(0.1*36)=3→"d"
    */
    expect(generateBlockId("section", fakeRandom)).toBe("sec_as9d");
  });

  it("covers the RNG edge values 0 and just-under-1", () => {
    expect(generateBlockId("text", () => 0)).toBe("txt_aaaa");
    expect(generateBlockId("button", () => 0.9999999)).toBe("btn_9999");
  });

  it("produces ids that pass both the generic and the type-specific schemas", () => {
    for (const type of NON_ROOT_TYPES) {
      const id = generateBlockId(type);
      expect(blockIdSchema.safeParse(id).success).toBe(true);
      expect(blockIdSchemasByType[type].safeParse(id).success).toBe(true);
    }
  });
});

describe("blockIdSchema (generic)", () => {
  it.each(["root", "sec_a1b2", "row_zz99", "col_0000", "txt_ab12", "btn_x9k3", "img_p4q5", "div_m0n1"])(
    "accepts %s",
    (id) => {
      expect(blockIdSchema.safeParse(id).success).toBe(true);
    },
  );

  it.each([
    "sec_A1B2", /* uppercase */
    "sec_a1b", /* suffix too short */
    "sec_a1b22", /* suffix too long */
    "foo_a1b2", /* unknown prefix */
    "sec-a1b2", /* wrong separator */
    "sec_a1b!", /* invalid character */
    "seca1b2", /* missing underscore */
    "", /* empty */
    "root_a1b2", /* root takes no suffix */
  ])("rejects %s", (id) => {
    expect(blockIdSchema.safeParse(id).success).toBe(false);
  });
});

describe("parseBlockId / formatBlockId", () => {
  it('parses the root id to { type: "root", key: "root" }', () => {
    expect(parseBlockId("root")).toEqual({ type: "root", key: "root" });
  });

  it.each(NON_ROOT_TYPES)("round-trips a generated %s id", (type) => {
    const id = generateBlockId(type);
    const parsed = parseBlockId(id);
    expect(parsed).toEqual({ type, key: id.slice(id.indexOf("_") + 1) });
    expect(formatBlockId(parsed!)).toBe(id);
  });

  it("round-trips the root id", () => {
    expect(formatBlockId(parseBlockId("root")!)).toBe("root");
  });

  it.each([
    "sec_A1B2", /* uppercase key */
    "sec_a1b", /* key too short */
    "sec_a1b22", /* key too long */
    "foo_a1b2", /* unknown prefix */
    "sec-a1b2", /* wrong separator */
    "seca1b2", /* missing underscore */
    "root_a1b2", /* root takes no suffix */
    "_a1b2", /* empty prefix */
    "sec_", /* empty key */
    "", /* empty */
  ])("parseBlockId returns null for %j", (id) => {
    expect(parseBlockId(id)).toBeNull();
  });

  it("formatBlockId throws on a malformed key", () => {
    expect(() => formatBlockId({ type: "button", key: "A1B2" })).toThrow(/invalid key/);
    expect(() => formatBlockId({ type: "button", key: "a1b" })).toThrow(/invalid key/);
    expect(() => formatBlockId({ type: "button", key: "a1b22" })).toThrow(/invalid key/);
    expect(() => formatBlockId({ type: "button", key: "" })).toThrow(/invalid key/);
  });

  it('formatBlockId for root requires the literal "root" key', () => {
    expect(formatBlockId({ type: "root", key: "root" })).toBe("root");
    expect(() => formatBlockId({ type: "root", key: "a1b2" })).toThrow(/root block id/);
  });

  it("produces ids that pass the schemas after a round-trip", () => {
    for (const type of NON_ROOT_TYPES) {
      const id = formatBlockId(parseBlockId(generateBlockId(type))!);
      expect(blockIdSchemasByType[type].safeParse(id).success).toBe(true);
    }
  });
});

describe("type-specific id schemas", () => {
  it("accepts only ids with the matching prefix", () => {
    expect(sectionBlockIdSchema.safeParse("sec_a1b2").success).toBe(true);
    expect(sectionBlockIdSchema.safeParse("row_a1b2").success).toBe(false);
    expect(sectionBlockIdSchema.safeParse("root").success).toBe(false);
  });

  it('the root id schema accepts only the literal "root"', () => {
    expect(rootBlockIdSchema.safeParse("root").success).toBe(true);
    expect(rootBlockIdSchema.safeParse("sec_a1b2").success).toBe(false);
  });

  it("has a schema for every block type", () => {
    for (const type of BLOCK_TYPES) {
      expect(blockIdSchemasByType[type]).toBeDefined();
    }
  });
});
