import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { fetchAuthMutation, fetchAuthQuery } from "@/lib/auth/auth-server";
import {
  MAX_ASSET_BYTES,
  normalizeImageContentType,
  prepareSvgBinary,
  type AssetBinary,
} from "../brand-kit-extraction/confirm-asset";
import { fetchBinaryResource } from "../brand-kit-extraction/fetch-page";

/*
  Rehost ONE external image into Convex storage — the ingestion pipeline's
  hero/photo path (plan §7.4, scope note).

  Why rehost instead of hot-linking: a publisher's CDN can pass our
  server-side verification and still refuse the browser (CORP headers, bot
  challenges, hotlink protection). An email composed from a fetched article
  must not carry an image that silently breaks in the canvas, the HTML
  preview, and the recipient's inbox. Serving from our own storage removes
  that whole failure class — the same conclusion the brand-kit confirm-asset
  flow and the Asset Library URL import already reached.

  Reuse, not a fourth copy of the rails: bytes come through
  `fetchBinaryResource` (per-hop SSRF guard, deadline, hard byte cap) and the
  content-type allowlist / SVG hardening come from `confirm-asset.ts`. The
  only new thing here is the upload + registration wiring, which is exactly
  the shipped generate-image pattern.

  FAIL-SOFT BY DESIGN: a hero image is a nicety, an article's text is not.
  Every failure returns null and the caller composes the section without an
  image. It never invents one, and it never falls back to the external URL.
*/

/*
  Max hero-image size we will pull down and store.
*/
const MAX_HERO_IMAGE_BYTES = MAX_ASSET_BYTES;

export interface RehostImageInput {
  /*
    Absolute http(s) URL of the image, as extracted from the page.
  */
  imageUrl: string;
  /*
    The browsing session that should own the stored asset. When null the file
    is still stored and served, it just doesn't join anyone's Asset Library.
  */
  sessionId: string | null;
  /*
    Library display name (the article title, typically).
  */
  name: string;
  /*
    The page the image came from — recorded as provenance.
  */
  sourceUrl: string;
}

/*
  Fetch + validate the image bytes, or null when it isn't storable.
*/
async function obtainImageBinary(imageUrl: string): Promise<AssetBinary | null> {
  const fetched = await fetchBinaryResource({ url: imageUrl, maxBytes: MAX_HERO_IMAGE_BYTES });
  if (!fetched.isOk) {
    return null;
  }
  const contentType = normalizeImageContentType(fetched.contentType);
  if (contentType === null) {
    return null;
  }
  if (contentType === "image/svg+xml") {
    const prepared = prepareSvgBinary(new TextDecoder("utf-8").decode(fetched.bytes));
    return prepared.isOk ? prepared.binary : null;
  }
  return { bytes: fetched.bytes, contentType };
}

/*
  Copy an external image into Convex storage and return the durable serving
  URL, or null when it could not be fetched, wasn't a storable image, or
  storage is unavailable. Never throws.
*/
export async function rehostImageToStorage({
  imageUrl,
  sessionId,
  name,
  sourceUrl,
}: RehostImageInput): Promise<string | null> {
  try {
    const binary = await obtainImageBinary(imageUrl);
    if (binary === null) {
      return null;
    }
    const postUrl = await fetchAuthMutation(api.files.generateUploadUrl, {});
    const uploadResponse = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": binary.contentType },
      body: new Blob([binary.bytes.buffer as ArrayBuffer], { type: binary.contentType }),
    });
    if (!uploadResponse.ok) {
      return null;
    }
    const { storageId } = (await uploadResponse.json()) as { storageId: Id<"_storage"> };

    /*
      With a session: register into that session's Asset Library (the one
      seam every upload path funnels through — it also resolves the URL).
      Without one: resolve the serving URL directly.
    */
    if (sessionId !== null && sessionId.length > 0) {
      /*
        Authenticated: `assets` is keyed by resolveOwnerId, so a bare client
        would file the rehosted image under the legacy session id while the
        browser reads its library under the verified identity.
      */
      const { url } = await fetchAuthMutation(api.assets.register, {
        sessionId,
        storageId,
        kind: "uploaded",
        name,
        sourceUrl,
      });
      return url;
    }
    return await fetchAuthQuery(api.files.getFileUrl, { storageId });
  } catch (error) {
    console.error("[content-ingestion] hero image rehost failed:", error);
    return null;
  }
}
