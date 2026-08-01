import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/**
 * POST /api/library/import-image — the Asset Library's "From URL" import:
 * REHOST an external image into Convex blob storage so the library row (and
 * anything inserted from it) serves from OUR storage URL, never the external
 * one. Same server-side rails as the brand-kit confirm-asset route: the
 * external fetch must happen here (client fetch = CORS), then the shipped
 * upload-URL flow (files.generateUploadUrl → POST bytes → assets.register).
 *
 * Contract (LibraryPanel codes against exactly this):
 *   request:  { sessionId: string, url: string }
 *   response: { isOk: true, url: string }        // the durable Convex URL
 *           | { isOk: false, message: string }   // friendly, user-facing
 *
 * Guards (minimal duplicate of lib/brand-kit-extraction's fetch rails —
 * those files are mid-flight for another workstream; consolidation noted):
 * http(s) only, private/loopback hosts refused, 10s deadline, image/*
 * content-type allowlist (SVG excluded — importing it would need the
 * brand-kit SVG sanitizer), 10 MB streaming cap.
 */

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const requestBodySchema = z.object({
  sessionId: z.string().min(1),
  url: z.string().min(1),
});

function failureResponse({ message, status }: { message: string; status: number }): Response {
  return Response.json({ isOk: false, message }, { status });
}

/** http(s) URLs only — anything else (data:, file:, ftp:) is refused. */
function parseImportUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
}

/** Refuse obvious loopback/private/link-local targets (basic SSRF hygiene). */
function isBlockedHostname(hostname: string): boolean {
  const lowerHostname = hostname.toLowerCase();
  if (
    lowerHostname === "localhost" ||
    lowerHostname === "0.0.0.0" ||
    lowerHostname.endsWith(".local") ||
    lowerHostname.endsWith(".internal") ||
    // IPv6 literals ([::1] etc.) — no legitimate image CDN needs one.
    lowerHostname.startsWith("[")
  ) {
    return true;
  }
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lowerHostname);
  if (ipv4Match === null) {
    return false;
  }
  const firstOctet = Number(ipv4Match[1]);
  const secondOctet = Number(ipv4Match[2]);
  return (
    firstOctet === 0 ||
    firstOctet === 10 ||
    firstOctet === 127 ||
    (firstOctet === 169 && secondOctet === 254) ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168)
  );
}

/** "image/png; charset=…" → "image/png"; null when not an importable image. */
function normalizeImageContentType(contentTypeHeader: string | null): string | null {
  const normalized = contentTypeHeader?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized.startsWith("image/") || normalized === "image/svg+xml") {
    return null;
  }
  return normalized;
}

/** Read the body up to the cap; null = over the cap (canceled mid-stream). */
async function readBodyWithCap(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_IMPORT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Display name from the URL's last path segment, when it has one. */
function deriveAssetName(importUrl: URL): string | null {
  const lastSegment = importUrl.pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(lastSegment).trim();
  } catch {
    decoded = lastSegment.trim();
  }
  return decoded.length === 0 ? null : decoded;
}

export async function POST(request: Request) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined || convexUrl === "") {
    return failureResponse({
      status: 503,
      message: "Importing images isn't configured on this server yet.",
    });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return failureResponse({ status: 400, message: "That request wasn't valid JSON." });
  }
  const parsedBody = requestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return failureResponse({ status: 400, message: "Please provide an image URL to import." });
  }
  const { sessionId } = parsedBody.data;

  const importUrl = parseImportUrl(parsedBody.data.url.trim());
  if (importUrl === null) {
    return failureResponse({
      status: 422,
      message: "That doesn't look like a web address — paste a full https:// image URL.",
    });
  }
  if (isBlockedHostname(importUrl.hostname)) {
    return failureResponse({
      status: 422,
      message: "That address points at a private network — we can only import public images.",
    });
  }

  // 1. Fetch the external image (deadline covers headers AND body read).
  let imageResponse: Response;
  try {
    imageResponse = await fetch(importUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return failureResponse({
      status: 422,
      message: "We couldn't reach that address — check the URL and try again.",
    });
  }
  if (!imageResponse.ok) {
    return failureResponse({
      status: 422,
      message: `That address answered with an error (${imageResponse.status}) — check the URL.`,
    });
  }
  const contentType = normalizeImageContentType(imageResponse.headers.get("content-type"));
  if (contentType === null) {
    return failureResponse({
      status: 422,
      message: "That address didn't give us an image — try a direct link to a PNG, JPG, GIF, or WebP.",
    });
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyWithCap(imageResponse);
  } catch {
    return failureResponse({
      status: 422,
      message: "The download was interrupted — check the URL and try again.",
    });
  }
  if (bytes === null) {
    return failureResponse({
      status: 422,
      message: "That image is larger than 10 MB — try a smaller one.",
    });
  }
  if (bytes.byteLength === 0) {
    return failureResponse({
      status: 422,
      message: "That address gave us an empty file — check the URL.",
    });
  }

  try {
    const convexClient = new ConvexHttpClient(convexUrl);

    // 2. Upload — the shipped server-side pattern (generate-image route).
    const postUrl = await convexClient.mutation(api.files.generateUploadUrl, {});
    const uploadResponse = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Blob([bytes.buffer as ArrayBuffer], { type: contentType }),
    });
    if (!uploadResponse.ok) {
      throw new Error(`Storage upload failed with status ${uploadResponse.status}`);
    }
    const { storageId } = (await uploadResponse.json()) as { storageId: Id<"_storage"> };

    // 3. Register into the session's library (Content Studio Stage S seam) —
    // the row's `url` is the durable Convex serving URL; the external origin
    // is provenance only (sourceUrl), never served from.
    const assetName = deriveAssetName(importUrl);
    const { url } = await convexClient.mutation(api.assets.register, {
      sessionId,
      storageId,
      kind: "uploaded",
      ...(assetName === null ? {} : { name: assetName }),
      sourceUrl: importUrl.toString(),
    });
    return Response.json({ isOk: true, url });
  } catch (error) {
    if (error instanceof ConvexError) {
      return failureResponse({ status: 409, message: String(error.data) });
    }
    console.error("[library] import-image failed:", error);
    return failureResponse({
      status: 502,
      message: "We couldn't import that image right now. Please try again.",
    });
  }
}
