import { createSampleDocument, createTextDoc, ROOT_BLOCK_ID, type Block } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { collectSectionSubtree } from "@/lib/saved-sections";
import {
  analyzeSectionSubtree,
  buildDeterministicEnrichment,
  buildEnrichmentPrompt,
  savedSectionEnrichmentSchema,
} from "./enrichment";

/**
 * The DETERMINISTIC enrichment path (mock header / no API key / model
 * failure): pure structural analysis — the quota-free floor every saved row
 * gets. The model path shares the output schema pinned here.
 */

function buildFooterSubtree(): Block[] {
  return [
    {
      id: "sec_foot",
      type: "section",
      parentId: ROOT_BLOCK_ID,
      childrenIds: ["txt_lgl1", "lnk_uns1"],
      properties: {},
    },
    {
      id: "txt_lgl1",
      type: "text",
      parentId: "sec_foot",
      childrenIds: [],
      properties: { text: createTextDoc("© 2026 Acme Inc. All rights reserved.") },
    },
    {
      id: "lnk_uns1",
      type: "link",
      parentId: "sec_foot",
      childrenIds: [],
      properties: { text: "Unsubscribe", href: "https://acme.com/unsubscribe" },
    },
  ] as unknown as Block[];
}

function buildHeaderSubtree(): Block[] {
  return [
    {
      id: "sec_head",
      type: "section",
      parentId: ROOT_BLOCK_ID,
      childrenIds: ["img_logo"],
      properties: {},
    },
    {
      id: "img_logo",
      type: "image",
      parentId: "sec_head",
      childrenIds: [],
      properties: { src: "https://acme.com/brand/logo.png", alt: "Acme logo" },
    },
  ] as unknown as Block[];
}

describe("analyzeSectionSubtree (pure structural read)", () => {
  it("detects footer signals: legal text, unsubscribe link", () => {
    const inventory = analyzeSectionSubtree(buildFooterSubtree());
    expect(inventory.hasLegalText).toBe(true);
    expect(inventory.hasUnsubscribeText).toBe(true);
    expect(inventory.standaloneLinkCount).toBe(1);
  });

  it("detects a logo image from alt/src", () => {
    const inventory = analyzeSectionSubtree(buildHeaderSubtree());
    expect(inventory.hasLogoImage).toBe(true);
    expect(inventory.imageCount).toBe(1);
  });

  it("reads rows/columns, headings, and button labels from a real section", () => {
    const doc = createSampleDocument();
    const root = doc[ROOT_BLOCK_ID]!;
    // Analyze every sample section; at least one must show layout + a button.
    const inventories = root.childrenIds.map((sectionId) =>
      analyzeSectionSubtree(collectSectionSubtree({ doc, sectionId })!),
    );
    expect(inventories.some((inventory) => inventory.buttonLabels.length > 0)).toBe(true);
    expect(inventories.some((inventory) => inventory.headingTexts.length > 0)).toBe(true);
  });
});

describe("buildDeterministicEnrichment", () => {
  it("classifies a legal/unsubscribe section as a closing footer", () => {
    const enrichment = buildDeterministicEnrichment(buildFooterSubtree());
    expect(enrichment.useWhen).toContain("closing footer");
    expect(enrichment.description).toContain("legal/unsubscribe");
    // Output shape matches the model path's schema.
    expect(savedSectionEnrichmentSchema.safeParse(enrichment).success).toBe(true);
  });

  it("classifies a logo-only section as a branded header", () => {
    const enrichment = buildDeterministicEnrichment(buildHeaderSubtree());
    expect(enrichment.useWhen).toContain("header");
    expect(enrichment.description).toContain("logo");
  });

  it("quotes the heading for an announcement-shaped section", () => {
    const blocks = [
      {
        id: "sec_promo",
        type: "section",
        parentId: ROOT_BLOCK_ID,
        childrenIds: ["txt_h1", "btn_cta"],
        properties: {},
      },
      {
        id: "txt_h1",
        type: "text",
        parentId: "sec_promo",
        childrenIds: [],
        properties: {
          text: {
            type: "doc",
            content: [
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Spring Launch" }] },
            ],
          },
        },
      },
      {
        id: "btn_cta",
        type: "button",
        parentId: "sec_promo",
        childrenIds: [],
        properties: { label: "Shop now", href: "https://acme.com/shop" },
      },
    ] as unknown as Block[];
    const enrichment = buildDeterministicEnrichment(blocks);
    expect(enrichment.useWhen).toContain("Spring Launch");
    expect(enrichment.description).toContain('"Shop now" button');
  });
});

describe("buildEnrichmentPrompt", () => {
  it("carries the name, the outline, and every selection axis", () => {
    const prompt = buildEnrichmentPrompt({ name: "My footer", outline: "root\n  sec_a section" });
    expect(prompt).toContain('"My footer"');
    expect(prompt).toContain("sec_a section");
    for (const axisKeyword of [
      "Layout structure",
      "Content inventory",
      "Purpose/genre",
      "Tone and density",
      "Personalization",
      "Placement affinity",
      "Theme coupling",
    ]) {
      expect(prompt).toContain(axisKeyword);
    }
  });
});
