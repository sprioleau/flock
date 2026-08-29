import { describe, expect, it } from "vitest";
import {
  interpretPreSendReviewResponse,
  summarisePreSendReview,
  type PreSendReviewOutcome,
} from "./pre-send-review-client";

const FINDING = {
  id: "border-radius:btn_a",
  title: "border-radius is ignored in Outlook (Windows)",
  description: "the button labeled “Buy now” uses border-radius…",
  blockId: "btn_a",
};

describe("interpretPreSendReviewResponse", () => {
  it("reads a checked response into findings and the clients examined", () => {
    const outcome = interpretPreSendReviewResponse({
      isChecked: true,
      findings: [FINDING],
      checkedClientLabels: ["Outlook (Windows)"],
    });

    expect(outcome).toEqual({
      status: "ready",
      findings: [FINDING],
      checkedClientLabels: ["Outlook (Windows)"],
    });
  });

  it("reads a clean result as ready with nothing to say, not as unavailable", () => {
    const outcome = interpretPreSendReviewResponse({
      isChecked: true,
      findings: [],
      checkedClientLabels: ["Gmail (web)"],
    });

    expect(outcome.status).toBe("ready");
    expect(outcome.status === "ready" && outcome.findings).toEqual([]);
  });

  /*
    Everything that is not a well-formed checked result collapses to the same
    silent outcome. Each of these is a real possibility — an unrenderable
    document, an HTML error page from a proxy, a future response shape — and
    none of them is worth a message in a send dialog.
  */
  it.each([
    ["an unchecked result", { isChecked: false, message: "could not render" }],
    ["a non-object body", "unexpected"],
    ["null", null],
    ["a body with no isChecked", { findings: [] }],
    ["findings that are not an array", { isChecked: true, findings: "nope" }],
    ["findings that are not findings", { isChecked: true, findings: [{ oops: 1 }] }],
  ])("treats %s as no advice at all", (_label, body) => {
    expect(interpretPreSendReviewResponse(body)).toEqual({ status: "unavailable" });
  });

  it("survives a response with no client labels", () => {
    const outcome = interpretPreSendReviewResponse({ isChecked: true, findings: [] });

    expect(outcome).toEqual({ status: "ready", findings: [], checkedClientLabels: [] });
  });
});

describe("summarisePreSendReview", () => {
  /*
    THE SILENT STATES. While checking, and when the check could not run, the
    panel renders nothing — a null summary is what removes it from the dialog
    entirely. An advisory that cannot advise takes up no room.
  */
  it("says nothing while checking and nothing when unavailable", () => {
    expect(summarisePreSendReview({ status: "checking" })).toBeNull();
    expect(summarisePreSendReview({ status: "unavailable" })).toBeNull();
  });

  /*
    A clean result states its SCOPE. "No problems found" on its own is a claim
    about every inbox in the world; this tool looked at nine clients.
  */
  it("states how many clients a clean result covers", () => {
    const clean: PreSendReviewOutcome = {
      status: "ready",
      findings: [],
      checkedClientLabels: ["Gmail (web)", "Outlook (Windows)", "Yahoo Mail (web)"],
    };

    expect(summarisePreSendReview(clean)).toBe(
      "No client-support problems in 3 major email clients.",
    );
  });

  /*
    And a result with findings says, in the summary line itself, that none of
    them stops the send. This is the sentence a hesitant user reads first.
  */
  it("counts the findings and says outright that none of them blocks the send", () => {
    const one: PreSendReviewOutcome = {
      status: "ready",
      findings: [FINDING],
      checkedClientLabels: [],
    };
    const several: PreSendReviewOutcome = {
      status: "ready",
      findings: [FINDING, { ...FINDING, id: "b" }, { ...FINDING, id: "c" }],
      checkedClientLabels: [],
    };

    expect(summarisePreSendReview(one)).toBe(
      "1 thing to know before you send — none of them stops the send.",
    );
    expect(summarisePreSendReview(several)).toBe(
      "3 things to know before you send — none of them stops the send.",
    );
  });
});
