import { createHmac } from "node:crypto";

/**
 * The anonymous allowance's second scope: "roughly, which network is this?"
 *
 * WHY IT EXISTS. A per-identity credit cap is not a limit against anyone
 * willing to clear storage — a fresh anonymous user is one click away, with a
 * fresh empty allowance. The cap needs a second scope the visitor cannot
 * cheaply rotate, and the client address is the only such signal a web app
 * gets for free.
 *
 * WHAT IS SENT TO CONVEX. Never the address. This derives a keyed hash of a
 * COARSENED address, truncated to 32 hex characters, and Convex stores only
 * that (convex/schema.ts `authCredits`). The result:
 *   - the credits table cannot be read as a log of who visited from where;
 *   - the key is unguessable without the server secret, so nobody can probe
 *     or pre-burn another network's bucket;
 *   - rotating the secret silently resets every origin bucket, which is a
 *     usable escape hatch if one ever gets wedged.
 *
 * COARSENING. IPv4 is used whole. IPv6 is truncated to its /64 prefix: a
 * single subscriber is routinely handed a whole /64 and can freely pick new
 * addresses inside it, so hashing the full address would make the bucket as
 * rotatable as localStorage and buy nothing.
 *
 * HONEST LIMITS. This is a speed bump against casual abuse (storage clearing,
 * incognito, several browsers on one machine), not a defence against a VPN, a
 * proxy pool, or a phone hopping carrier NAT. It also pools genuinely
 * different people behind one office or campus NAT — which is why claimed
 * accounts are exempt from this bucket entirely (convex/authCredits.ts).
 */

/** Cheap, non-secret fallback so a missing secret degrades rather than throws. */
const FALLBACK_SALT = "flock-origin-key";

function readSalt(): string {
  // Reuses the auth secret rather than adding another variable to configure.
  // It is already required, already high-entropy, and already server-only.
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret !== undefined && secret.length > 0 ? secret : FALLBACK_SALT;
}

/**
 * Extract the client address from proxy headers. Vercel sets both; the first
 * `x-forwarded-for` entry is the client, the rest are proxies.
 */
function readClientAddress(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null && forwardedFor.length > 0) {
    const first = forwardedFor.split(",")[0]?.trim() ?? "";
    if (first.length > 0) {
      return first;
    }
  }
  const realIp = request.headers.get("x-real-ip");
  return realIp !== null && realIp.length > 0 ? realIp.trim() : null;
}

/**
 * Coarsen an address to the unit a single subscriber controls: a whole IPv4
 * address, or an IPv6 /64 prefix.
 */
export function coarsenAddress(address: string): string {
  const withoutPort = address.startsWith("[")
    ? (address.slice(1).split("]")[0] ?? address)
    : address;
  if (!withoutPort.includes(":")) {
    return withoutPort;
  }
  // IPv6: keep the first four groups (/64). Expansion of "::" is unnecessary —
  // a compressed address has fewer than four leading groups only when the
  // elided run is on the left, in which case the prefix is genuinely shorter.
  const groups = withoutPort.split(":");
  return groups.slice(0, 4).join(":");
}

/**
 * The opaque per-origin bucket key, or undefined when the address is not
 * visible (local dev, direct calls, tests). An absent key means the origin
 * bucket is simply not charged — the per-identity cap still applies.
 */
export function deriveOriginKey(request: Request): string | undefined {
  const address = readClientAddress(request);
  if (address === null) {
    return undefined;
  }
  return createHmac("sha256", readSalt())
    .update(coarsenAddress(address))
    .digest("hex")
    .slice(0, 32);
}
