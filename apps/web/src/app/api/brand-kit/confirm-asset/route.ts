import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  decodeSvgDataUri,
  MAX_ASSET_BYTES,
  normalizeImageContentType,
  prepareSvgBinary,
  type AssetBinary,
} from "@/lib/brand-kit-extraction/confirm-asset";
import { fetchBinaryResource } from "@/lib/brand-kit-extraction/fetch-page";

/**
 * POST /api/brand-kit/confirm-asset — Stage S of the brand-kit architecture
 * (docs/proposals/brand-kit-architecture.md §8): make an extracted asset
 * suggestion DURABLE. Owner decision 4: only assets confirmed through here
 * (Convex storage URLs) may ever enter documents.
 *
 * Contract (the brand-kit panel codes against exactly this):
 *   request:  { sessionId: string, kind: "logo" | "socialCard" }
 *   response: { isOk: true, url: string }        // the durable serving URL
 *           | { isOk: false, message: string }   // friendly, user-facing
 *
 * Flow: re-read the asset URL from the session's kit row (NEVER trust a
 * client-supplied URL — the row's URL already passed the extraction guards)
 * → data:image/svg+xml URIs decode locally, external URLs go through the
 * same SSRF rails as the page fetch (url-guard per redirect hop, deadline,
 * hard 2MB cap) with an image content-type allowlist → upload to Convex
 * storage (the generate-image server-upload pattern) → `confirmAsset`
 * patches the kit row (durable URL + provenance + revision bump; the
 * previous confirmed file for the kind is deleted) → `assets.register`
 * (Content Studio Stage S: the confirmed binary joins the session's asset
 * library as kind "logo"/"social-card" — "any logos that were scraped").
 *
 * Stage M seam (content-studio §7.1) — CONVERTED: kit-side deletes
 * (replace/clear/remove) now go through deleteStorageFilesUnlessRegistered
 * (convex/brandKits.ts), so a replaced file that this route registered into
 * the library is RETAINED and its lifecycle belongs to the registry.
 */

const requestBodySchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(["logo", "socialCard"]),
});

const ASSET_NOUNS: Record<"logo" | "socialCard", string> = {
  logo: "logo",
  socialCard: "social card image",
};

function failureResponse({ message, status }: { message: string; status: number }): Response {
  return Response.json({ isOk: false, message }, { status });
}

type ObtainBinaryOutcome =
  | { isOk: true; binary: AssetBinary }
  | { isOk: false; message: string; status: number };

/** Turn the row's asset URL (data URI or external URL) into upload bytes. */
async function obtainAssetBinary(assetUrl: string): Promise<ObtainBinaryOutcome> {
  if (assetUrl.startsWith("data:")) {
    const decoded = decodeSvgDataUri(assetUrl);
    if (decoded === null) {
      return {
        isOk: false,
        status: 422,
        message: "That suggestion isn't an image we can save.",
      };
    }
    const prepared = prepareSvgBinary(decoded.svgText);
    return prepared.isOk
      ? { isOk: true, binary: prepared.binary }
      : { isOk: false, status: 422, message: prepared.message };
  }
  const fetched = await fetchBinaryResource({ url: assetUrl, maxBytes: MAX_ASSET_BYTES });
  if (!fetched.isOk) {
    return { isOk: false, status: 422, message: fetched.message };
  }
  const contentType = normalizeImageContentType(fetched.contentType);
  if (contentType === null) {
    return {
      isOk: false,
      status: 422,
      message: "That address didn't give us an image we can save.",
    };
  }
  if (contentType === "image/svg+xml") {
    // SVGs are text — run the same safety gate as inline ones.
    const prepared = prepareSvgBinary(new TextDecoder("utf-8").decode(fetched.bytes));
    return prepared.isOk
      ? { isOk: true, binary: prepared.binary }
      : { isOk: false, status: 422, message: prepared.message };
  }
  return { isOk: true, binary: { bytes: fetched.bytes, contentType } };
}

export async function POST(request: Request) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined || convexUrl === "") {
    return failureResponse({
      status: 503,
      message: "Saving brand assets isn't configured on this server yet.",
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
    return failureResponse({
      status: 400,
      message: "Please tell us which brand asset to save.",
    });
  }
  const { sessionId, kind } = parsedBody.data;
  const assetNoun = ASSET_NOUNS[kind];

  try {
    const convexClient = new ConvexHttpClient(convexUrl);

    // 1. Re-read the suggestion from the row — the source of truth.
    const brandKit = await convexClient.query(api.brandKits.getActiveBrandKit, { sessionId });
    if (brandKit === null) {
      return failureResponse({
        status: 404,
        message: "No saved brand kit found — save a kit first.",
      });
    }
    const assetUrl = kind === "logo" ? brandKit.logoUrl : brandKit.socialImageUrl;
    if (assetUrl === undefined) {
      return failureResponse({
        status: 422,
        message: `This kit has no ${assetNoun} suggestion to save.`,
      });
    }
    const isAlreadyConfirmed =
      kind === "logo"
        ? brandKit.logoConfirmedAtMs !== undefined
        : brandKit.socialImageConfirmedAtMs !== undefined;
    if (isAlreadyConfirmed) {
      // Idempotent: the row already holds the durable URL.
      return Response.json({ isOk: true, url: assetUrl });
    }

    // 2. Bytes: decode inline SVG locally, or fetch through the SSRF rails.
    const obtained = await obtainAssetBinary(assetUrl);
    if (!obtained.isOk) {
      return failureResponse({ status: obtained.status, message: obtained.message });
    }
    const { bytes, contentType } = obtained.binary;

    // 3. Upload — the shipped server-side pattern (generate-image route).
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

    // 4. Patch the row (durable URL, provenance, revision bump).
    const { url } = await convexClient.mutation(api.brandKits.confirmAsset, {
      sessionId,
      kind,
      storageId,
      expectedSourceUrl: assetUrl,
    });

    // 5. Register the confirmed binary in the session's asset library
    // (AFTER confirmAsset: a concurrent-re-scrape rejection deletes the
    // upload, and a just-deleted file must never gain a registry row).
    // Failure here never fails the confirm — the kit row already holds the
    // durable URL; the file is then merely an unregistered legacy upload.
    try {
      await convexClient.mutation(api.assets.register, {
        sessionId,
        storageId,
        kind: kind === "logo" ? "logo" : "social-card",
        name: brandKit.name,
        // Scrape origin — inline data: URIs aren't an origin worth recording.
        ...(assetUrl.startsWith("data:") ? {} : { sourceUrl: assetUrl }),
      });
    } catch (registerError) {
      console.error("[brand-kit] confirm-asset library registration failed:", registerError);
    }
    return Response.json({ isOk: true, url });
  } catch (error) {
    if (error instanceof ConvexError) {
      return failureResponse({ status: 409, message: String(error.data) });
    }
    console.error("[brand-kit] confirm-asset failed:", error);
    return failureResponse({
      status: 502,
      message: `We couldn't save the ${assetNoun} right now. Please try again.`,
    });
  }
}
