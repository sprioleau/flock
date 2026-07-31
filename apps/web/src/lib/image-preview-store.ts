"use client";

import type { BlockId } from "@tandem/email-sdk";
import { create } from "zustand";

/**
 * Ephemeral per-block AI image preview state — the perceived-latency seam.
 *
 * The generated base64 image is painted on the canvas AS A DATA URI the moment
 * the model responds (via ImageBlockCanvasSlot, which consults this store
 * before the block's committed properties.src); the binary uploads to Convex
 * storage in the background, and only the final https storage URL is ever
 * dispatched as an operation.
 *
 * HARD INVARIANT: this store is the ONLY place data URIs / base64 image data
 * may live. Nothing here is persisted, undoable, or sent to Convex — op rows
 * and snapshots must never carry image payloads (deliberately separate from
 * the document store, following the drag-gesture store pattern).
 */

/** The generated-but-not-yet-durable image, kept for instant paint and upload retry. */
export interface GeneratedImagePayload {
  base64: string;
  mimeType: string;
  /** Alt text derived from the prompt — committed alongside the storage URL. */
  alt: string;
  /** `data:<mimeType>;base64,<base64>` — the instant-preview src. */
  dataUri: string;
}

export type ImagePreview =
  | { status: "generating"; prompt: string }
  | { status: "uploading"; prompt: string; generated: GeneratedImagePayload }
  | {
      status: "error";
      prompt: string;
      message: string;
      /** Present when generation succeeded but the upload/commit failed — retry skips regeneration. */
      generated?: GeneratedImagePayload;
    };

interface ImagePreviewState {
  previewsByBlockId: Partial<Record<BlockId, ImagePreview>>;
  beginGenerating: (blockId: BlockId, prompt: string) => void;
  /** The instant-paint moment: the model responded; upload runs in the background. */
  showUploading: (blockId: BlockId, generated: GeneratedImagePayload) => void;
  markError: (blockId: BlockId, message: string) => void;
  clearPreview: (blockId: BlockId) => void;
}

export const useImagePreviewStore = create<ImagePreviewState>()((set) => ({
  previewsByBlockId: {},
  beginGenerating: (blockId, prompt) =>
    set((state) => ({
      previewsByBlockId: {
        ...state.previewsByBlockId,
        [blockId]: { status: "generating", prompt },
      },
    })),
  showUploading: (blockId, generated) =>
    set((state) => {
      const current = state.previewsByBlockId[blockId];
      const prompt = current?.prompt ?? "";
      return {
        previewsByBlockId: {
          ...state.previewsByBlockId,
          [blockId]: { status: "uploading", prompt, generated },
        },
      };
    }),
  markError: (blockId, message) =>
    set((state) => {
      const current = state.previewsByBlockId[blockId];
      const prompt = current?.prompt ?? "";
      const generated =
        current !== undefined && current.status !== "generating" ? current.generated : undefined;
      return {
        previewsByBlockId: {
          ...state.previewsByBlockId,
          [blockId]: {
            status: "error",
            prompt,
            message,
            ...(generated === undefined ? {} : { generated }),
          },
        },
      };
    }),
  clearPreview: (blockId) =>
    set((state) => {
      const nextPreviewsByBlockId = { ...state.previewsByBlockId };
      delete nextPreviewsByBlockId[blockId];
      return { previewsByBlockId: nextPreviewsByBlockId };
    }),
}));
