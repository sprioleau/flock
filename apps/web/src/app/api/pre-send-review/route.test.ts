import { createStarterDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import type { PreSendReviewResponseBody } from "./contract";
import { POST } from "./route";

/*
  The route end to end, against the real renderer and the real caniemail
  dataset. Nothing is mocked, because there is nothing here worth mocking: the
  check makes no model call and no network call, so the test runs the exact
  code path a user's browser does.
*/
function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://flock.test/api/pre-send-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readBody(response: Response): Promise<PreSendReviewResponseBody> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || !("isChecked" in parsed)) {
    throw new Error(`Response body was not a review result: ${JSON.stringify(parsed)}`);
  }
  const record: Record<string, unknown> = { ...parsed };
  if (record.isChecked === true && Array.isArray(record.findings)) {
    return {
      isChecked: true,
      findings: record.findings,
      checkedClientLabels: Array.isArray(record.checkedClientLabels)
        ? record.checkedClientLabels
        : [],
    };
  }
  return { isChecked: false, message: String(record.message) };
}

describe("POST /api/pre-send-review", () => {
  /*
    THE REAL ANSWER FOR THE REAL STARTER EMAIL, asserted verbatim. This is the
    email every new Flock user begins from, and this test is the record of what
    the tool says about it: one thing, about the call-to-action button's
    corners in Word-engine Outlook, phrased so nobody reads it as a reason not
    to send.
  */
  it("reviews the starter email and reports the CTA button's corners, in plain English", async () => {
    const response = await post({ document: createStarterDocument() });
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.isChecked).toBe(true);
    if (!body.isChecked) {
      return;
    }
    expect(body.findings).toEqual([
      {
        id: "border-radius:btn_ct01",
        title: "border-radius is ignored in Outlook (Windows)",
        description:
          "the button labeled “Get started” uses border-radius, which Outlook (Windows) does not support. " +
          "The email still sends and still reads correctly there — that styling is simply dropped.",
        blockId: "btn_ct01",
      },
    ]);
  });

  /*
    The scope of a clean result, stated. "No problems found" without saying
    what was examined is a claim the tool cannot support.
  */
  it("names the clients it examined", async () => {
    const body = await readBody(await post({ document: createStarterDocument() }));

    expect(body.isChecked && body.checkedClientLabels).toContain("Outlook (Windows)");
    expect(body.isChecked && body.checkedClientLabels).toContain("Gmail (web)");
    expect(body.isChecked && body.checkedClientLabels).toHaveLength(9);
  });

  /*
    NEGATIVE CASE: a plain email produces an empty findings array on a 200 —
    not a 204, not an error, not a missing field. A caller must be able to tell
    "checked, nothing to say" from "could not check".
  */
  it("returns an empty finding list for an email with no client-support problems", async () => {
    const response = await post({
      document: {
        root: {
          id: "root",
          type: "root",
          parentId: null,
          childrenIds: ["sec_0001"],
          properties: { globals: {} },
        },
        sec_0001: {
          id: "sec_0001",
          type: "section",
          parentId: "root",
          childrenIds: ["txt_0001"],
          properties: {},
        },
        txt_0001: {
          id: "txt_0001",
          type: "text",
          parentId: "sec_0001",
          childrenIds: [],
          properties: {
            text: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello." }] }] },
          },
        },
      },
    });
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.isChecked && body.findings).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("https://flock.test/api/pre-send-review", {
        method: "POST",
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
  });

  it("rejects a body that is not a document", async () => {
    const response = await post({ document: { nope: true } });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_document" });
  });

  /*
    A structurally broken document is a 200 with `isChecked: false`, not a 5xx.
    It is an outcome of reviewing, and a send dialog must never see a review
    problem as a server problem — see the route's own note.
  */
  it("reports an unrenderable document as an unchecked 200, never as a server error", async () => {
    const response = await post({
      document: {
        root: {
          id: "root",
          type: "root",
          parentId: null,
          childrenIds: ["sec_9999"],
          properties: { globals: {} },
        },
      },
    });
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.isChecked).toBe(false);
    expect(body.isChecked === false && body.message).toContain("could not be rendered");
  });

  /*
    DETERMINISM, which is the property that makes this worth replacing a model
    call with. The same document must give the same answer every time — a
    persona run cannot promise that, and this can.
  */
  it("gives the same answer twice for the same document", async () => {
    const first = await readBody(await post({ document: createStarterDocument() }));
    const second = await readBody(await post({ document: createStarterDocument() }));

    expect(first).toEqual(second);
  });
});
