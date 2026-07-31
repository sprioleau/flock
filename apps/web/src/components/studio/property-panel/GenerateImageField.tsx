"use client";

import { useState } from "react";
import { useConvex } from "convex/react";
import { GENERATE_IMAGE_MAX_PROMPT_LENGTH, type BlockId } from "@tandem/email-sdk";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { retryGenerateImageFlow, runGenerateImageFlow } from "@/lib/generate-image-flow";
import { useImagePreviewStore } from "@/lib/image-preview-store";

/**
 * "Generate with AI" for the image panel: prompt in, image on the canvas.
 *
 * The button kicks off the perceived-latency flow (generate-image-flow.ts):
 * the canvas paints the generated image from a data URI the moment the model
 * responds, the binary uploads to Convex storage in the background, and one
 * updateBlockProperties op commits the durable URL + prompt-derived alt.
 * All flow state lives in the ephemeral preview store keyed by blockId, so
 * switching selection mid-generation loses nothing.
 */

export function GenerateImageField({ blockId }: { blockId: BlockId }) {
  const convexClient = useConvex();
  const [prompt, setPrompt] = useState("");
  const preview = useImagePreviewStore((state) => state.previewsByBlockId[blockId]);

  const isGenerating = preview?.status === "generating";
  const isUploading = preview?.status === "uploading";
  const isBusy = isGenerating || isUploading;
  const trimmedPrompt = prompt.trim();

  return (
    <div className="space-y-1.5" data-slot="panel-field">
      <Label
        htmlFor="generate-image-prompt-input"
        title="Generate an image from a text prompt. Alt text is derived from the prompt."
        className="text-xs text-muted-foreground"
      >
        Generate with AI
      </Label>
      <Textarea
        id="generate-image-prompt-input"
        value={prompt}
        placeholder="Describe the image to generate…"
        rows={2}
        maxLength={GENERATE_IMAGE_MAX_PROMPT_LENGTH}
        className="text-xs"
        aria-label="Image generation prompt"
        disabled={isBusy}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={isBusy || trimmedPrompt.length === 0}
        onClick={() => void runGenerateImageFlow({ blockId, prompt: trimmedPrompt, convexClient })}
      >
        {isBusy ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {isGenerating ? "Generating…" : isUploading ? "Saving…" : "Generate image"}
      </Button>
      {preview?.status === "error" ? (
        <div className="space-y-1.5">
          <p role="alert" className="text-xs text-destructive">
            {preview.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void retryGenerateImageFlow({ blockId, convexClient })}
          >
            <RotateCcw />
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
