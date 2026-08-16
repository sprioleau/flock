/**
 * The Phase 7.4 fetch primitive — ONE mode-agnostic server-side page fetch
 * shared by every ingestion purpose (this brand/theme mode today; the
 * article-content mode later reuses `fetchPage` / `fetchTextResource`
 * unchanged and layers its own extraction on top).
 *
 * Behaviors:
 * - SSRF-guarded (url-guard.ts), including EVERY redirect hop (redirects are
 *   followed manually so a public URL can't bounce us into a private range).
 * - Bounded: ~10s deadline, 2MB body cap, 5 redirect hops max.
 * - Honest: failures come back as a machine `reason` plus a friendly,
 *   user-facing `message` — never fabricated content for an unreadable page
 *   (plan §7.4 faithfulness rules).
 *
 * TLS note: behind a certificate-intercepting proxy the server process needs
 * NODE_EXTRA_CA_CERTS set for outbound TLS to succeed.
 */

import { guardUrl } from "./url-guard";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 FlockBrandKit/1.0";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_CSS_BYTES = 400 * 1024; // per-stylesheet cap

/*
  Two distinct flavors of "the site said no", because they need OPPOSITE
  advice:

  - blocked_by_site — an ordinary per-page refusal (a members-only page, a
    restricted section). Another page on the same site really may be readable,
    so "try another page" is good advice here.
  - blocked_by_bot_challenge — the whole origin sits behind a bot check, so
    EVERY path answers the same way. Telling that user to try another page
    sends them in a circle with no way out; the honest move is to stop
    scraping and point them at manual entry.
*/
export type FetchFailureReason =
  | "invalid_url"
  | "blocked_host"
  | "dns"
  | "timeout"
  | "http_error"
  | "blocked_by_site"
  | "blocked_by_bot_challenge"
  | "not_html"
  | "too_many_redirects"
  | "network";

export interface FetchPageFailure {
  isOk: false;
  reason: FetchFailureReason;
  message: string;
}

export type FetchPageResult = { isOk: true; html: string; finalUrl: string } | FetchPageFailure;

function failure({
  reason,
  message,
}: {
  reason: FetchFailureReason;
  message: string;
}): FetchPageFailure {
  return { isOk: false, reason, message };
}

/** Read a response body up to `maxBytes`; truncates silently past the cap. */
async function readBytesCapped({
  response,
  maxBytes,
}: {
  response: Response;
  maxBytes: number;
}): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (totalBytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const merged = new Uint8Array(Math.min(totalBytes, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = merged.byteLength - offset;
    if (remaining <= 0) {
      break;
    }
    merged.set(remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining), offset);
    offset += Math.min(chunk.byteLength, remaining);
  }
  return merged;
}

/** Text flavor of {@link readBytesCapped} (lossy UTF-8 decode). */
async function readBodyCapped(input: { response: Response; maxBytes: number }): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false }).decode(await readBytesCapped(input));
}

interface GuardedFetchOk {
  isOk: true;
  response: Response;
  finalUrl: string;
}

type GuardedFetchResult = GuardedFetchOk | FetchPageFailure;

/**
 * Fetch with manual, per-hop-guarded redirect following. Shared by the HTML
 * page fetch and the stylesheet fetches.
 */
async function guardedFetch({
  url,
  deadlineAtMs,
  method = "GET",
}: {
  url: string;
  deadlineAtMs: number;
  method?: "GET" | "HEAD";
}): Promise<GuardedFetchResult> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const guardResult = await guardUrl(currentUrl);
    if (!guardResult.isAllowed) {
      const isDnsIssue = guardResult.reason.includes("look up");
      return failure({
        reason: isDnsIssue ? "dns" : "blocked_host",
        message: isDnsIssue
          ? "We couldn't find that site — please double-check the address."
          : "We can only read public websites — that address isn't one we can reach.",
      });
    }
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return failure({
        reason: "timeout",
        message: "That site took too long to respond. Please try again in a moment.",
      });
    }
    let response: Response;
    try {
      response = await fetch(guardResult.url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(remainingMs),
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/css,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      return failure({
        reason: isTimeout ? "timeout" : "network",
        message: isTimeout
          ? "That site took too long to respond. Please try again in a moment."
          : "We couldn't reach that site. Please check the address and try again.",
      });
    }
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return { isOk: true, response, finalUrl: guardResult.url.toString() };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (location === null) {
      return failure({
        reason: "http_error",
        message: "That site sent a redirect we couldn't follow.",
      });
    }
    currentUrl = new URL(location, guardResult.url).toString();
  }
  return failure({
    reason: "too_many_redirects",
    message: "That site redirected too many times for us to read it.",
  });
}

/*
  Is this response the bot-check itself, rather than the origin's own answer?

  The signal is `cf-mitigated`: Cloudflare sets it only on a response its
  security layer produced (the managed challenge / block interstitial).
  Measured against a challenged origin: `cf-mitigated: challenge` with
  `server: cloudflare`, on EVERY path — the homepage, /robots.txt,
  /favicon.ico, /manifest.json — with the app's user-agent, with a plain
  browser one, and with none at all. Origin-wide and UA-independent, which is
  exactly what separates it from a single restricted page.

  Deliberately narrow, and NOT generalized to other vendors:

  - `server: cloudflare` alone is not enough. A large share of the web is
    fronted by Cloudflare, so an ordinary app-level 403 (a private page, a
    paywalled article) from any of those sites would be mislabeled as an
    origin-wide block and handed advice that doesn't apply.
  - Other vendors do send comparable headers, but we have no measurements for
    them. Guessing at their names would produce a confidently wrong message
    for whatever happened to match — which is precisely the bug this
    distinction exists to fix. Anything unrecognized keeps `blocked_by_site`,
    whose advice is still safe.

  Header-only by design: the signal rides on the response we already hold, so
  the classification costs no second request against the ~10s deadline. We
  never probe another path to "confirm" it, and we never retry.
*/
function hasBotChallengeHeaders(response: Response): boolean {
  return (response.headers.get("cf-mitigated") ?? "").trim().length > 0;
}

/**
 * Fetch an HTML page — the reusable primitive. Returns the (capped) HTML and
 * the final URL after redirects, or an honest failure.
 */
export async function fetchPage(
  rawUrl: string,
  options?: { timeoutMs?: number },
): Promise<FetchPageResult> {
  const deadlineAtMs = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchResult = await guardedFetch({ url: rawUrl, deadlineAtMs });
  if (!fetchResult.isOk) {
    return fetchResult;
  }
  const { response, finalUrl } = fetchResult;
  /*
    Checked BEFORE the generic block statuses: a challenge arrives dressed as
    a 403, so this is the more specific reading of the very same response. It
    isn't limited to 401/403/451 either — once the edge says it mitigated the
    request, that IS the reason, whatever status it chose to wear.
  */
  if (!response.ok && hasBotChallengeHeaders(response)) {
    await response.body?.cancel().catch(() => undefined);
    return failure({
      reason: "blocked_by_bot_challenge",
      message:
        "This site blocks automated readers, so no page on it can be read — trying another page won't help. We won't guess at its branding: set your logo, colors, and links here by hand instead.",
    });
  }
  if (response.status === 401 || response.status === 403 || response.status === 451) {
    await response.body?.cancel().catch(() => undefined);
    return failure({
      reason: "blocked_by_site",
      message:
        "That site wouldn't let us read it (it blocks automated access). We won't guess at its branding — try another page on the same site.",
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return failure({
      reason: "http_error",
      message: `We couldn't read that site (it responded with an error). Please check the address and try again.`,
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
  if (!isHtml) {
    await response.body?.cancel().catch(() => undefined);
    return failure({
      reason: "not_html",
      message: "That address doesn't look like a web page — please link to a site's homepage.",
    });
  }
  const html = await readBodyCapped({ response, maxBytes: MAX_HTML_BYTES });
  if (html.trim().length === 0) {
    return failure({
      reason: "http_error",
      message: "That page came back empty, so there was nothing to read.",
    });
  }
  return { isOk: true, html, finalUrl };
}

export type FetchBinaryResult =
  | { isOk: true; bytes: Uint8Array; contentType: string }
  | FetchPageFailure;

/**
 * Fetch a binary resource through the same SSRF rails (per-hop guard,
 * deadline, byte cap) — the confirm-asset flow's image download. The body is
 * HARD-capped: a response larger than `maxBytes` is rejected, not truncated
 * (a truncated image is a corrupt image).
 */
export async function fetchBinaryResource({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes,
}: {
  url: string;
  timeoutMs?: number;
  maxBytes: number;
}): Promise<FetchBinaryResult> {
  const fetchResult = await guardedFetch({ url, deadlineAtMs: Date.now() + timeoutMs });
  if (!fetchResult.isOk) {
    return fetchResult;
  }
  const { response } = fetchResult;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return failure({
      reason: "http_error",
      message: "We couldn't download that file (the site responded with an error).",
    });
  }
  // Read one byte past the cap so an at-cap read distinguishes "exactly cap"
  // from "over cap" — over-cap downloads are rejected outright.
  const bytes = await readBytesCapped({ response, maxBytes: maxBytes + 1 });
  if (bytes.byteLength > maxBytes) {
    return failure({
      reason: "http_error",
      message: "That file is too large for us to save.",
    });
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return { isOk: true, bytes, contentType };
}

export type AssetProbeMethod = "GET" | "HEAD";

export type AssetProbeResult =
  | { isOk: true; status: number; contentType: string }
  | FetchPageFailure;

/**
 * Probe an asset URL through the same SSRF rails WITHOUT downloading the
 * body — status + normalized content-type only (the body stream is cancelled
 * unread). The method is caller-chosen: verify-image-url.ts tries HEAD first
 * and falls back to GET because some CDNs reject HEAD outright.
 *
 * Unlike the page/binary fetchers, a non-2xx status is NOT mapped to a
 * failure here — the status code itself is the answer the caller wants.
 */
export async function probeAssetUrl({
  url,
  method,
  timeoutMs,
}: {
  url: string;
  method: AssetProbeMethod;
  timeoutMs: number;
}): Promise<AssetProbeResult> {
  const fetchResult = await guardedFetch({ url, deadlineAtMs: Date.now() + timeoutMs, method });
  if (!fetchResult.isOk) {
    return fetchResult;
  }
  const { response } = fetchResult;
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  await response.body?.cancel().catch(() => undefined);
  return { isOk: true, status: response.status, contentType };
}

/**
 * Fetch a small same-guard text resource (stylesheets today). Returns the
 * capped body or null — auxiliary fetches fail soft; only the page fetch
 * fails loud.
 */
export async function fetchTextResource({
  url,
  timeoutMs = 5_000,
  maxBytes = MAX_CSS_BYTES,
}: {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<string | null> {
  const fetchResult = await guardedFetch({ url, deadlineAtMs: Date.now() + timeoutMs });
  if (!fetchResult.isOk) {
    return null;
  }
  const { response } = fetchResult;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return readBodyCapped({ response, maxBytes });
}
