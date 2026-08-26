import { afterEach, describe, expect, it } from "vitest";
import { deriveRecipientKey, normalizeRecipient } from "./send-meter";

/*
  THE HALF OF THE SEND METER THAT CANNOT LIVE IN CONVEX.

  A Convex function cannot see the client address, and must never be handed a
  recipient address in the clear — `authTestSends` would otherwise become a
  readable list of everyone Flock has ever mailed. So the route derives both
  bucket keys here, and what these tests pin is the three properties the meter
  depends on being true of that derivation:

    - two spellings of one inbox are ONE bucket, or the cap is defeated by
      pressing shift;
    - the key gives the address away to nobody who reads the table;
    - the key is a function of the deployment secret, which is what makes it
      unguessable by an outsider and resettable by an operator.
*/

const previousSecret = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (previousSecret === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = previousSecret;
  }
});

describe("one inbox is one bucket", () => {
  it("treats casing and stray spaces as the same address", () => {
    expect(normalizeRecipient("  Sam@Example.COM ")).toBe("sam@example.com");
    expect(deriveRecipientKey("  Sam@Example.COM ")).toBe(deriveRecipientKey("sam@example.com"));
  });

  it("keeps genuinely different addresses in different buckets", () => {
    expect(deriveRecipientKey("sam@example.com")).not.toBe(deriveRecipientKey("sam@example.org"));
    /*
      Plus-addressing is deliberately NOT collapsed: some providers route
      `sam+a@` and `sam+b@` to one inbox and others do not, and merging them
      would silently throttle addresses that are not the same person.
    */
    expect(deriveRecipientKey("sam+one@example.com")).not.toBe(
      deriveRecipientKey("sam+two@example.com"),
    );
  });
});

describe("the stored key gives the address away to nobody", () => {
  it("is an opaque fixed-length digest, not the email in any form", () => {
    const key = deriveRecipientKey("someone.private@example.com");

    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("someone");
    expect(key).not.toContain("example.com");
  });

  /*
    The documented escape hatch: rotating BETTER_AUTH_SECRET resets every hashed
    bucket. It is also what makes the key unguessable — an outsider who knows a
    victim's address still cannot compute the bucket that would let them burn it.
  */
  it("changes completely when the deployment secret is rotated", () => {
    process.env.BETTER_AUTH_SECRET = "secret-one";
    const before = deriveRecipientKey("sam@example.com");

    process.env.BETTER_AUTH_SECRET = "secret-two";
    const after = deriveRecipientKey("sam@example.com");

    expect(after).not.toBe(before);
  });
});
