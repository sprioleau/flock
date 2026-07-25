import { describe, expect, it } from "vitest";
import { createTextDoc } from "../schema/text";
import { createEmptyDocument, createSampleDocument, type EmailDocument } from "./document";
import { checkDocumentIntegrity, type IntegrityErrorCode } from "./integrity";

const asDocument = (value: Record<string, unknown>) => value as unknown as EmailDocument;

const hasError = (document: EmailDocument, code: IntegrityErrorCode) =>
  checkDocumentIntegrity(document).errors.some((error) => error.code === code);

/** A minimal valid doc: root > section > text. */
function createMinimalDocument(): EmailDocument {
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_a1b2"],
      properties: {},
    },
    sec_a1b2: {
      id: "sec_a1b2",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_c3d4"],
      properties: {},
    },
    txt_c3d4: {
      id: "txt_c3d4",
      type: "text",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: { text: createTextDoc("hi") },
    },
  };
}

describe("checkDocumentIntegrity — valid documents", () => {
  it("passes the empty document", () => {
    const result = checkDocumentIntegrity(createEmptyDocument());
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("passes the sample document", () => {
    const result = checkDocumentIntegrity(createSampleDocument());
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("passes a minimal root > section > text document", () => {
    expect(checkDocumentIntegrity(createMinimalDocument()).isValid).toBe(true);
  });
});

describe("checkDocumentIntegrity — root rules", () => {
  it("flags a document with no root", () => {
    const document = createMinimalDocument();
    delete document.root;
    expect(hasError(document, "missing_root")).toBe(true);
  });

  it("flags multiple roots", () => {
    const document = asDocument({
      ...createEmptyDocument(),
      root2: { id: "root2", type: "root", parentId: null, childrenIds: [], properties: {} },
    });
    const errors = checkDocumentIntegrity(document).errors.filter(
      (error) => error.code === "multiple_roots",
    );
    expect(errors).toHaveLength(2);
  });

  it("flags a root with a parent", () => {
    const document = createMinimalDocument();
    (document.root as { parentId: string | null }).parentId = "sec_a1b2";
    expect(hasError(document, "root_has_parent")).toBe(true);
  });

  it("flags a non-root block with a null parentId", () => {
    const document = createMinimalDocument();
    (document.sec_a1b2 as { parentId: string | null }).parentId = null;
    expect(hasError(document, "missing_parent")).toBe(true);
  });
});

describe("checkDocumentIntegrity — key and pointer rules", () => {
  it("flags a record key that differs from the block id", () => {
    const document = createMinimalDocument();
    document.sec_wrong = document.sec_a1b2!;
    delete document.sec_a1b2;
    const result = checkDocumentIntegrity(document);
    expect(result.errors.some((error) => error.code === "block_key_mismatch" && error.blockId === "sec_a1b2")).toBe(true);
  });

  it("flags a parentId pointing at a nonexistent block", () => {
    const document = createMinimalDocument();
    (document.txt_c3d4 as { parentId: string }).parentId = "sec_gone";
    const result = checkDocumentIntegrity(document);
    expect(
      result.errors.some(
        (error) =>
          error.code === "parent_not_found" &&
          error.blockId === "txt_c3d4" &&
          error.relatedBlockId === "sec_gone",
      ),
    ).toBe(true);
  });

  it("flags a childrenIds entry pointing at a nonexistent block", () => {
    const document = createMinimalDocument();
    (document.sec_a1b2!.childrenIds as string[]).push("txt_gone");
    expect(hasError(document, "child_not_found")).toBe(true);
  });

  it("flags a child not listed by the parent it claims", () => {
    const document = createMinimalDocument();
    (document.sec_a1b2 as { childrenIds: string[] }).childrenIds = [];
    const result = checkDocumentIntegrity(document);
    expect(
      result.errors.some(
        (error) => error.code === "parent_child_mismatch" && error.blockId === "txt_c3d4",
      ),
    ).toBe(true);
  });

  it("flags a listed child whose parentId points elsewhere", () => {
    const document = createSampleDocument();
    // btn_t9u0 is listed by col_p5q6 but claims col_m3n4 as parent.
    (document.btn_t9u0 as { parentId: string }).parentId = "col_m3n4";
    const result = checkDocumentIntegrity(document);
    expect(result.errors.some((error) => error.code === "parent_child_mismatch")).toBe(true);
    expect(result.isValid).toBe(false);
  });

  it("flags a child listed twice by the same parent", () => {
    const document = createMinimalDocument();
    (document.sec_a1b2!.childrenIds as string[]).push("txt_c3d4");
    expect(hasError(document, "child_multiply_referenced")).toBe(true);
  });

  it("flags a child listed by two different parents", () => {
    const document = createSampleDocument();
    // txt_r7s8 belongs to col_m3n4; also list it under col_p5q6.
    (document.col_p5q6!.childrenIds as string[]).push("txt_r7s8");
    expect(hasError(document, "child_multiply_referenced")).toBe(true);
  });
});

describe("checkDocumentIntegrity — cycles and reachability", () => {
  it("flags a parent-pointer cycle", () => {
    const document = asDocument({
      root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: {} },
      sec_a1b2: {
        id: "sec_a1b2",
        type: "section",
        parentId: "row_c3d4",
        childrenIds: ["row_c3d4"],
        properties: {},
      },
      row_c3d4: {
        id: "row_c3d4",
        type: "row",
        parentId: "sec_a1b2",
        childrenIds: ["sec_a1b2"],
        properties: {},
      },
    });
    expect(hasError(document, "cycle_detected")).toBe(true);
    expect(hasError(document, "unreachable_block")).toBe(true);
  });

  it("flags a self-parenting block", () => {
    const document = asDocument({
      ...createEmptyDocument(),
      sec_loop: {
        id: "sec_loop",
        type: "section",
        parentId: "sec_loop",
        childrenIds: ["sec_loop"],
        properties: {},
      },
    });
    expect(hasError(document, "cycle_detected")).toBe(true);
  });

  it("flags blocks not reachable from the root", () => {
    const document = createMinimalDocument();
    // A locally-consistent island: the root never lists sec_z9y8.
    document.sec_z9y8 = {
      id: "sec_z9y8",
      type: "section",
      parentId: "root",
      childrenIds: [],
      properties: {},
    };
    const result = checkDocumentIntegrity(document);
    expect(
      result.errors.some(
        (error) => error.code === "unreachable_block" && error.blockId === "sec_z9y8",
      ),
    ).toBe(true);
  });
});

describe("checkDocumentIntegrity — nesting rules", () => {
  it("rejects a leaf directly under the root", () => {
    const document = createMinimalDocument();
    (document.root!.childrenIds as string[]).push("txt_zulu");
    document.txt_zulu = asDocument({
      txt_zulu: {
        id: "txt_zulu",
        type: "text",
        parentId: "root",
        childrenIds: [],
        properties: { text: createTextDoc("x") },
      },
    }).txt_zulu!;
    expect(hasError(document, "invalid_nesting")).toBe(true);
  });

  it("rejects a column directly under a section", () => {
    const document = createMinimalDocument();
    (document.sec_a1b2!.childrenIds as string[]).push("col_zulu");
    document.col_zulu = asDocument({
      col_zulu: {
        id: "col_zulu",
        type: "column",
        parentId: "sec_a1b2",
        childrenIds: [],
        properties: {},
      },
    }).col_zulu!;
    expect(hasError(document, "invalid_nesting")).toBe(true);
  });

  it("rejects a section nested inside a section", () => {
    const document = asDocument({
      root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_a1b2"], properties: {} },
      sec_a1b2: {
        id: "sec_a1b2",
        type: "section",
        parentId: "root",
        childrenIds: ["sec_inner"],
        properties: {},
      },
      sec_inner: {
        id: "sec_inner",
        type: "section",
        parentId: "sec_a1b2",
        childrenIds: [],
        properties: {},
      },
    });
    expect(hasError(document, "invalid_nesting")).toBe(true);
  });

  it("rejects a row inside a column", () => {
    const document = asDocument({
      root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_a1b2"], properties: {} },
      sec_a1b2: { id: "sec_a1b2", type: "section", parentId: "root", childrenIds: ["row_b2c3"], properties: {} },
      row_b2c3: { id: "row_b2c3", type: "row", parentId: "sec_a1b2", childrenIds: ["col_c3d4"], properties: {} },
      col_c3d4: { id: "col_c3d4", type: "column", parentId: "row_b2c3", childrenIds: ["row_deep"], properties: {} },
      row_deep: { id: "row_deep", type: "row", parentId: "col_c3d4", childrenIds: [], properties: {} },
    });
    expect(hasError(document, "invalid_nesting")).toBe(true);
  });

  it("flags a leaf that lists children", () => {
    const document = createMinimalDocument();
    (document.txt_c3d4!.childrenIds as string[]).push("txt_kid");
    expect(hasError(document, "leaf_has_children")).toBe(true);
  });
});

describe("checkDocumentIntegrity — result shape", () => {
  it("returns structured errors with codes, messages, and block ids", () => {
    const document = createMinimalDocument();
    (document.txt_c3d4 as { parentId: string }).parentId = "sec_gone";
    const result = checkDocumentIntegrity(document);
    expect(result.isValid).toBe(false);
    for (const error of result.errors) {
      expect(typeof error.code).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("never throws, even on garbage input", () => {
    expect(() => checkDocumentIntegrity(asDocument({}))).not.toThrow();
    expect(() =>
      checkDocumentIntegrity(asDocument({ weird: { id: "weird", type: "text", childrenIds: [], properties: {} } })),
    ).not.toThrow();
  });
});
