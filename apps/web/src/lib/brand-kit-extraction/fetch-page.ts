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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TandemBrandKit/1.0";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_CSS_BYTES = 400 * 1024; // per-stylesheet cap

export type FetchFailureReason =
  | "invalid_url"
  | "blocked_host"
  | "dns"
  | "timeout"
  | "http_error"
  | "blocked_by_site"
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
async function readBodyCapped({
  response,
  maxBytes,
}: {
  response: Response;
  maxBytes: number;
}): Promise<string> {
  if (response.body === null) {
    return "";
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
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
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
}: {
  url: string;
  deadlineAtMs: number;
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
