import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { chargeCreditForRequest as ChargeCreditForRequest } from "@/lib/auth/credits";
import { MOCK_MODEL_HEADER } from "@/lib/chat-contract";

/*
  POST /api/personas — the ONE property worth pinning at the HTTP boundary:
  a manual sweep's credit charge is decided from facts only the server knows.

  A manual sweep deliberately skips the server cooldown and the
  outline-unchanged skip (explicit human intent earns a fresh verdict), which
  leaves the credit as the only throttle on the route. `x-flock-mock: 1` is a
  header the client chooses to send, so it must not be able to exempt that
  charge — otherwise one header strips every limit at once and the run's real
  cost (findings rows, presence writes, invocations) is paid by nobody.

  The charge is stubbed to REFUSE so the assertion lands on the flag the route
  handed it, before any of the run's presence choreography or Convex writes.
*/

const chargeCreditForRequestMock = vi.hoisted(() =>
  vi.fn<typeof ChargeCreditForRequest>(),
);
const convexQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/credits", () => ({
  chargeCreditForRequest: chargeCreditForRequestMock,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = convexQueryMock;
    mutation = vi.fn();
  },
}));

import { POST } from "./route";

const DOCUMENT_KEY = "doc_not_a_demo";

beforeEach(() => {
  /*
    A deployment WITH a key configured — otherwise the missing key is itself a
    legitimate exemption and the test would pass for the wrong reason.
  */
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  chargeCreditForRequestMock.mockReset();
  chargeCreditForRequestMock.mockResolvedValue({
    isAllowed: false,
    isUnlimited: false,
    remaining: 0,
    message: "You've used today's AI allowance.",
  });
  convexQueryMock.mockReset();
  convexQueryMock.mockResolvedValue({
    documentId: DOCUMENT_KEY,
    isDemo: false,
    doc: {},
  });
});

afterEach(() => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
});

describe("POST /api/personas — manual sweep credit charge", () => {
  it("charges a credit for a manual sweep on a non-demo document even when the client asks for the mock", async () => {
    const response = await POST(
      new Request("http://localhost/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json", [MOCK_MODEL_HEADER]: "1" },
        body: JSON.stringify({
          documentId: DOCUMENT_KEY,
          personaSlugs: ["styling-recommender"],
          isManualSweep: true,
        }),
      }),
    );

    expect(chargeCreditForRequestMock).toHaveBeenCalledTimes(1);
    expect(chargeCreditForRequestMock.mock.calls[0]![0]).toMatchObject({ isMockRun: false });
    /*
      The charge was real, so refusing it stops the sweep.
    */
    expect(response.status).toBe(429);
  });
});
