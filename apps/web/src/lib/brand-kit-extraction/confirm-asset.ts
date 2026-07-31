/**
 * Pure helpers for the confirm-asset flow (brand-kit architecture §8):
 * image content-type allowlisting, SVG safety checks, and inline-SVG
 * data-URI decoding. The route (app/api/brand-kit/confirm-asset) composes
 * these with the SSRF-guarded binary fetch (fetch-page.ts) and the
 * server-side Convex storage upload.
 *
 * SVG stance (§8.1 note): confirmed SVGs are only ever rendered via <img>
 * (scripts don't execute there), but we still reject scripty SVGs at
 * confirm time as cheap defense-in-depth.
 */

/** Image types we'll store (proposal allowlist + favicon flavors — the icon
 * ladder can legitimately surface .ico assets). */
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Confirmable binaries are capped well under page size — logos are small. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Normalize a Content-Type header value to an allowlisted image type, or
 * null when it isn't one ("IMAGE/PNG; charset=binary" → "image/png").
 */
export function normalizeImageContentType(rawContentType: string): string | null {
  const contentType = rawContentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_IMAGE_CONTENT_TYPES.has(contentType) ? contentType : null;
}

/**
 * Cheap SVG hardening: reject markup carrying scripts, event handlers, or
 * javascript: URLs. Benign presentational attributes (stroke-linejoin, …)
 * pass — the event-handler pattern requires a word STARTING with "on".
 */
export function isSvgMarkupSafe(svgText: string): boolean {
  const lower = svgText.toLowerCase();
  if (lower.includes("<script")) {
    return false;
  }
  if (/\bon[a-z]+\s*=/.test(lower)) {
    return false; // onload= / onclick= / …
  }
  if (lower.includes("javascript:")) {
    return false;
  }
  return true;
}

export type DecodedSvgDataUri = { svgText: string } | null;

/**
 * Decode a `data:image/svg+xml…` URI (base64 or percent-encoded) back to
 * markup. Returns null for anything that isn't an SVG data URI or doesn't
 * decode cleanly.
 */
export function decodeSvgDataUri(uri: string): DecodedSvgDataUri {
  const match = uri.match(/^data:image\/svg\+xml((?:;[a-z0-9=-]+)*),([\s\S]*)$/i);
  if (match === null) {
    return null;
  }
  const [, parameters, payload] = match;
  try {
    const svgText = parameters.toLowerCase().includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf-8")
      : decodeURIComponent(payload);
    return svgText.trim().length === 0 ? null : { svgText };
  } catch {
    return null;
  }
}

export type AssetBinary = { bytes: Uint8Array; contentType: string };

export type PrepareSvgOutcome =
  | { isOk: true; binary: AssetBinary }
  | { isOk: false; message: string };

/** Validate + package SVG markup for upload (shared by data-URI and fetched paths). */
export function prepareSvgBinary(svgText: string): PrepareSvgOutcome {
  if (!isSvgMarkupSafe(svgText)) {
    return {
      isOk: false,
      message: "That image contains active content we can't safely save.",
    };
  }
  const bytes = new TextEncoder().encode(svgText);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return { isOk: false, message: "That file is too large for us to save." };
  }
  return { isOk: true, binary: { bytes, contentType: "image/svg+xml" } };
}
