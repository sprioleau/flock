import { describe, expect, it } from "vitest";
import type { BlockId } from "../schema/ids";
import { createSampleDocument, type EmailDocument } from "../store/document";
import { emailActionRegistry } from "./builtins";
import type { ActionContext } from "./context";
import {
  GMAIL_CLIPPING_BYTE_LIMIT,
  inspectRenderedEmail,
  inspectRenderedEmailAction,
  RENDERED_TEXT_MAX_CHARACTERS,
  RENDERED_TEXT_TRUNCATION_MARKER,
  RENDER_FAILURE_MESSAGE_MAX_CHARACTERS,
} from "./inspect-rendered-email";
import { dispatchAnalysisAction, getAction } from "./registry";

/**
 * The agent reading back what it built. These pin the promises the tool makes
 * to the model — the shape, the bound, and the honest failure — NOT the
 * renderers underneath, which have their own tests in ../render.
 */

const anyCaller: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
};

/**
 * An email far bigger than anything a person would send: 150 text blocks of
 * ~600 characters each, i.e. roughly 90,000 characters of copy. The point is
 * that the tool's result must not grow with it — a bound that only holds for
 * realistic documents is not a bound, and "the model built something enormous"
 * is exactly the moment it most needs to be able to look at it safely.
 */
function createOversizedDocument(): EmailDocument {
  const paragraph = "Every word here is filler that a real email would never contain. ".repeat(10);
  const textBlockIds: BlockId[] = [];
  const doc: EmailDocument = {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_0000"],
      properties: { globals: {} },
    },
    sec_0000: {
      id: "sec_0000",
      type: "section",
      parentId: "root",
      childrenIds: textBlockIds,
      properties: {},
    },
  };
  for (let index = 0; index < 150; index += 1) {
    const blockId: BlockId = `txt_${index.toString(36).padStart(4, "0")}`;
    textBlockIds.push(blockId);
    doc[blockId] = {
      id: blockId,
      type: "text",
      parentId: "sec_0000",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: paragraph }] }],
        },
      },
    };
  }
  return doc;
}

/**
 * A document whose root promises 80 children it does not have — one integrity
 * error per dangling id, so the renderer's own error message is long enough to
 * prove the failure arm is capped too.
 */
function createStructurallyBrokenDocument(): EmailDocument {
  const missingIds: BlockId[] = [];
  for (let index = 0; index < 80; index += 1) {
    missingIds.push(`txt_${index.toString(36).padStart(4, "0")}`);
  }
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: missingIds,
      properties: { globals: {} },
    },
  };
}

describe("inspectRenderedEmail", () => {
  it("returns the email's copy as text, plus the facts about the HTML it never returns", async () => {
    const result = await inspectRenderedEmail({ doc: createSampleDocument() });

    expect(result.isRendered).toBe(true);
    if (!result.isRendered) {
      return;
    }
    // The words a reader sees — including the link destination a button hides.
    expect(result.plainText).toContain("Ready to ride?");
    expect(result.plainText).toContain("https://example.com/start");
    // ...and none of the markup they don't.
    expect(result.plainText).not.toContain("<td");
    expect(result.plainText).not.toContain("DOCTYPE");
    expect(result.isPlainTextTruncated).toBe(false);
    expect(result.plainTextCharacterCount).toBe(result.plainText.length);
    // The HTML is measured, not returned: a real email is always bigger than
    // its own words, and a normal one is nowhere near Gmail's clip threshold.
    expect(result.htmlByteCount).toBeGreaterThan(result.plainTextCharacterCount);
    expect(result.htmlByteCount).toBeLessThan(GMAIL_CLIPPING_BYTE_LIMIT);
    expect(result.isAtRiskOfGmailClipping).toBe(false);
  });

  it("stays bounded on a huge email, even when the caller asks for everything", async () => {
    const doc = createOversizedDocument();

    const result = await inspectRenderedEmail({ doc, maxCharacters: 1_000_000 });

    expect(result.isRendered).toBe(true);
    if (!result.isRendered) {
      return;
    }
    // The request was clamped, not honoured — this is the invariant that keeps
    // a self-check from costing more context than the work it is checking.
    expect(result.plainText.length).toBeLessThanOrEqual(RENDERED_TEXT_MAX_CHARACTERS);
    expect(result.plainText.endsWith(RENDERED_TEXT_TRUNCATION_MARKER)).toBe(true);
    expect(result.isPlainTextTruncated).toBe(true);
    // The full length is still reported, so the model knows what it is missing.
    expect(result.plainTextCharacterCount).toBeGreaterThan(RENDERED_TEXT_MAX_CHARACTERS * 4);
    // Worst case for the whole serialized result is a constant, not a function
    // of the document: the text cap plus a fixed handful of small numbers.
    expect(JSON.stringify(result).length).toBeLessThan(RENDERED_TEXT_MAX_CHARACTERS + 500);
    // An email this size really would be clipped, and the flag says so.
    expect(result.htmlByteCount).toBeGreaterThanOrEqual(GMAIL_CLIPPING_BYTE_LIMIT);
    expect(result.isAtRiskOfGmailClipping).toBe(true);
  });

  it("reports a document that cannot be rendered instead of throwing, and caps the reason", async () => {
    const result = await inspectRenderedEmail({ doc: createStructurallyBrokenDocument() });

    expect(result.isRendered).toBe(false);
    if (result.isRendered) {
      return;
    }
    expect(result.message.length).toBeLessThanOrEqual(RENDER_FAILURE_MESSAGE_MAX_CHARACTERS);
    expect(result.message.endsWith(RENDERED_TEXT_TRUNCATION_MARKER)).toBe(true);
    expect(result.message).toContain("could not be rendered");
  });
});

describe("inspectRenderedEmailAction", () => {
  it("is a read-only, parallel-safe, unapproved analysis action in the built-in registry", () => {
    expect(getAction(emailActionRegistry, "inspectRenderedEmail")).toBe(inspectRenderedEmailAction);
    expect(inspectRenderedEmailAction.kind).toBe("analysis");
    expect(inspectRenderedEmailAction.readOnly).toBe(true);
    expect(inspectRenderedEmailAction.parallelSafe).toBe(true);
    expect(inspectRenderedEmailAction.needsApproval).toBe(false);
  });

  it("runs through the analysis dispatcher on the empty input the model can always send", async () => {
    const result = dispatchAnalysisAction({
      registry: emailActionRegistry,
      doc: createSampleDocument(),
      name: "inspectRenderedEmail",
      input: {},
      context: anyCaller,
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) {
      return;
    }
    expect(result.isApprovalRequired).toBe(false);
    // Analysis runs may be promises; this one is (rendering is async).
    const data = await result.data;
    expect(data).toMatchObject({ isRendered: true });
  });
});
