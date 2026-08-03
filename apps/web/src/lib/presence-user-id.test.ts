import { describe, expect, it } from "vitest";
import { derivePresenceUserId, deriveIdentity } from "@/lib/presence";

/**
 * The presence roster is published to every holder of a document link, so the
 * id we put in it is handed to strangers. It must not be the session id, which
 * is the pre-auth ownership key for brand kits, assets, saved sections and
 * personas (convex/authIdentity.ts). These tests pin that property — a
 * "simplification" back to `userId: sessionId` reopens the leak silently,
 * because everything on screen keeps working.
 */

/** Shaped like the real thing: `getOrCreateSessionId` mints a UUID v4. */
const SESSION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER_SESSION_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("derivePresenceUserId", () => {
  it("never contains the session id, in whole or in part", () => {
    const presenceUserId = derivePresenceUserId(SESSION_ID);
    expect(presenceUserId).not.toContain(SESSION_ID);
    // Nor any run of the id long enough to be usefully guessed back.
    for (const segment of SESSION_ID.split("-")) {
      expect(presenceUserId).not.toContain(segment);
    }
  });

  it("is stable across calls, so tabs and reloads are one roster user", () => {
    expect(derivePresenceUserId(SESSION_ID)).toBe(derivePresenceUserId(SESSION_ID));
  });

  it("distinguishes two users", () => {
    expect(derivePresenceUserId(SESSION_ID)).not.toBe(derivePresenceUserId(OTHER_SESSION_ID));
  });

  it("is a fixed-width opaque hex token", () => {
    expect(derivePresenceUserId(SESSION_ID)).toMatch(/^[0-9a-f]{16}$/);
    expect(derivePresenceUserId("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("cannot collide with the reserved synthetic roster namespaces", () => {
    // Hex never contains ':' — `persona:<slug>`, `ghost:<id>` and the agent id
    // stay unambiguous, which BlockPresenceIndicator and PresenceFacepile
    // depend on when they prefix-match to tell humans from agents.
    expect(derivePresenceUserId(SESSION_ID)).not.toContain(":");
  });
});

describe("deriveIdentity agrees between self and remote", () => {
  it("gives one user the same name and colour on every client", () => {
    // Self renders deriveIdentity(presenceUserId); a peer renders
    // deriveIdentity(entry.userId). Both are the derived id, so they match.
    const presenceUserId = derivePresenceUserId(SESSION_ID);
    expect(deriveIdentity(presenceUserId)).toEqual(deriveIdentity(presenceUserId));
    expect(deriveIdentity(presenceUserId).name).toMatch(/^\w+ \w+$/);
  });
});
