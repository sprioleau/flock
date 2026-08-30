"use client";

import { ImageBlockView, type ImageBlock, type ResolvedImageStyles } from "@flock/email-sdk";
import { Loader2 } from "lucide-react";
import { useImagePreviewStore } from "@/lib/image-preview-store";

/*
  Canvas-only wrapper around the SDK's ImageBlockView: consults the ephemeral
  AI-preview store BEFORE the block's committed properties. While a preview
  exists the canvas renders the generated image from its data URI (instant —
  no Convex round-trip on the paint path) with a status overlay; once the
  background upload commits the storage URL, the preview clears and the plain
  SDK view takes over. The SDK view itself stays untouched — the HTML email
  renderer shares it and must never see ephemeral state.
*/

export interface ImageBlockCanvasSlotProps {
  block: ImageBlock;
  resolvedStyles: ResolvedImageStyles;
}

export function ImageBlockCanvasSlot({ block, resolvedStyles }: ImageBlockCanvasSlotProps) {
  const preview = useImagePreviewStore((state) => state.previewsByBlockId[block.id]);

  if (preview === undefined) {
    return <ImageBlockView block={block} resolvedStyles={resolvedStyles} />;
  }

  /*
    While generating there is no image yet — keep the current image visible
    under a shimmer. Once generated, the data URI replaces the src instantly.
  */
  const generated = preview.status === "generating" ? undefined : preview.generated;
  const displayBlock: ImageBlock =
    generated === undefined
      ? block
      : {
          ...block,
          properties: { ...block.properties, src: generated.dataUri, alt: generated.alt },
        };

  return (
    <div className="relative" data-image-preview-status={preview.status}>
      <ImageBlockView block={displayBlock} resolvedStyles={resolvedStyles} />
      {preview.status === "generating" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 animate-pulse">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="sr-only">Generating image…</span>
        </div>
      ) : null}
      {preview.status === "error" ? (
        <div className="absolute inset-x-0 bottom-0 bg-destructive/90 px-2 py-1 text-center text-xs text-white">
          Image generation failed — retry from the panel
        </div>
      ) : null}
    </div>
  );
}
