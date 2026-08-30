import { caniemail } from "caniemail";
import { describe, expect, it } from "vitest";
import { renderToHTML } from "../render/render-to-html";
import type { EmailDocument } from "../store/document";
import { createSampleDocument, createStarterDocument } from "../store/document";
import {
  checkEmailCompatibility,
  RENDERER_EMITTED_FEATURES,
  type CompatibilityFinding,
} from "./check-compatibility";
import { CHECKED_EMAIL_CLIENTS } from "./supported-clients";

/*
  A document built block by block, so a test can hold exactly one variable.

  The fixtures in store/document.ts are real emails and therefore carry many
  properties at once; that makes them the right thing to prove the checker
  works END TO END and the wrong thing to prove any single rule, because a
  finding could come from anywhere in them. These helpers give the tests a
  document where the only interesting thing is the one property under test.
*/
function buildDocument(blocks: EmailDocument): EmailDocument {
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_one"],
      properties: { globals: {} },
    },
    sec_one: {
      id: "sec_one",
      type: "section",
      parentId: "root",
      childrenIds: Object.keys(blocks),
      properties: {},
    },
    ...Object.fromEntries(
      Object.entries(blocks).map(([blockId, block]) => [
        blockId,
        { ...block, parentId: "sec_one" },
      ]),
    ),
  };
}

function paragraphBlock(blockId: string, text: string) {
  return {
    id: blockId,
    type: "text" as const,
    parentId: "sec_one",
    childrenIds: [],
    properties: {
      text: {
        type: "doc" as const,
        content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
      },
    },
  };
}

function buttonBlock(blockId: string, styles: Record<string, number>) {
  return {
    id: blockId,
    type: "button" as const,
    parentId: "sec_one",
    childrenIds: [],
    properties: { label: "Buy now", href: "https://example.com", ...styles },
  };
}

async function findingsFor(doc: EmailDocument): Promise<CompatibilityFinding[]> {
  const result = await checkEmailCompatibility({ doc });
  expect(result.isChecked).toBe(true);
  return result.isChecked ? result.findings : [];
}

describe("checkEmailCompatibility", () => {
  /*
    THE NEGATIVE CASE, and the most important test in the file. A checker that
    reports on every email is exactly as useless as one that reports on none,
    and it is the far easier failure to ship because it looks like the feature
    working. This document uses nothing but default properties: no rounded
    corners, no image, no code block. It must say nothing.
  */
  it("says nothing about an email whose blocks carry no styling of their own", async () => {
    const doc = buildDocument({ txt_a: paragraphBlock("txt_a", "Hello there.") });

    expect(await findingsFor(doc)).toEqual([]);
  });

  /*
    The pin on RENDERER_EMITTED_FEATURES: every entry must be something the
    renderer actually produces on a document nobody has styled. Without this,
    the constant is a place to make an inconvenient finding disappear — add a
    title, and the check goes quiet about a real problem forever.
  */
  it("suppresses only features the renderer really does emit on an unstyled email", async () => {
    const doc = buildDocument({
      txt_a: paragraphBlock("txt_a", "Hello there."),
      img_a: {
        id: "img_a",
        type: "image",
        parentId: "sec_one",
        childrenIds: [],
        properties: { src: "https://example.com/a.png", alt: "A photo", href: "https://example.com" },
      },
      spc_a: {
        id: "spc_a",
        type: "spacer",
        parentId: "sec_one",
        childrenIds: [],
        properties: { height: 24 },
      },
      lnk_a: {
        id: "lnk_a",
        type: "link",
        parentId: "sec_one",
        childrenIds: [],
        properties: { text: "Read more", href: "https://example.com" },
      },
    });
    const html = await renderToHTML(doc, { isBlockAnnotated: true });
    const raw = caniemail({ clients: [...CHECKED_EMAIL_CLIENTS], html });
    const rawTitles = new Set<string>();
    for (const [, issues] of raw.issues.errors) {
      for (const issue of issues) {
        rawTitles.add(issue.title);
      }
    }

    /*
      Nothing in the constant is dead: each entry is genuinely emitted here.
    */
    expect([...RENDERER_EMITTED_FEATURES].sort()).toEqual([...rawTitles].sort());
    /*
      And suppression fully explains the floor: an unstyled email is silent.
    */
    expect(await findingsFor(doc)).toEqual([]);
  });

  /*
    THE POSITIVE CASE. A button with rounded corners is reported against
    Word-engine Outlook and nothing else, with the client named rather than
    counted.

    A KNOWN FALSE POSITIVE lives here, found by this test rather than by a
    user, and it is a renderer wart rather than a checker one: ButtonBlockView
    emits `border-radius` unconditionally (`${borderRadius}px`), so a button
    set to a radius of ZERO still ships `border-radius:0px` and is still
    flagged — a warning that Outlook will square corners that are already
    square. ImageBlockView, two files away, already does the right thing and
    omits the declaration at zero. Making the button match it is a one-line
    change, but it alters the HTML a subscriber receives and one golden
    snapshot, so it is reported rather than smuggled in with an analysis
    feature. The test asserts the behaviour that exists, and names the one that
    should.
  */
  it("reports a button's rounded corners against Word-engine Outlook, and names the client", async () => {
    const rounded = buildDocument({ btn_a: buttonBlock("btn_a", { borderRadius: 12 }) });

    const findings = await findingsFor(rounded);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.featureTitle).toBe("border-radius");
    expect(findings[0]?.affectedClients).toEqual(["outlook.windows"]);
    expect(findings[0]?.affectedClientLabels).toEqual(["Outlook (Windows)"]);
  });

  /*
    The wart above, pinned so it cannot change unnoticed: if the renderer is
    fixed to omit a zero radius, this test fails and says exactly why.
  */
  it("still reports a button whose radius is zero, because the renderer emits the declaration anyway", async () => {
    const square = buildDocument({ btn_a: buttonBlock("btn_a", { borderRadius: 0 }) });

    expect((await findingsFor(square)).map((finding) => finding.featureTitle)).toEqual([
      "border-radius",
    ]);
  });

  /*
    BLOCK ATTRIBUTION, and the assertion the whole feature stands on.

    "A finding came back with a block id" passes for free, so the fixture is
    built to make every cheap answer wrong. The document holds three blocks —
    a silent paragraph, the rounded button, another silent paragraph — all
    inside one section, and the button is run in BOTH the middle and the first
    position. A checker that named the first block, the last block, the
    enclosing section, or the nearest preceding stamp would pass one ordering
    and fail the other. Only a real trace from the HTML range back through the
    annotated render names the button every time.
  */
  it("names the block that carries the problem, whatever its position among silent siblings", async () => {
    const buttonInMiddle = buildDocument({
      txt_before: paragraphBlock("txt_before", "Some words."),
      btn_a: buttonBlock("btn_a", { borderRadius: 16 }),
      txt_after: paragraphBlock("txt_after", "More words."),
    });
    const buttonFirst = buildDocument({
      btn_a: buttonBlock("btn_a", { borderRadius: 16 }),
      txt_after: paragraphBlock("txt_after", "More words."),
    });

    for (const doc of [buttonInMiddle, buttonFirst]) {
      const findings = await findingsFor(doc);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.blockId).toBe("btn_a");
    }
  });

  it("keeps two blocks with the same problem as two findings, each on its own block", async () => {
    const doc = buildDocument({
      btn_first: buttonBlock("btn_first", { borderRadius: 16 }),
      btn_second: buttonBlock("btn_second", { borderRadius: 16 }),
    });

    const findings = await findingsFor(doc);

    expect(findings.map((finding) => finding.blockId).sort()).toEqual(["btn_first", "btn_second"]);
  });

  /*
    caniemail reports the same feature once per affected client. A user has one
    problem with one button, so the clients collapse into one finding — and the
    list must be the real set, not a count.
  */
  it("collapses one feature on one block into a single finding listing every affected client", async () => {
    const doc = buildDocument({
      cod_a: {
        id: "cod_a",
        type: "code",
        parentId: "sec_one",
        childrenIds: [],
        properties: { code: "const x = 1;", language: "javascript" },
      },
    });

    const findings = await findingsFor(doc);
    const hyphens = findings.filter((finding) => finding.featureTitle === "hyphens");

    expect(hyphens).toHaveLength(1);
    expect(hyphens[0]?.affectedClients.length).toBeGreaterThan(1);
    /*
      Sorted, deduplicated real client ids — every one from the checked set.
    */
    expect(hyphens[0]?.affectedClients).toEqual([...hyphens[0]!.affectedClients].sort());
    for (const client of hyphens[0]?.affectedClients ?? []) {
      expect(CHECKED_EMAIL_CLIENTS).toContain(client);
    }
  });

  it("orders findings by how many clients they break, widest first", async () => {
    const doc = buildDocument({
      btn_a: buttonBlock("btn_a", { borderRadius: 16 }),
      cod_a: {
        id: "cod_a",
        type: "code",
        parentId: "sec_one",
        childrenIds: [],
        properties: { code: "const x = 1;", language: "javascript" },
      },
    });

    const findings = await findingsFor(doc);
    const clientCounts = findings.map((finding) => finding.affectedClients.length);

    expect(clientCounts).toEqual([...clientCounts].sort((left, right) => right - left));
    /*
      The single-client button finding must not be first.
    */
    expect(findings[0]?.affectedClients.length).toBeGreaterThan(1);
  });

  it("caps the list rather than returning a wall", async () => {
    const doc = buildDocument({
      cod_a: {
        id: "cod_a",
        type: "code",
        parentId: "sec_one",
        childrenIds: [],
        properties: { code: "const x = 1;", language: "javascript" },
      },
      btn_a: buttonBlock("btn_a", { borderRadius: 16 }),
    });

    const capped = await checkEmailCompatibility({ doc, maxFindings: 2 });
    const uncapped = await checkEmailCompatibility({ doc, maxFindings: 50 });

    expect(capped.isChecked && capped.findings).toHaveLength(2);
    expect(uncapped.isChecked && uncapped.findings.length).toBeGreaterThan(2);
  });

  /*
    A broken document rides the SUCCESS channel with a descriptive payload —
    the pattern lib/create-draft-report.ts established. The reason a caller
    must not receive a throw here is the feature's whole posture: this is
    advisory, and an exception is the one result shape a send path cannot
    ignore.
  */
  it("reports an unrenderable document as an unchecked result, never as a throw", async () => {
    const broken: EmailDocument = {
      root: {
        id: "root",
        type: "root",
        parentId: null,
        childrenIds: ["sec_missing"],
        properties: { globals: {} },
      },
    };

    const result = await checkEmailCompatibility({ doc: broken });

    expect(result.isChecked).toBe(false);
    expect(result.isChecked === false && result.message).toContain("could not be rendered");
  });

  it("says which clients it asked about, so a clean result has a stated scope", async () => {
    const result = await checkEmailCompatibility({
      doc: buildDocument({ txt_a: paragraphBlock("txt_a", "Hello.") }),
    });

    expect(result.isChecked && result.checkedClients).toEqual(CHECKED_EMAIL_CLIENTS);
  });

  /*
    The annotation must be INERT. The checker analyses a render the user never
    receives, so if stamping changed which findings appear, every finding would
    be about a document that does not exist. Comparing the raw caniemail output
    of the annotated and unannotated renders is the direct test of that.
  */
  it("finds exactly the same problems with and without the block stamps", async () => {
    const doc = createSampleDocument();
    const titlesFor = async (isBlockAnnotated: boolean) => {
      const html = await renderToHTML(doc, { isBlockAnnotated });
      const result = caniemail({ clients: [...CHECKED_EMAIL_CLIENTS], html });
      const rows: string[] = [];
      for (const [client, issues] of result.issues.errors) {
        for (const issue of issues) {
          rows.push(`${client}|${issue.title}`);
        }
      }
      return rows.sort();
    };

    expect(await titlesFor(true)).toEqual(await titlesFor(false));
  });

  it("never mutates the document it checks", async () => {
    const doc = createStarterDocument();
    const before = JSON.stringify(doc);

    await checkEmailCompatibility({ doc });

    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("checkEmailCompatibility on the real fixtures", () => {
  /*
    The end-to-end proof, on the email a new Flock user actually starts from.
    Pinned exactly: the starter document has ONE compatibility problem, its
    call-to-action button's rounded corners, which Word-engine Outlook renders
    square. If the starter email ever grows a second one, this test is where
    that gets noticed — before a user is the one who notices.
  */
  it("finds exactly one problem in the starter email: the CTA button's corners in Outlook", async () => {
    const findings = await findingsFor(createStarterDocument());

    expect(findings).toEqual([
      {
        featureTitle: "border-radius",
        blockId: "btn_ct01",
        affectedClients: ["outlook.windows"],
        affectedClientLabels: ["Outlook (Windows)"],
        notes: [
          "Round corners can be used in VML with the `RoundRect` element. See [buttons.cm](https://buttons.cm/) and [VML documentation](https://docs.microsoft.com/en-us/windows/win32/vml/msdn-online-vml-roundrect-element).",
        ],
      },
    ]);
  });

  it("traces every finding in the sample email to a real block of that email", async () => {
    const doc = createSampleDocument();
    const findings = await findingsFor(doc);

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      /*
        Undefined would be honest but is not what this document produces —
        every problem in it comes from a block, so every finding names one.
      */
      expect(finding.blockId).toBeDefined();
      expect(Object.keys(doc)).toContain(finding.blockId);
    }
  });
});
