"use client";

import { useRef, useState } from "react";
import { ImagesIcon, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { useUploadImageAsset } from "../library/use-upload-image-asset";

/**
 * The image block's `src` control — two buttons, no raw URL text field
 * (owner decision: the editable src input is gone; every source flows
 * through storage-backed paths, and arbitrary-URL entry lives in the Asset
 * Library's "From URL" import, which rehosts into Convex):
 *
 * - Upload: the shared upload path (library/use-upload-image-asset.ts —
 *   upload + assets.register in one hook), then → onCommitSrc(url). Blocks
 *   store the plain URL string — no Convex coupling in the SDK.
 *
 * - "From library": opens the asset library through the agent-parity
 *   ui-surfaces seam (requestUiSurfaceOpen("library") — the same path as
 *   the chat's openPanel command). Because this image block is the current
 *   selection, the library's insert flow is already in pick-for-this-block
 *   mode: its button reads "Insert into selected image" and dispatches ONE
 *   updateBlockProperties { src, alt } — the normal property spine, a
 *   single undo step.
 */

export interface ImageSourceFieldProps {
  helpText?: string;
  onCommitSrc: (src: string) => void;
}

export function ImageSourceField({ helpText, onCommitSrc }: ImageSourceFieldProps) {
  const { isUploading, uploadImageAsset } = useUploadImageAsset();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function uploadFile(file: File) {
    setUploadError(null);
    try {
      const { url } = await uploadImageAsset(file);
      onCommitSrc(url);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    }
  }

  return (
    <div className="space-y-1.5" data-slot="panel-field">
      <p title={helpText} className="text-xs text-muted-foreground">
        Source
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        id="image-upload-file-input"
        aria-label="Choose image file to upload"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Allow re-selecting the same file later.
          event.target.value = "";
          if (file !== undefined) {
            void uploadFile(file);
          }
        }}
      />
      <div className="flex gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-0 flex-1"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? <Loader2 className="animate-spin" /> : <Upload />}
          {isUploading ? "Uploading…" : "Upload image"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-0 flex-1"
          aria-label="Choose an image from your asset library"
          data-testid="image-source-from-library"
          onClick={() => requestUiSurfaceOpen("library")}
        >
          <ImagesIcon />
          From library
        </Button>
      </div>
      {uploadError !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}
