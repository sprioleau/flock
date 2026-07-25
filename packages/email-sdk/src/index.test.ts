import { describe, expect, it } from "vitest";
import * as sdk from "./index";

describe("public API surface", () => {
  it("keeps the SDK_VERSION export", () => {
    expect(sdk.SDK_VERSION).toBe("0.1.0");
  });

  it("exports the schema, store, and integrity entry points", () => {
    expect(sdk.blockSchema).toBeDefined();
    expect(sdk.emailDocumentSchema).toBeDefined();
    expect(sdk.textDocSchema).toBeDefined();
    expect(sdk.globalStylesSchema).toBeDefined();
    expect(sdk.DEFAULT_GLOBAL_STYLES).toBeDefined();
    expect(typeof sdk.generateBlockId).toBe("function");
    expect(typeof sdk.inflate).toBe("function");
    expect(typeof sdk.deflate).toBe("function");
    expect(typeof sdk.checkDocumentIntegrity).toBe("function");
    expect(typeof sdk.createEmptyDocument).toBe("function");
    expect(typeof sdk.createSampleDocument).toBe("function");
  });

  it("wires end to end: sample document → integrity → inflate → deflate", () => {
    const document = sdk.createSampleDocument();
    expect(sdk.checkDocumentIntegrity(document).isValid).toBe(true);
    expect(sdk.deflate(sdk.inflate(document))).toEqual(document);
  });
});
