/*
  Syntax guard for a HUMAN-TYPED brand asset URL
  (brand-kit-user-control §6.2).

  Why this exists next to the real guard rather than reusing it: the shipped
  SSRF guard (lib/brand-kit-extraction/url-guard.ts) imports `node:dns` and
  `node:net`, so it cannot run inside a Convex mutation. Splitting the check
  along the same line the proposal already drew — "syntax-guard at set time,
  full guard at confirm time" — is what makes that fine. Typing a URL only
  parks a SUGGESTION on the kit row; nothing is fetched. The confirm-asset
  route still runs the complete guard (DNS resolution per redirect hop, 2 MB
  cap, image/* allowlist, script rejection in SVG) before a single byte is
  pulled, and it re-reads the URL from the row rather than trusting a client.

  So this module's job is narrow and honest: reject what is obviously not a
  fetchable public image URL, immediately, so a typo surfaces while the user is
  still looking at the field instead of at the confirm step.

  Pure and dependency-free on purpose — it must import cleanly from convex/.
*/

/*
  Matches the shipped guard's cap so a URL accepted here cannot be rejected for
  length later.
*/
export const MAX_BRAND_ASSET_URL_LENGTH = 2048;

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export type BrandAssetUrlResult =
  | { isValid: true; url: string }
  | { isValid: false; message: string };

/*
  True for a dotted-quad IPv4 literal in a private, loopback, link-local,
  CGNAT, multicast or reserved range. Hand-rolled rather than imported from
  url-guard because `node:net`'s isIP is unavailable here; the ranges are kept
  byte-compatible with `isPrivateIpv4` there, and an unparseable quad is
  treated as unsafe in both.
*/
function isPrivateIpv4Literal(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  const numbers = octets.map(Number);
  if (numbers.some((octet) => octet > 255)) {
    return true;
  }
  const [a, b] = numbers as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/*
  Validate a typed asset URL and return it normalized (trimmed, with the
  parsed serialization so "HTTPS://Acme.com/Logo.svg " stores consistently).

  Messages are user-facing: this value is typed by a person into a field, and
  the panel renders whatever comes back verbatim.
*/
export function validateBrandAssetUrl(rawUrl: string): BrandAssetUrlResult {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { isValid: false, message: "Paste an image address first." };
  }
  if (trimmed.length > MAX_BRAND_ASSET_URL_LENGTH) {
    return { isValid: false, message: "That address is too long." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      isValid: false,
      message: "That doesn't look like a web address — it should start with https://.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    /*
      Deliberately explicit about data: URIs. The scrape CAN store an inline
      `data:image/svg+xml` logo, so a user who copies one out of the panel and
      pastes it back would otherwise get a baffling generic error. We still
      refuse it: the confirm route decodes data URIs it produced itself, and
      accepting arbitrary user-supplied ones would hand it unvetted bytes.
    */
    return {
      isValid: false,
      message: "Only http and https image addresses can be imported — paste a link to the image.",
    };
  }
  const hostname = url.hostname.toLowerCase();
  if (isPrivateIpv4Literal(hostname)) {
    return { isValid: false, message: "That address points at a private network." };
  }
  const isInternalName =
    hostname === "localhost" ||
    !hostname.includes(".") ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (isInternalName) {
    return { isValid: false, message: "That address isn't reachable from the internet." };
  }
  return { isValid: true, url: url.toString() };
}
