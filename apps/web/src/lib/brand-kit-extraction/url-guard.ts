/**
 * SSRF guard for user-provided URLs — the safety layer under the Phase 7.4
 * fetch primitive. Two checks:
 *
 * 1. {@link validateUrlSyntax} — synchronous shape checks (protocol,
 *    obviously-internal hostnames, IP-literal ranges, length cap).
 * 2. {@link assertHostResolvesPublic} — DNS resolution with every resolved
 *    address checked against private/loopback/link-local/metadata ranges.
 *
 * The actual fetch re-resolves DNS (small TOCTOU window) — acceptable for a
 * demo-scale, user-driven feature; noted here so it isn't mistaken for a
 * hardened proxy.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_URL_LENGTH = 2048;

/**
 * Normalize a user-typed website address BEFORE validation: scheme-less
 * input ("cnn.com") gets **https:// only** — NEVER an http:// fallback
 * (owner decision), and protocol-relative "//host" resolves to https too.
 * Anything already carrying a scheme is left untouched so the guard can
 * judge it as typed. Purely syntactic — the full SSRF guard still runs on
 * the normalized URL.
 */
export function normalizeWebsiteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.startsWith("//") ? `https:${trimmed}` : `https://${trimmed}`;
}

export type UrlGuardResult =
  | { isAllowed: true; url: URL }
  | { isAllowed: false; reason: string };

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return true; // unparseable — treat as unsafe
  }
  const [a, b] = octets;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 doc range
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
}

function isPrivateIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — defer to the IPv4 ranges.
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch !== null) {
    return isPrivateIpv4(mappedMatch[1]);
  }
  return (
    ip === "::" ||
    ip === "::1" || // loopback
    ip.startsWith("fc") || // fc00::/7 unique-local
    ip.startsWith("fd") ||
    ip.startsWith("fe8") || // fe80::/10 link-local
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  );
}

/** True when an IP address (v4 or v6) is loopback/private/link-local/etc. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  return true; // not an IP at all — callers pass resolved addresses only
}

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * Synchronous URL validation: parseable, http(s) only, length-capped, and no
 * obviously-internal hostname or private IP literal.
 */
export function validateUrlSyntax(rawUrl: string): UrlGuardResult {
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { isAllowed: false, reason: "URL is too long." };
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { isAllowed: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { isAllowed: false, reason: "Only http and https URLs are supported." };
  }
  const hostname = url.hostname.toLowerCase();
  // Strip IPv6 brackets for the IP-literal check.
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bareHost) !== 0 && isBlockedAddress(bareHost)) {
    return { isAllowed: false, reason: "That address points at a private network." };
  }
  const isInternalName =
    hostname === "localhost" ||
    !hostname.includes(".") ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (isIP(bareHost) === 0 && isInternalName) {
    return { isAllowed: false, reason: "That hostname is not publicly reachable." };
  }
  return { isAllowed: true, url };
}

/**
 * Resolve the hostname and verify every returned address is public. IP
 * literals are checked directly (no lookup).
 */
export async function assertHostResolvesPublic(url: URL): Promise<UrlGuardResult> {
  const bareHost = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bareHost) !== 0) {
    return isBlockedAddress(bareHost)
      ? { isAllowed: false, reason: "That address points at a private network." }
      : { isAllowed: true, url };
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(bareHost, { all: true, verbatim: true });
  } catch {
    return { isAllowed: false, reason: "We couldn't look up that domain." };
  }
  if (addresses.length === 0) {
    return { isAllowed: false, reason: "We couldn't look up that domain." };
  }
  const hasBlockedAddress = addresses.some(({ address }) => isBlockedAddress(address));
  return hasBlockedAddress
    ? { isAllowed: false, reason: "That domain resolves to a private network." }
    : { isAllowed: true, url };
}

/** Full guard: syntax + DNS. The one call sites should use. */
export async function guardUrl(rawUrl: string): Promise<UrlGuardResult> {
  const syntaxResult = validateUrlSyntax(rawUrl);
  if (!syntaxResult.isAllowed) {
    return syntaxResult;
  }
  return assertHostResolvesPublic(syntaxResult.url);
}
