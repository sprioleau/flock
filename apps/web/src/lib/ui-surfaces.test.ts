import { describe, expect, it, vi } from "vitest";
import { createUiIntentChannel, getShouldHandleUiIntent } from "./ui-surfaces";

/*
  The named-intent seam, checked where it can be checked. vitest pins
  `environment: "node"` for src/**, so the subscribing hook cannot be
  rendered — but everything the hook is a thin wrapper around is either a
  plain channel object or a pure predicate, and between them they hold the
  two properties that would actually break callers:

  - a request FIRES EVERY TIME, including a repeat of the same name (the
    /demo bug was a press that produced nothing on the second try);
  - a request reaches ONLY the host it names, and only once.
*/

describe("an intent channel", () => {
  it("hands subscribers the name that was requested", () => {
    const channel = createUiIntentChannel<"suggestions">();
    const listener = vi.fn();
    channel.subscribe(listener);

    expect(channel.getSnapshot()).toBeNull();
    channel.request("suggestions");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(channel.getSnapshot()?.name).toBe("suggestions");
  });

  it("gives a repeat request of the SAME name a fresh id", () => {
    /*
      The whole reason requests carry an id. Without it the second press of
      "Show the agents' cards" would produce an identical snapshot, React would
      see no change, and the visitor would get the silence this seam exists to
      remove.
    */
    const channel = createUiIntentChannel<"suggestions">();
    channel.request("suggestions");
    const first = channel.getSnapshot();
    channel.request("suggestions");
    const second = channel.getSnapshot();

    expect(second?.requestId).toBeGreaterThan(first?.requestId ?? 0);
  });

  it("stops notifying once a subscriber unsubscribes", () => {
    const channel = createUiIntentChannel<"suggestions">();
    const listener = vi.fn();
    channel.subscribe(listener)();

    channel.request("suggestions");

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps channels independent of one another", () => {
    /*
      "Open this panel" and "look over here" are separate vocabularies on
      purpose (see the file's note on why "suggestions" is not a UiPanel). If
      they shared module state, every panel host would wake up for an attention
      request naming a region it has never heard of.
    */
    const openListener = vi.fn();
    const attentionListener = vi.fn();
    const openChannel = createUiIntentChannel<"library">();
    const attentionChannel = createUiIntentChannel<"suggestions">();
    openChannel.subscribe(openListener);
    attentionChannel.subscribe(attentionListener);

    attentionChannel.request("suggestions");

    expect(attentionListener).toHaveBeenCalledTimes(1);
    expect(openListener).not.toHaveBeenCalled();
    expect(openChannel.getSnapshot()).toBeNull();
  });

  it("reports nothing requested during SSR", () => {
    /*
      The live value here would be a hydration mismatch: the server never
      issued the request the client is mid-way through handling.
    */
    const channel = createUiIntentChannel<"suggestions">();
    channel.request("suggestions");

    expect(channel.getServerSnapshot()).toBeNull();
  });
});

describe("deciding whether a request is mine", () => {
  it("ignores a request that names another host", () => {
    expect(
      getShouldHandleUiIntent({
        request: { name: "library", requestId: 4 },
        name: "history",
        lastHandledRequestId: 0,
      }),
    ).toBe(false);
  });

  it("ignores a request it has already run", () => {
    /*
      Hosts re-render for reasons that have nothing to do with this seam; a
      request must not be replayed on each one.
    */
    expect(
      getShouldHandleUiIntent({
        request: { name: "suggestions", requestId: 3 },
        name: "suggestions",
        lastHandledRequestId: 3,
      }),
    ).toBe(false);
  });

  it("runs a newer request that names it", () => {
    expect(
      getShouldHandleUiIntent({
        request: { name: "suggestions", requestId: 4 },
        name: "suggestions",
        lastHandledRequestId: 3,
      }),
    ).toBe(true);
  });
});
