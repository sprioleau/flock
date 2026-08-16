import { describe, expect, it } from "vitest";
import type { EmailDocument } from "@flock/email-sdk";
import {
  buildLogoBlockUpdates,
  collectLogoBlockIds,
  describeLogoApplyScope,
  getLogoBlockPromptState,
  type BrandLogoSource,
} from "./brand-logo-blocks";

/*
  The logo-block prompt (brand-kit-v2 §5). What matters here is the DECISION:
  which of the three "the kit can't help you yet" states the panel is in, and
  which blocks an apply would actually touch. Copy and layout are the
  component's; these are the bugs — offering "confirm" for a logo that does not
  exist, letting an unconfirmed hotlink into a document, or dispatching a no-op
  batch that costs the user an undo press for nothing.
*/

const CONFIRMED_LOGO: BrandLogoSource = {
  src: "https://storage.convex.cloud/acme-logo.png",
  alt: "Acme logo",
};

/* Two logo blocks and one ordinary image, so scope is actually testable. */
function buildFixtureDoc({
  firstLogoSrc = "https://placehold.co/200x60",
  firstLogoAlt = "",
}: { firstLogoSrc?: string; firstLogoAlt?: string } = {}): EmailDocument {
  return {
    root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_h", "sec_f"], properties: {} },
    sec_h: { id: "sec_h", type: "section", parentId: "root", childrenIds: ["img_head", "img_hero"], properties: {} },
    img_head: {
      id: "img_head",
      type: "image",
      parentId: "sec_h",
      childrenIds: [],
      properties: { src: firstLogoSrc, alt: firstLogoAlt, role: "logo" },
    },
    img_hero: {
      id: "img_hero",
      type: "image",
      parentId: "sec_h",
      childrenIds: [],
      properties: { src: "https://example.com/hero.jpg", alt: "Hero" },
    },
    sec_f: { id: "sec_f", type: "section", parentId: "root", childrenIds: ["img_foot"], properties: {} },
    img_foot: {
      id: "img_foot",
      type: "image",
      parentId: "sec_f",
      childrenIds: [],
      properties: { src: "https://placehold.co/120x40", alt: "", role: "logo" },
    },
  } as unknown as EmailDocument;
}

describe("collectLogoBlockIds", () => {
  it("finds role-marked images anywhere in the tree and ignores ordinary ones", () => {
    expect(collectLogoBlockIds(buildFixtureDoc())).toEqual(["img_head", "img_foot"]);
  });
});

describe("getLogoBlockPromptState — the three states §5 names, plus the one it implies", () => {
  const doc = buildFixtureDoc();

  it("asks for a kit when the canvas has none", () => {
    expect(
      getLogoBlockPromptState({
        hasSavedKit: false,
        logoUrl: undefined,
        confirmedLogo: null,
        doc,
        blockId: "img_head",
      }),
    ).toEqual({ kind: "no-kit" });
  });

  it("asks for a logo when the kit carries none", () => {
    expect(
      getLogoBlockPromptState({
        hasSavedKit: true,
        logoUrl: undefined,
        confirmedLogo: null,
        doc,
        blockId: "img_head",
      }),
    ).toEqual({ kind: "no-logo" });
  });

  it("asks for CONFIRMATION — never an apply — while the logo is only a suggestion", () => {
    /* The distinction that matters: a suggestion is a third-party hotlink that */
    /* has not been rehosted, so decision 4 forbids it entering a document. */
    expect(
      getLogoBlockPromptState({
        hasSavedKit: true,
        logoUrl: "https://acme.com/logo.svg",
        confirmedLogo: null,
        doc,
        blockId: "img_head",
      }),
    ).toEqual({ kind: "unconfirmed" });
  });

  it("counts every logo block still on the wrong image once the logo is confirmed", () => {
    expect(
      getLogoBlockPromptState({
        hasSavedKit: true,
        logoUrl: CONFIRMED_LOGO.src,
        confirmedLogo: CONFIRMED_LOGO,
        doc,
        blockId: "img_head",
      }),
    ).toEqual({ kind: "ready", isBlockUsingLogo: false, staleBlockCount: 2 });
  });

  it("reports the selected block as done while other blocks still need it", () => {
    const state = getLogoBlockPromptState({
      hasSavedKit: true,
      logoUrl: CONFIRMED_LOGO.src,
      confirmedLogo: CONFIRMED_LOGO,
      doc: buildFixtureDoc({ firstLogoSrc: CONFIRMED_LOGO.src, firstLogoAlt: CONFIRMED_LOGO.alt }),
      blockId: "img_head",
    });
    expect(state).toEqual({ kind: "ready", isBlockUsingLogo: true, staleBlockCount: 1 });
  });
});

describe("buildLogoBlockUpdates — apply to one, or to all", () => {
  it("re-sources every logo block and leaves ordinary images alone", () => {
    expect(buildLogoBlockUpdates({ doc: buildFixtureDoc(), logo: CONFIRMED_LOGO })).toEqual([
      { blockId: "img_head", properties: CONFIRMED_LOGO },
      { blockId: "img_foot", properties: CONFIRMED_LOGO },
    ]);
  });

  it("restricts to the selected block when asked", () => {
    expect(
      buildLogoBlockUpdates({
        doc: buildFixtureDoc(),
        logo: CONFIRMED_LOGO,
        blockIds: ["img_head"],
      }),
    ).toEqual([{ blockId: "img_head", properties: CONFIRMED_LOGO }]);
  });

  it("skips a block already carrying the exact src and alt — no no-op undo entry", () => {
    const doc = buildFixtureDoc({ firstLogoSrc: CONFIRMED_LOGO.src, firstLogoAlt: CONFIRMED_LOGO.alt });
    expect(buildLogoBlockUpdates({ doc, logo: CONFIRMED_LOGO }).map((u) => u.blockId)).toEqual([
      "img_foot",
    ]);
  });

  it("still updates a block whose src matches but whose alt does not — the server's own rule", () => {
    const doc = buildFixtureDoc({ firstLogoSrc: CONFIRMED_LOGO.src, firstLogoAlt: "Old name logo" });
    expect(buildLogoBlockUpdates({ doc, logo: CONFIRMED_LOGO }).map((u) => u.blockId)).toContain(
      "img_head",
    );
  });
});

describe("describeLogoApplyScope", () => {
  it("names the scope so a bulk action is never unlabelled", () => {
    expect(describeLogoApplyScope(1)).toBe("Use brand logo here");
    expect(describeLogoApplyScope(3)).toBe("Use brand logo in all 3 logo blocks");
  });
});
