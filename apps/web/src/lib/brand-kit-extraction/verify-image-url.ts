/*
  Server-side render-check for suggested asset URLs (logo + social card).

  Owner directive (Gatorade bug, 2026-08-01): the scrape backend must verify
  every suggested asset URL by hitting it directly and requiring a success
  response BEFORE the frontend ever tries to render it — a social card that
  404s on a third-party CDN (www.datocms-assets.com) must become an absent
  field, never a broken-image tile. The rest of the kit still ships
  ("return what we can").

  Verification rules:
  - `data:image/…` URIs (serialized masthead SVGs) pass without a network hop.
  - Try HEAD first (cheap); a HEAD that answers 2xx + `image/*` passes.
  - Anything else — non-2xx, network error, missing/non-image content-type,
    or a CDN that rejects HEAD outright — gets ONE authoritative GET whose
    body is never downloaded (headers only, stream cancelled).
  - The GET must be 2xx with an `image/*` content-type; everything else fails.
  - Each probe runs through the SSRF-guarded fetch rails with a few-second
    timeout, so a slow asset host can't stall generation.
*/

import {
  probeAssetUrl,
  type AssetProbeMethod,
  type AssetProbeResult,
} from "./fetch-page";

/*
  Per-probe budget — asset verification must stay a small tax on generation.
*/
export const IMAGE_PROBE_TIMEOUT_MS = 4_000;

/*
  Injectable probe so unit tests never touch the network.
*/
export type ImageProbe = (args: {
  url: string;
  method: AssetProbeMethod;
}) => Promise<AssetProbeResult>;

const defaultImageProbe: ImageProbe = ({ url, method }) =>
  probeAssetUrl({ url, method, timeoutMs: IMAGE_PROBE_TIMEOUT_MS });

function isRenderableImageResult(result: AssetProbeResult): boolean {
  return (
    result.isOk &&
    result.status >= 200 &&
    result.status < 300 &&
    result.contentType.startsWith("image/")
  );
}

/*
  Does this URL actually serve a renderable image right now?
*/
export async function isImageUrlRenderable({
  url,
  probe = defaultImageProbe,
}: {
  url: string;
  probe?: ImageProbe;
}): Promise<boolean> {
  if (url.startsWith("data:image/")) {
    return true; /* inline data URIs render locally — nothing to hit */
  }
  try {
    if (isRenderableImageResult(await probe({ url, method: "HEAD" }))) {
      return true;
    }
  } catch {
    /*
      Treat a throwing probe like a failed HEAD — GET below decides.
    */
  }
  /*
    HEAD said no. That's ambiguous (some CDNs 405 HEAD, others omit its
    content-type), so one GET is the authority.
  */
  try {
    return isRenderableImageResult(await probe({ url, method: "GET" }));
  } catch {
    return false;
  }
}

/*
  First candidate URL that verifiably renders, or null when none does —
  the pipeline's "suggest it or drop the field" primitive. Candidates are
  checked in priority order (nullish entries skipped) so a dead primary
  suggestion can still fall back to the next-best harvested one.
*/
export async function pickFirstRenderableImageUrl({
  candidateUrls,
  probe = defaultImageProbe,
}: {
  candidateUrls: (string | null | undefined)[];
  probe?: ImageProbe;
}): Promise<string | null> {
  for (const url of candidateUrls) {
    if (url === null || url === undefined || url.length === 0) {
      continue;
    }
    if (await isImageUrlRenderable({ url, probe })) {
      return url;
    }
  }
  return null;
}
