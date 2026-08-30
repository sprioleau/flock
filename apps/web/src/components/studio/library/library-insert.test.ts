import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createEmptyDocument,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import { createDefaultLeafBlock, createDefaultSection } from "../block-defaults";
import {
  buildLibraryInsertPlan,
  resolveInsertAltText,
  type LibraryInsertAsset,
} from "./library-insert";

/*
  Library → draft insertion (Content Studio Stage S): src-swap on a selected
  image block, add-blocks placement rules otherwise, alt carried from the
  asset (stored alt, else name) in every mode.
*/

const id = (value: string) => value as BlockId;

const asset: LibraryInsertAsset = {
  url: "https://example.convex.cloud/api/storage/asset-1",
  name: "hero.png",
  alt: "A sunrise over mountains",
};

function apply(doc: EmailDocument, op: Operation): EmailDocument {
  const result = applyOperation(doc, op);
  if (!result.isOk) {
    throw new Error(`fixture apply failed: ${JSON.stringify(result.errors)}`);
  }
  return result.doc;
}

/*
  root > sec_aaaa [img_aaaa, txt_aaaa]
*/
function buildFixtureDoc(): EmailDocument {
  let doc = createEmptyDocument();
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_aaaa")), index: 0 });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({ type: "image", id: id("img_aaaa"), parentId: id("sec_aaaa"), doc }),
    parentId: id("sec_aaaa"),
    index: 0,
  });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({ type: "text", id: id("txt_aaaa"), parentId: id("sec_aaaa"), doc }),
    parentId: id("sec_aaaa"),
    index: 1,
  });
  return doc;
}

describe("resolveInsertAltText", () => {
  it("prefers the asset's stored alt", () => {
    expect(resolveInsertAltText(asset)).toBe("A sunrise over mountains");
  });

  it("falls back to the asset name when alt is absent or blank", () => {
    expect(resolveInsertAltText({ url: asset.url, name: "hero.png" })).toBe("hero.png");
    expect(resolveInsertAltText({ url: asset.url, name: "hero.png", alt: "  " })).toBe("hero.png");
  });
});

describe("buildLibraryInsertPlan: selected image block", () => {
  it("swaps src+alt with ONE updateBlockProperties op", () => {
    const doc = buildFixtureDoc();
    const plan = buildLibraryInsertPlan({ doc, selectedBlockId: id("img_aaaa"), asset });
    expect(plan).toMatchObject({
      mode: "replace-selected-image",
      targetBlockId: "img_aaaa",
      op: {
        name: "updateBlockProperties",
        blockId: "img_aaaa",
        properties: { src: asset.url, alt: "A sunrise over mountains" },
      },
    });
  });
});

describe("buildLibraryInsertPlan: no image selected → placement rules", () => {
  it("selected leaf → new image block right after it, carrying the asset src+alt", () => {
    const doc = buildFixtureDoc();
    const plan = buildLibraryInsertPlan({ doc, selectedBlockId: id("txt_aaaa"), asset });
    expect(plan!.mode).toBe("add-image-block");
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: "sec_aaaa", index: 2 });
    const applied = apply(doc, plan!.op as Operation);
    expect(applied[plan!.targetBlockId!]).toMatchObject({
      type: "image",
      properties: { src: asset.url, alt: "A sunrise over mountains" },
    });
  });

  it("no selection → appends an image block to the last section", () => {
    const doc = buildFixtureDoc();
    const plan = buildLibraryInsertPlan({ doc, selectedBlockId: null, asset });
    expect(plan!.op).toMatchObject({ name: "addBlock", parentId: "sec_aaaa", index: 2 });
    const applied = apply(doc, plan!.op as Operation);
    expect(applied[plan!.targetBlockId!]).toMatchObject({
      type: "image",
      properties: { src: asset.url },
    });
  });

  it("empty document → ONE composite addSection op with the asset applied to the new leaf", () => {
    const doc = createEmptyDocument();
    const plan = buildLibraryInsertPlan({ doc, selectedBlockId: null, asset });
    expect(plan!.op.name).toBe("addSection");
    const applied = apply(doc, plan!.op as Operation);
    expect(applied[plan!.targetBlockId!]).toMatchObject({
      type: "image",
      properties: { src: asset.url, alt: "A sunrise over mountains" },
    });
  });

  it("keeps the palette's non-src image defaults (width, padding) intact", () => {
    const doc = buildFixtureDoc();
    const plan = buildLibraryInsertPlan({ doc, selectedBlockId: null, asset });
    const applied = apply(doc, plan!.op as Operation);
    const inserted = applied[plan!.targetBlockId!]!;
    expect(inserted.properties).toMatchObject({ align: "center" });
    expect(typeof (inserted.properties as { width?: number }).width).toBe("number");
  });
});
