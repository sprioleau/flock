import { describe, expect, it } from "vitest";
import { blockSchema } from "../schema/blocks";
import { blockIdSchema } from "../schema/ids";
import { createDemoDocument } from "./demo-document";
import { emailDocumentSchema } from "./document";
import { checkDocumentIntegrity } from "./integrity";

/*
  These tests guard the /demo seed's two PLANTED problems, not its prose. The
  copy is free to be edited; what must not change silently is that the planted
  problems are still there, because two honest advisory agents have nothing to
  say about an email without them — and /demo's entire premise is that they do.
*/

describe("createDemoDocument", () => {
  it("is schema-valid and integrity-valid", () => {
    const document = createDemoDocument();
    expect(emailDocumentSchema.safeParse(document).success).toBe(true);
    const integrity = checkDocumentIntegrity(document);
    expect(integrity.errors).toEqual([]);
    expect(integrity.isValid).toBe(true);
  });

  it("uses ids that follow the id scheme and match their record keys", () => {
    for (const [key, block] of Object.entries(createDemoDocument())) {
      expect(blockIdSchema.safeParse(key).success).toBe(true);
      expect(block.id).toBe(key);
      expect(blockSchema.safeParse(block).success).toBe(true);
    }
  });

  it("plants a tonal outlier: shouted hard-sell copy in an otherwise warm letter", () => {
    const document = createDemoDocument();
    const push = document.txt_push;
    expect(push?.type).toBe("text");
    const pushText = JSON.stringify(push?.properties);
    expect(pushText).toContain("LAST CHANCE");
    expect(pushText).toContain("RESERVE NOW");

    /* The plant only reads as a plant because the rest of the email does NOT
       shout — the Tone Police is instructed to judge tone against the email's
       own dominant voice and to stay quiet when the whole email is brash. */
    const opener = JSON.stringify(document.txt_lead?.properties);
    expect(opener).toContain("We set one aside for you.");
    expect(opener).not.toContain("LAST CHANCE");
  });

  it("plants two CTA buttons that have drifted apart on color, radius and alignment", () => {
    const document = createDemoDocument();
    const primary = document.btn_prim;
    const secondary = document.btn_scnd;
    if (primary?.type !== "button" || secondary?.type !== "button") {
      throw new Error("the demo seed must keep both CTA buttons");
    }
    expect(secondary.properties.backgroundColor).not.toBe(primary.properties.backgroundColor);
    expect(secondary.properties.borderRadius).not.toBe(primary.properties.borderRadius);
    expect(secondary.properties.align).not.toBe(primary.properties.align);
  });

  it("reads as a real send: a brand logo, an unsubscribe link and a postal address", () => {
    const document = createDemoDocument();
    /* The brand is read off the FIRST image's alt text (the "<Brand> logo"
       convention deriveDraftContentClues depends on). */
    const logo = document.img_logo;
    if (logo?.type !== "image") {
      throw new Error("the demo seed must open on the brand logo");
    }
    expect(logo.properties.alt).toBe("Harborlight Coffee logo");
    const footer = JSON.stringify(document.txt_foot?.properties);
    expect(footer).toContain("Unsubscribe");
    expect(footer).toContain("Rockport, ME");

    /* "Acme" was retired repo-wide as a placeholder brand; a demo a stranger
       is judging the product by must not reintroduce it. */
    expect(JSON.stringify(document).toLowerCase()).not.toContain("acme");
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const first = createDemoDocument();
    const second = createDemoDocument();
    expect(first).not.toBe(second);
    expect(first.btn_scnd).not.toBe(second.btn_scnd);
    expect(first).toEqual(second);
  });
});
