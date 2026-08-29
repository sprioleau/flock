import { createStarterDocument, type Block, type EmailDocument } from "@flock/email-sdk";
import type { CompatibilityFinding } from "@flock/email-sdk/qa";
import { describe, expect, it } from "vitest";
import { describeBlock, joinClientLabels, toPreSendReviewFinding } from "./review-copy";

const DOC: EmailDocument = createStarterDocument();

function findingFor(overrides: Partial<CompatibilityFinding> = {}): CompatibilityFinding {
  return {
    featureTitle: "border-radius",
    blockId: "btn_ct01",
    affectedClients: ["outlook.windows"],
    affectedClientLabels: ["Outlook (Windows)"],
    notes: [],
    ...overrides,
  };
}

describe("describeBlock", () => {
  /*
    The rule the persona findings already follow, applied here: a user is
    referred to their own content by its visible words, never by a block id.
    These assertions quote the starter email's real copy, so a change that
    started emitting ids instead cannot pass.
  */
  it("names a button by its visible label", () => {
    expect(describeBlock(DOC.btn_ct01)).toBe('the button labeled “Get started”');
  });

  it("names an image by its alt text", () => {
    expect(describeBlock(DOC.img_lg01)).toBe('the image “Flock logo”');
  });

  it("names a text block by the words it starts with", () => {
    expect(describeBlock(DOC.txt_wc01)).toBe('the text starting “Welcome to Flock.”');
  });

  /* `img_hr01`'s alt text is 36 characters, past the 32-character quote
     budget, so it must come back trimmed with an ellipsis rather than pasting
     a sentence into a dialog line. */
  it("truncates a long quotation rather than pasting a whole sentence into a dialog", () => {
    expect(describeBlock(DOC.img_hr01)).toBe("the image “Placeholder image — swap in you…”");
  });

  /*
    A block with nothing visible to quote gets its KIND and no invention. The
    alternative failure — "the hero image" — reads better and asserts something
    the code does not know.
  */
  it("falls back to the kind of block when there is nothing to quote", () => {
    const untitledImage: Block = {
      id: "img_x",
      type: "image",
      parentId: "sec_hdr1",
      childrenIds: [],
      properties: { src: "https://example.com/a.png", alt: "" },
    };

    expect(describeBlock(untitledImage)).toBe("an image");
  });

  it("calls a finding with no block the email itself", () => {
    expect(describeBlock(undefined)).toBe("the email itself");
  });
});

describe("joinClientLabels", () => {
  it("reads as a sentence for one, two, and three clients", () => {
    expect(joinClientLabels(["Gmail (web)"])).toBe("Gmail (web)");
    expect(joinClientLabels(["Gmail (web)", "Outlook (Windows)"])).toBe(
      "Gmail (web) and Outlook (Windows)",
    );
    expect(joinClientLabels(["Gmail (web)", "Outlook (Windows)", "Yahoo Mail (web)"])).toBe(
      "Gmail (web), Outlook (Windows) and Yahoo Mail (web)",
    );
  });

  /* Past three, the count carries the weight and the list stops being read. */
  it("summarises the tail instead of listing every client", () => {
    expect(
      joinClientLabels(["Gmail (web)", "Outlook (Windows)", "Yahoo Mail (web)", "Outlook.com"]),
    ).toBe("Gmail (web), Outlook (Windows) and 2 others");
  });
});

describe("toPreSendReviewFinding", () => {
  it("writes a sentence naming the block, the feature and the clients", () => {
    const finding = toPreSendReviewFinding({ finding: findingFor(), doc: DOC });

    expect(finding.title).toBe("border-radius is ignored in Outlook (Windows)");
    expect(finding.description).toBe(
      "the button labeled “Get started” uses border-radius, which Outlook (Windows) does not support. " +
        "The email still sends and still reads correctly there — that styling is simply dropped.",
    );
    expect(finding.blockId).toBe("btn_ct01");
  });

  /*
    THE POSTURE, in the copy itself. Everything else in this feature enforces
    "advisory, never blocking" structurally; this is the one place a user reads
    it. A description that stopped at "does not support" would leave someone
    believing their email is broken in Outlook, which is both false and the
    likeliest reason they would not send.
  */
  it("always says the email still sends", () => {
    for (const clients of [["Gmail (web)"], ["Gmail (web)", "Outlook (Windows)"]]) {
      const finding = toPreSendReviewFinding({
        finding: findingFor({ affectedClientLabels: clients }),
        doc: DOC,
      });
      expect(finding.description).toContain("The email still sends");
    }
  });

  it("agrees its verb with the number of clients", () => {
    const one = toPreSendReviewFinding({ finding: findingFor(), doc: DOC });
    const many = toPreSendReviewFinding({
      finding: findingFor({ affectedClientLabels: ["Gmail (web)", "Outlook (Windows)"] }),
      doc: DOC,
    });

    expect(one.description).toContain("does not support");
    expect(many.description).toContain("do not support");
  });

  it("keeps two findings about different blocks distinguishable by id", () => {
    const first = toPreSendReviewFinding({ finding: findingFor({ blockId: "btn_ct01" }), doc: DOC });
    const second = toPreSendReviewFinding({ finding: findingFor({ blockId: "img_lg01" }), doc: DOC });

    expect(first.id).not.toBe(second.id);
  });

  it("describes a document-level finding without attaching it to a block", () => {
    const finding = toPreSendReviewFinding({ finding: findingFor({ blockId: undefined }), doc: DOC });

    expect(finding.blockId).toBeUndefined();
    expect(finding.description).toContain("the email itself");
  });
});
