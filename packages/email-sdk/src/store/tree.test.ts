import { describe, expect, it } from "vitest";
import type { Block } from "../schema/blocks";
import { createEmptyDocument, createSampleDocument, type EmailDocument } from "./document";
import { deflate, inflate, type EmailTree } from "./tree";

const asDocument = (value: Record<string, unknown>) => value as unknown as EmailDocument;

describe("inflate", () => {
  it("builds the tree in childrenIds order", () => {
    const tree = inflate(createSampleDocument());
    expect(tree.block.id).toBe("root");
    expect(tree.children.map((child) => child.block.id)).toEqual(["sec_a1b2", "sec_c3d4", "sec_e5f6"]);

    const hero = tree.children[0]!;
    expect(hero.children.map((child) => child.block.id)).toEqual(["txt_e5f6", "img_g7h8", "div_i9j0"]);

    const twoColumn = tree.children[1]!;
    const row = twoColumn.children[0]!;
    expect(row.block.type).toBe("row");
    expect(row.children.map((child) => child.block.type)).toEqual(["column", "column"]);
    expect(row.children[1]!.children[0]!.block.id).toBe("btn_t9u0");
  });

  it("gives leaves empty children arrays", () => {
    const tree = inflate(createSampleDocument());
    const divider = tree.children[0]!.children[2]!;
    expect(divider.block.type).toBe("divider");
    expect(divider.children).toEqual([]);
  });

  it("inflates an empty document to a childless root", () => {
    const tree = inflate(createEmptyDocument());
    expect(tree.block.id).toBe("root");
    expect(tree.children).toEqual([]);
  });

  it("throws when the document has no root", () => {
    expect(() => inflate(asDocument({}))).toThrow(/no root/);
  });

  it("throws when the document has multiple roots", () => {
    const document = asDocument({
      ...createEmptyDocument(),
      root2: { id: "root2", type: "root", parentId: null, childrenIds: [], properties: {} },
    });
    expect(() => inflate(document)).toThrow(/2 root blocks/);
  });

  it("throws when a child id is dangling", () => {
    const document = createEmptyDocument();
    (document.root!.childrenIds as string[]).push("sec_gone");
    expect(() => inflate(document)).toThrow(/"sec_gone".*not present/);
  });

  it("throws on cycles instead of recursing forever", () => {
    const document = asDocument({
      root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_a1b2"], properties: {} },
      sec_a1b2: {
        id: "sec_a1b2",
        type: "section",
        parentId: "root",
        childrenIds: ["sec_a1b2"],
        properties: {},
      },
    });
    expect(() => inflate(document)).toThrow(/cycle/);
  });
});

describe("deflate", () => {
  it("round-trips: deflate(inflate(doc)) equals doc", () => {
    const document = createSampleDocument();
    expect(deflate(inflate(document))).toEqual(document);
  });

  it("round-trips the empty document", () => {
    const document = createEmptyDocument();
    expect(deflate(inflate(document))).toEqual(document);
  });

  it("treats the tree shape as authoritative and rewrites pointers", () => {
    const tree = inflate(createSampleDocument());
    /*
      Manually reorder the root's sections without touching childrenIds.
    */
    tree.children.reverse();
    const document = deflate(tree);
    expect(document.root!.childrenIds).toEqual(["sec_e5f6", "sec_c3d4", "sec_a1b2"]);
  });

  it("rewrites stale parentId/childrenIds embedded in tree blocks", () => {
    const tree = inflate(createSampleDocument());
    /*
      Move the button node from its column up into the hero section.
    */
    const row = tree.children[1]!.children[0]!;
    const buttonColumn = row.children[1]!;
    const buttonNode = buttonColumn.children.pop()!;
    tree.children[0]!.children.push(buttonNode);

    const document = deflate(tree);
    expect(document.btn_t9u0!.parentId).toBe("sec_a1b2");
    expect(document.sec_a1b2!.childrenIds).toContain("btn_t9u0");
    expect(document.col_p5q6!.childrenIds).toEqual([]);
  });

  it("throws when the same block id appears twice in the tree", () => {
    const tree = inflate(createSampleDocument());
    const hero = tree.children[0]!;
    hero.children.push(hero.children[0]!);
    expect(() => deflate(tree as EmailTree)).toThrow(/duplicate block id/);
  });

  it("emits blocks unchanged apart from pointers", () => {
    const document = createSampleDocument();
    const roundTripped = deflate(inflate(document));
    const original = document.txt_e5f6 as Block;
    const copy = roundTripped.txt_e5f6 as Block;
    expect(copy.properties).toEqual(original.properties);
    expect(copy).not.toBe(original); /* deflate builds fresh block records */
  });
});
