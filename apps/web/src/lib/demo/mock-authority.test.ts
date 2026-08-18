import { describe, expect, it } from "vitest";
import { selectIsMockForced } from "./mock-authority";

/*
  The spend rule for /api/chat and /api/personas, asserted directly.

  Every case here is a thing that would cost the owner money or credibility if
  it flipped: a public demo link that can be talked into spending a shared
  free-tier quota, or an ordinary draft that silently stops calling a model.
*/

describe("selectIsMockForced", () => {
  it("forces the mock on a demo document even when the client asks for a live run", () => {
    /* THE security property. The client is asking for real inference — no mock
       header — and the answer is still the mock, because the authority is the
       document row and the row is not something a request can edit. */
    expect(
      selectIsMockForced({ isDemoDocument: true, isMockRequestedByClient: false }),
    ).toBe(true);
  });

  it("leaves an ordinary document alone: the demo rule never reaches it", () => {
    /* A row with no `isDemo` — which is every row written before this field
       existed — must behave exactly as it did before: live inference, billed. */
    expect(
      selectIsMockForced({ isDemoDocument: false, isMockRequestedByClient: false }),
    ).toBe(false);
  });

  it("still honours a client asking for less spend on a non-demo document", () => {
    /* The one direction a client may move the outcome, and the reason it is
       safe: the header replaces the model, so there is no version of sending
       it that buys real inference. CI, a keyless clone and the settings FAB's
       dev toggle all depend on this staying true. */
    expect(
      selectIsMockForced({ isDemoDocument: false, isMockRequestedByClient: true }),
    ).toBe(true);
  });

  it("cannot be talked out of the mock by any combination on a demo document", () => {
    for (const isMockRequestedByClient of [true, false]) {
      expect(selectIsMockForced({ isDemoDocument: true, isMockRequestedByClient })).toBe(true);
    }
  });
});
