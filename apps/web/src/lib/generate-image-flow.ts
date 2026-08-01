"use client";

import type { ConvexReactClient } from "convex/react";
import type { BlockId } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  GENERATE_IMAGE_API_PATH,
  type GenerateImageErrorResponseBody,
  type GenerateImageResponseBody,
} from "@/app/api/generate-image/contract";
import { useEditorStore } from "@/lib/editor-store";
import { useImagePreviewStore, type GeneratedImagePayload } from "@/lib/image-preview-store";
import { getOrCreateSessionId } from "@/lib/session";

/**
 * The human-path generation flow (owner's perceived-latency design):
 *
 * 1. POST /api/generate-image → { base64, mimeType, alt }.
 * 2. INSTANT paint: the data URI goes into the ephemeral preview store; the
 *    canvas renders it immediately — before any Convex round-trip.
 * 3. BACKGROUND: upload the binary to Convex storage, resolve the https URL,
 *    PRE-DECODE it (so the swap is pixel-identical, no flicker), then dispatch
 *    exactly ONE updateBlockProperties op { src, alt } through the normal
 *    store spine, and clear the ephemeral preview.
 *
 * On failure NOTHING is committed — the preview flips to an error/retry state;
 * a post-generation failure keeps the generated payload so retry skips the
 * (billed) model call and re-runs only the upload.
 *
 * Plain module functions (not hooks): the flow must survive panel unmounts /
 * selection changes; all state lives in the two stores.
 */

function toDataUri(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** Browser-side base64 → bytes (the upload POSTs raw binary, never base64). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Resolve once the browser has the URL decoded — the no-flicker swap gate. */
function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new window.Image();
    // Resolve on error too: a failed preload should not block the commit —
    // the storage URL is already durable; worst case the swap repaints.
    image.onload = () => {
      void image
        .decode()
        .catch(() => undefined)
        .then(() => resolve());
    };
    image.onerror = () => resolve();
    image.src = url;
  });
}

export interface GenerateImageFlowInput {
  blockId: BlockId;
  prompt: string;
  convexClient: ConvexReactClient;
}

/** Step 1+2: call the model, paint the data-URI preview, then hand off to upload. */
export async function runGenerateImageFlow({
  blockId,
  prompt,
  convexClient,
}: GenerateImageFlowInput): Promise<void> {
  const previewStore = useImagePreviewStore.getState();
  previewStore.beginGenerating(blockId, prompt);

  let generated: GeneratedImagePayload;
  try {
    const response = await fetch(GENERATE_IMAGE_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const json = (await response.json()) as
      | GenerateImageResponseBody
      | GenerateImageErrorResponseBody;
    if (!response.ok || "error" in json) {
      const message =
        "error" in json && json.message.length > 0
          ? json.message
          : "The image couldn't be generated.";
      useImagePreviewStore.getState().markError(blockId, message);
      return;
    }
    generated = {
      base64: json.base64,
      mimeType: json.mimeType,
      alt: json.alt,
      dataUri: toDataUri(json.base64, json.mimeType),
    };
  } catch {
    useImagePreviewStore
      .getState()
      .markError(blockId, "The image service couldn't be reached — check your connection and retry.");
    return;
  }

  // INSTANT paint: the canvas shows the generated image right now, as a data
  // URI, while the durable bookkeeping happens behind the scenes.
  useImagePreviewStore.getState().showUploading(blockId, generated);
  await uploadAndCommitGeneratedImage({ blockId, generated, convexClient });
}

interface UploadAndCommitInput {
  blockId: BlockId;
  generated: GeneratedImagePayload;
  convexClient: ConvexReactClient;
}

/** Step 3: storage upload → preload → ONE property op → clear ephemeral state. */
async function uploadAndCommitGeneratedImage({
  blockId,
  generated,
  convexClient,
}: UploadAndCommitInput): Promise<void> {
  try {
    const postUrl = await convexClient.mutation(api.files.generateUploadUrl, {});
    const uploadResponse = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": generated.mimeType },
      body: new Blob([base64ToBytes(generated.base64).buffer as ArrayBuffer], {
        type: generated.mimeType,
      }),
    });
    if (!uploadResponse.ok) {
      throw new Error(`Upload failed with status ${uploadResponse.status}`);
    }
    const { storageId } = (await uploadResponse.json()) as { storageId: Id<"_storage"> };
    // Content Studio Stage S: EVERY successful generation joins the session's
    // library at upload, unconditionally (BINDING owner decision — even one
    // the user immediately regenerates past). Registration subsumes the
    // getFileUrl step and resolves the durable serving URL.
    const prompt = useImagePreviewStore.getState().previewsByBlockId[blockId]?.prompt;
    const { url: src } = await convexClient.mutation(api.assets.register, {
      sessionId: getOrCreateSessionId(),
      storageId,
      kind: "generated",
      alt: generated.alt,
      ...(prompt === undefined ? {} : { prompt }),
    });

    // Decode the durable URL BEFORE swapping so preview → committed src is
    // visually seamless (same pixels, already in the image cache).
    await preloadImage(src);

    const result = useEditorStore.getState().dispatch({
      name: "updateBlockProperties",
      blockId,
      properties: { src, alt: generated.alt },
    });
    if (!result.isOk) {
      // e.g. the block was deleted mid-flight — nothing to attach the image
      // to; drop the preview rather than showing an orphaned error.
      useImagePreviewStore.getState().clearPreview(blockId);
      return;
    }
    useImagePreviewStore.getState().clearPreview(blockId);
  } catch (error) {
    console.error("generate-image upload failed", error);
    useImagePreviewStore
      .getState()
      .markError(
        blockId,
        "The image was generated but couldn't be saved to storage — retry to upload it again.",
      );
  }
}

export interface RetryGenerateImageFlowInput {
  blockId: BlockId;
  convexClient: ConvexReactClient;
}

/**
 * Retry from the error state: re-upload the kept payload when generation
 * already succeeded (no second billed model call); otherwise regenerate from
 * the stored prompt.
 */
export async function retryGenerateImageFlow({
  blockId,
  convexClient,
}: RetryGenerateImageFlowInput): Promise<void> {
  const preview = useImagePreviewStore.getState().previewsByBlockId[blockId];
  if (preview === undefined || preview.status !== "error") {
    return;
  }
  if (preview.generated !== undefined) {
    useImagePreviewStore.getState().showUploading(blockId, preview.generated);
    await uploadAndCommitGeneratedImage({ blockId, generated: preview.generated, convexClient });
    return;
  }
  await runGenerateImageFlow({ blockId, prompt: preview.prompt, convexClient });
}
